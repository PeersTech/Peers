import {generateKeyPairFromSeed} from '@libp2p/crypto/keys';
import {gossipsub} from '@chainsafe/libp2p-gossipsub';
import {noise} from '@chainsafe/libp2p-noise';
import {yamux} from '@chainsafe/libp2p-yamux';
import {identify} from '@libp2p/identify';
import {tcp} from '@libp2p/tcp';
import {multiaddr} from '@multiformats/multiaddr';
import {createLibp2p, type Libp2p} from 'libp2p';
import type {Identify} from '@libp2p/identify';
import type {GossipsubEvents} from '@chainsafe/libp2p-gossipsub';
import type {PubSub} from '@libp2p/interface';
import type {Identity} from '@peers/core';

/** The concrete service map this node assembles. */
type PeersLibp2p = Libp2p<{
  identify: Identify;
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
 * A small interface (`start`/`subscribe`/`publish`/`onMessage`) hides the
 * whole libp2p assembly: transports, encryption, muxing, discovery,
 * gossipsub topics, and later DHT blobs / relay / hole punching. Callers
 * never touch a multiaddr unless they choose one.
 */
export class PeersNode {
  private constructor(
    private readonly libp2p: PeersLibp2p,
    private readonly handlers = new Set<(msg: IncomingMessage) => void>(),
    readonly relayRole: RelayRole = 'citizen',
  ) {}

  static async start(config: PeersNodeConfig): Promise<PeersNode> {
    // Deterministic identity: js-libp2p's peer id MUST equal @peers/core's
    // derivation — both are base58btc(identity-multihash(protobuf key)).
    const keypair = await generateKeyPairFromSeed('Ed25519', config.identity.edSeed);

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
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
        }),
      },
    });
    await node.start();

    const self = new PeersNode(node, undefined, config.relayRole ?? 'citizen');
    node.services.pubsub.addEventListener('message', (evt) => {
      // Signed-message mode: `from` is present on wire messages.
      const from = (evt.detail as {from?: {toString(): string}}).from;
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

  async stop(): Promise<void> {
    await this.libp2p.stop();
  }
}
