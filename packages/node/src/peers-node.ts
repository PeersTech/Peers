import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { ed25519 as nobleEd25519 } from '@noble/curves/ed25519.js';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { identify } from '@libp2p/identify';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { multiaddr } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';
import { createLibp2p, type Libp2p } from 'libp2p';
import type { Identify } from '@libp2p/identify';
import type { KadDHT } from '@libp2p/kad-dht';
import type { Ping } from '@libp2p/ping';
import type { GossipsubEvents } from '@chainsafe/libp2p-gossipsub';
import type { PeerId, PubSub } from '@libp2p/interface';
import type { CircuitRelayService } from '@libp2p/circuit-relay-v2';
import {
  FriendNotice,
  FRIEND_REQUEST_TOPIC_PREFIX,
  codeKey,
  decodeFriendNotice,
  encodeFriendNotice,
  friendRequestTopic,
  normalizeCode,
  shortCode,
  type Identity,
} from '@peers/core';
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
import { alwaysPluggedIn, type PowerSource } from './power.js';

/** The concrete service map this node assembles. */
type PeersLibp2p = Libp2p<{
  identify: Identify;
  ping: Ping;
  dht: KadDHT;
  pubsub: PubSub<GossipsubEvents>;
  relay?: CircuitRelayService;
}>;

/** How much relaying this node takes on (M12 capacity tiers).
 * `citizen` uses relays, serves none; `node` is a backbone hop;
 * `off` disables the relay transport entirely. */
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
  /** Battery/idle guard port. A constrained source downgrades a `node`
   * to `citizen` at start (a laptop must not drain relaying for others). */
  powerSource?: PowerSource;
}

export interface IncomingMessage {
  topic: string;
  from: string;
  data: Uint8Array;
}

/**
 * The Peers network node — THE deep module of this package.
 *
 * A small interface (`start`/`subscribe`/`publish`/`onMessage`, `parkBlob`/
 * `fetchBlob`, `publishCode`/`lookupCode`, `sendFriendRequest`/`acceptFriend`
 * + `onFriendNotice`) hides the whole libp2p assembly: transports,
 * encryption, muxing, discovery, gossipsub topics, Kademlia provider records
 * for blobs and friend codes, and the `/peers/blob/1.0.0` request-response
 * transfer. Callers never touch a multiaddr, a CID, or a stream unless they
 * choose to.
 *
 * Depth: two blob methods buy the whole park/provide → findProviders → dial
 * → framed fetch → hash-verify cycle; four code/handshake methods buy the
 * whole M8/M17 friend flow with signed, recipient-bound notices. Locality:
 * 64 KiB cap, CID wrapping, corruption checks, notice verification and
 * self-notice filtering live here, not in every caller.
 */
export class PeersNode {
  private readonly announced = new Set<string>();
  private readonly friendHandlers = new Set<(notice: FriendNotice) => void>();
  private constructor(
    private readonly libp2p: PeersLibp2p,
    private readonly identity: Identity,
    private readonly blobStore: BlobStore,
    private readonly handlers = new Set<(msg: IncomingMessage) => void>(),
    readonly relayRole: RelayRole = 'citizen',
  ) {}

  static async start(config: PeersNodeConfig): Promise<PeersNode> {
    // Build the libp2p private key protobuf directly (type=Ed25519,
    // data=seed||pub). @libp2p/crypto's own derivePublicKey routes through
    // Node's createPrivateKey with an OKP JWK, which Node 26 rejects.
    const seed = config.identity.edSeed;
    const pub = nobleEd25519.getPublicKey(seed);
    const protobuf = new Uint8Array(4 + 64);
    protobuf.set([0x08, 0x01, 0x12, 0x40], 0); // Type=Ed25519, Data=64B (seed||pub)
    protobuf.set(seed, 4);
    protobuf.set(pub, 36);
    const keypair = privateKeyFromProtobuf(protobuf);

    const blobStore = new BlobStore();

    // Battery/idle guard (M12): a constrained machine never becomes a
    // backbone hop, whatever its configured tier says.
    const power = config.powerSource ?? alwaysPluggedIn;
    let role: RelayRole = config.relayRole ?? 'citizen';
    if (role === 'node' && power.isPowerConstrained()) role = 'citizen';
    const relayServer = role === 'node';

    const node = await createLibp2p({
      privateKey: keypair,
      addresses: {
        listen: config.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0'],
      },
      // `off` strips the relay transport entirely; citizens keep the
      // client side so they can reserve slots on backbone nodes.
      transports: role === 'off' ? [tcp()] : [tcp(), circuitRelayTransport()],
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
        // Hole punching (M10): upgrades relayed connections to direct
        // ones by synchronized dials. Pointless without the relay transport.
        ...(role !== 'off' ? {dcutr: dcutr()} : {}),
        ...(relayServer
          ? {
              relay: circuitRelayServer({
                reservations: {
                  maxReservations: 128,
                  defaultDurationLimit: 2 * 60 * 60 * 1000,
                  defaultDataLimit: BigInt(4 * 1024 * 1024),
                },
              }),
            }
          : {}),
      },
    });
    await node.start();

    // Blob transfer handler — registered before any provider lookup can race it.
    await node.handle(BLOB_PROTOCOL, handleBlobProtocol(blobStore) as never);

    const self = new PeersNode(node, config.identity, blobStore, undefined, role);
    node.services.pubsub.addEventListener('message', (evt) => {
      const from = (evt.detail as { from?: { toString(): string } }).from;
      const msg = {
        topic: evt.detail.topic,
        from: from ? from.toString() : '',
        data: evt.detail.data,
      };
      // Friend notices get parsed, verified and dispatched as typed events
      // so hosts never re-parse gossip bytes (mirrors the dedicated
      // NodeEvent::FriendRequest in the Rust swarm loop).
      if (msg.topic.startsWith(FRIEND_REQUEST_TOPIC_PREFIX)) {
        self.dispatchFriendNotice(msg.data);
        return;
      }
      for (const handler of self.handlers) handler(msg);
    });

    // Our own friend topic is where requests and accepts addressed to us
    // arrive — subscribed for the lifetime of the node, like Rust's unlock.
    node.services.pubsub.subscribe(friendRequestTopic(self.peerId));

    // Dial + reserve on every known always-on node — in the background.
    // Blocking here delayed app startup by whole relay-handshakes; the
    // mesh heals itself, so callers get the node immediately.
    if ((config.bootstrapAddrs?.length ?? 0) > 0) {
      void Promise.allSettled(
        (config.bootstrapAddrs ?? []).map(async (addr) => {
          await node.dial(multiaddr(addr));
          // Reserve a circuit slot so NAT'd peers can dial US back through
          // this backbone node (Rust parity: Dial + ListenOnRelay).
          await self.reserveOnRelay(addr);
        }),
      ).catch(() => {
        /* Bootstrap failures are not fatal: the mesh heals itself. */
      });
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

  /** Raw listeners before advertisement filtering — wildcards kept with
   * their real ports (`0.0.0.0` never appears in `listenAddrs`). */
  async rawListenAddrs(): Promise<string[]> {
    const tm = (
      this.libp2p as unknown as {
        components: {transportManager: {getAddrs(): Promise<Multiaddr[]>}};
      }
    ).components.transportManager;
    return (await tm.getAddrs()).map((ma) => ma.toString());
  }

  /** Number of currently open connections (net_status peers). */
  get peerCount(): number {
    return this.libp2p.getConnections().length;
  }

  /** Distinct connected peers (online_peers). */
  remotePeers(): string[] {
    const seen = new Set<string>();
    for (const conn of this.libp2p.getConnections()) seen.add(conn.remotePeer.toString());
    return [...seen];
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

  /** Our short 12-digit friend code (lookup hint, not proof of identity). */
  get code(): string {
    return shortCode(this.identity.peerIdBytes);
  }

  /**
   * Announce ourselves as the provider of our own code's DHT key, so
   * anyone holding the code can resolve us — same provider machinery
   * blobs use; a code is just a well-known key that maps to whoever
   * claims it. Bounded like every provide here: isolated nodes simply
   * have no one to tell yet.
   */
  async publishCode(): Promise<void> {
    const cid = hashToCid(codeKey(this.code));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      for await (const evt of this.libp2p.services.dht.provide(cid, {
        signal: controller.signal,
      } as never)) {
        void evt;
      }
    } catch {
      // Abort or no routing table yet — re-advertised on the next call.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve a 12-digit code to candidate peer ids via DHT providers.
   * Bounded (1.5 s) and self-excluding. A resolved id is a *lead*, not
   * proof of identity — the user verifies name/fingerprint before accepting.
   */
  async lookupCode(code: string): Promise<string[]> {
    const normalized = normalizeCode(code);
    if (!normalized) throw new Error('a peer code is 12 digits, e.g. 4827 1193 6052');
    const cid = hashToCid(codeKey(normalized));
    const me = this.libp2p.peerId.toString();
    const found = new Set<string>();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      for await (const evt of this.libp2p.services.dht.findProviders(cid, {
        signal: controller.signal,
      } as never)) {
        const e = evt as { name?: string; providers?: { id: PeerId }[] };
        if (e.name === 'PROVIDER' && e.providers) {
          for (const p of e.providers) {
            const id = p.id.toString();
            if (id !== me) found.add(id);
          }
        }
      }
    } catch {
      // timeout/abort — return whatever surfaced before the deadline
    } finally {
      clearTimeout(timer);
    }
    return [...found];
  }

  /** Subscribe-free handle for verified incoming request/accept notices. */
  onFriendNotice(handler: (notice: FriendNotice) => void): () => void {
    this.friendHandlers.add(handler);
    return () => this.friendHandlers.delete(handler);
  }

  /** Ask `to` to be our friend: signed notice on their per-peer topic. */
  async sendFriendRequest(to: string, opts?: {profile?: FriendNotice['profile']}): Promise<void> {
    await this.sendFriendNotice('request', to, opts);
  }

  /** Answer a verified request: signed accept on the requester's topic. */
  async acceptFriend(to: string, opts?: {profile?: FriendNotice['profile']}): Promise<void> {
    await this.sendFriendNotice('accept', to, opts);
  }

  private async sendFriendNotice(
    kind: 'request' | 'accept',
    to: string,
    opts?: {profile?: FriendNotice['profile']},
  ): Promise<void> {
    if (to === this.peerId) throw new Error('cannot send a friend notice to yourself');
    // Gossipsub only routes topics we mesh on: subscribe to theirs first,
    // exactly like Rust's subscribe_with_relay before Publish.
    const topic = friendRequestTopic(to);
    this.subscribe(topic);
    await this.publish(topic, encodeFriendNotice(FriendNotice.sign(this.identity, kind, to, opts)));
  }

  private dispatchFriendNotice(data: Uint8Array): void {
    try {
      const notice = decodeFriendNotice(data);
      // Only notices actually addressed to us count; other subscribers of
      // this topic drop silently.
      if (notice.to !== this.peerId) return;
      FriendNotice.verify(notice);
      for (const handler of this.friendHandlers) handler(notice);
    } catch {
      // Invalid or foreign notice — treated as dropped, not fatal.
    }
  }

  /** Dial a peer by multiaddr (bootstrap, invites, code resolution). */
  async dial(addr: string): Promise<void> {
    await this.libp2p.dial(multiaddr(addr));
  }

  /**
   * Reserve a circuit slot on a relay node (M9): listen on
   * `<relay>/p2p-circuit` so we become reachable as
   * `<relay>/p2p-circuit/p2p/<us>` and NAT'd peers can dial us through it.
   * The relay address must include its `/p2p/<peer-id>` suffix.
   */
  async reserveOnRelay(relayAddr: string): Promise<void> {
    const base = multiaddr(relayAddr);
    if (!base.getPeerId()) throw new Error('relay address must include /p2p/<peer-id>');
    const circuit = base.encapsulate('/p2p-circuit');
    // Listening on a /p2p-circuit address is how the transport performs a
    // HOP reservation; the manager isn't on the public interface yet, so
    // reach it via the concrete components (same as libp2p's own tests).
    const tm = (this.libp2p as unknown as {
      components: {transportManager: {listen(addrs: Multiaddr[]): Promise<void>}};
    }).components.transportManager;
    await tm.listen([circuit]);
  }

  /** Active circuit reservations (net_status relayReservations). */
  get reservationCount(): number {
    return this.libp2p
      .getMultiaddrs()
      .filter((ma: Multiaddr) => ma.protoNames().includes('p2p-circuit')).length;
  }

  /** Remote addresses per peer — relayed addrs contain `/p2p-circuit`,
   * direct ones don't. Feeds hole-punch checks and net_status. */
  connections(): {peer: string; addr: string; limited: boolean}[] {
    return this.libp2p.getConnections().map((conn) => ({
      peer: conn.remotePeer.toString(),
      addr: conn.remoteAddr.toString(),
      limited: conn.limits != null,
    }));
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
