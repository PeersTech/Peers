import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p, type Libp2p } from 'libp2p';
import type { Identify } from '@libp2p/identify';
import type { KadDHT } from '@libp2p/kad-dht';
import type { Ping } from '@libp2p/ping';
import type { GossipsubEvents } from '@chainsafe/libp2p-gossipsub';
import type { PeerId, PubSub } from '@libp2p/interface';
import type { Identity } from '@peers/core';
import {
  BLOB_PROTOCOL,
  BlobStore,
  MAX_BLOB_SIZE,
  fetchFromPeer,
  fromHex,
  handleBlobProtocol,
  hashBytes,
  hashToCid,
  toHex,
} from './blobs.js';

/** The concrete service map this node assembles. */
type PeersLibp2p = Libp2p<{
  identify: Identify;
  ping: Ping;
  dht: KadDHT;
  pubsub: PubSub<GossipsubEvents>;
}>;

/** How much relaying this node takes on (M12 capacity tiers). */
export type RelayRole = 'citizen' | 'node' | 'off';

export interface PeersNodeConfig {
  /** Core identity — the same phrase-derived keys as everything else. */
  identity: Identity;
  /** Multiaddrs to listen on. Default: loopback with an ephemeral port. */
  listenAddrs?: string[];
  /** Always-on nodes dialed on start (`PEERS_NODES` equivalent). */
  bootstrapAddrs?: string[];
  /** Capacity tier. Default `citizen`. */
  relayRole?: RelayRole;
}

export interface IncomingMessage {
  topic: string;
  from: string;
  data: Uint8Array;
}

/**
 * The Peers network node — THE deep module of this package.
 *
 * A small interface (`start`/`subscribe`/`publish`/`onMessage` + `parkBlob`/
 * `fetchBlob`) hides the whole libp2p assembly: transports, encryption,
 * muxing, discovery, gossipsub topics, Kademlia provider records for blobs,
 * and the `/peers/blob/1.0.0` request-response transfer. Callers never touch
 * a multiaddr, a CID, or a stream unless they choose to.
 *
 * Depth: two blob methods buy the whole park/provide → findProviders → dial
 * → framed fetch → hash-verify cycle. Locality: 64 KiB cap, CID wrapping,
 * and corruption checks live here, not in every avatar/profile caller.
 */
export class PeersNode {
  private readonly announced = new Set<string>();
  private constructor(
    private readonly libp2p: PeersLibp2p,
    private readonly blobStore: BlobStore,
    private readonly handlers = new Set<(msg: IncomingMessage) => void>(),
    readonly relayRole: RelayRole = 'citizen',
  ) {}

  static async start(config: PeersNodeConfig): Promise<PeersNode> {
    const keypair = await generateKeyPairFromSeed('Ed25519', config.identity.edSeed);

    const blobStore = new BlobStore();

    const node = await createLibp2p({
      privateKey: keypair,
      addresses: {
        listen: config.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0'],
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        ping: ping(),
        dht: kadDHT({
          protocol: '/ipfs/kad/1.0.0',
          clientMode: false,
          peerInfoMapper: passthroughMapper,
        }),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
        }),
      },
    });
    await node.start();

    // Blob transfer handler — registered before any provider lookup can race it.
    await node.handle(BLOB_PROTOCOL, handleBlobProtocol(blobStore) as never);

    const self = new PeersNode(node, blobStore, undefined, config.relayRole ?? 'citizen');
    node.services.pubsub.addEventListener('message', (evt) => {
      const from = (evt.detail as { from?: { toString(): string } }).from;
      for (const handler of self.handlers) {
        handler({
          topic: evt.detail.topic,
          from: from ? from.toString() : '',
          data: evt.detail.data,
        });
      }
    });

    for (const addr of config.bootstrapAddrs ?? []) {
      try {
        await node.dial(multiaddr(addr));
      } catch {
        // Bootstrap failures are not fatal: the mesh heals itself.
      }
    }

    return self;
  }

  /** Our stable identifier on the network. */
  get peerId(): string {
    return this.libp2p.peerId.toString();
  }

  /** Addresses other peers can dial us on. */
  get listenAddrs(): string[] {
    return this.libp2p.getMultiaddrs().map((ma) => ma.toString());
  }

  /** Number of currently open connections (net_status peers). */
  get peerCount(): number {
    return this.libp2p.getConnections().length;
  }

  subscribe(topic: string): void {
    this.libp2p.services.pubsub.subscribe(topic);
  }

  unsubscribe(topic: string): void {
    this.libp2p.services.pubsub.unsubscribe(topic);
  }

  async publish(topic: string, data: Uint8Array): Promise<void> {
    await this.libp2p.services.pubsub.publish(topic, data);
  }

  onMessage(handler: (msg: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Dial a peer by multiaddr (bootstrap, invites, code resolution). */
  async dial(addr: string): Promise<void> {
    await this.libp2p.dial(multiaddr(addr));
  }

  /**
   * Park a blob locally and advertise it on the DHT. The DHT `provide` is
   * fire-and-forget from the caller's view — the returned hash is usable
   * immediately for local `fetchBlob`, and the provider record propagates
   * in the background to the k closest peers.
   *
   * Throws if `data` exceeds `MAX_BLOB_SIZE`.
   */
  async parkBlob(data: Uint8Array): Promise<string> {
    if (data.length > MAX_BLOB_SIZE) throw new Error(`blob too large: ${data.length} > ${MAX_BLOB_SIZE}`);
    const hash = hashBytes(data);
    this.blobStore.put(data);
    const hex = toHex(hash);
    if (this.announced.has(hex)) return hex;
    this.announced.add(hex);
    const cid = hashToCid(hash);
    // Best-effort DHT advertisement — isolated nodes have no one to tell,
    // and a full `provide` walk can outlive the caller's patience. Bound it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      for await (const evt of this.libp2p.services.dht.provide(cid, {
        signal: controller.signal,
      } as never)) {
        void evt;
      }
    } catch {
      // Abort or network hiccup — local store already has the blob, so the
      // caller can still fetch it directly; the provider record will be
      // re-advertised on the next park or via the reprovider.
    } finally {
      clearTimeout(timer);
    }
    return hex;
  }

  /**
   * Fetch a blob by its hex hash. Checks the local store first, then asks
   * the DHT for providers and dials them over `/peers/blob/1.0.0` until one
   * returns bytes whose SHA-256 matches the requested hash (hash mismatch =
   * corrupt/tampered, rejected).
   *
   * Depth win: avatar/profile callers learn two methods, not CID math,
   * provider iteration, stream framing, or verification.
   */
  async fetchBlob(hashHex: string): Promise<Uint8Array> {
    const hash = fromHex(hashHex);
    if (!hash) throw new Error('invalid blob hash');
    const local = this.blobStore.get(hash);
    if (local) return local;

    const cid = hashToCid(hash);
    const providers: PeerId[] = [];
    {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        for await (const evt of this.libp2p.services.dht.findProviders(cid, {
          signal: controller.signal,
        } as never)) {
          const e = evt as { name?: string; providers?: { id: PeerId }[] };
          if (e.name === 'PROVIDER' && e.providers) {
            for (const p of e.providers) providers.push(p.id);
          }
        }
      } catch {
        // timeout or abort — fall through to direct-connection fallback below
      } finally {
        clearTimeout(timer);
      }
    }

    // Also consider peers we are directly connected to that might have the
    // blob but haven't yet surfaced via DHT (handy in loopback tests where
    // the DHT routing table is still cold). Deduplicate.
    const seen = new Set(providers.map((p) => p.toString()));
    for (const conn of this.libp2p.getConnections()) {
      const id = conn.remotePeer;
      if (!seen.has(id.toString())) providers.push(id);
    }

    if (providers.length === 0) throw new Error('no providers found');

    let lastErr: unknown = null;
    for (const peer of providers) {
      if (peer.toString() === this.libp2p.peerId.toString()) continue;
      try {
        const data = await fetchFromPeer(this.libp2p.dialProtocol.bind(this.libp2p), peer, hash);
        if (!data) continue;
        // Verify — hash mismatch means corrupt/tampered (mirrors Rust's check).
        const got = hashBytes(data);
        if (toHex(got) !== hashHex) throw new Error('hash mismatch (corrupt or tampered)');
        this.blobStore.putWithHash(hash, data);
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('blob fetch failed');
  }

  async stop(): Promise<void> {
    try {
      await this.libp2p.unhandle(BLOB_PROTOCOL);
    } catch {}
    await this.libp2p.stop();
  }
}

export { MAX_BLOB_SIZE, BLOB_PROTOCOL } from './blobs.js';
