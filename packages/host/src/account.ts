import {join} from 'node:path';
import type {
  Identity,
  StoreHandle} from '@peers/core';
import {
  Keystore,
  Store,
  defaultDisplayName,
  generatePhrase,
  type KdfParams,
  type WordCount,
} from '@peers/core';
import type {PeersNode} from '@peers/node';
import type {CommandName, Commands, EventName, Events, IdentityInfoDto} from '@peers/api';
import {PeersHost} from './host.js';

/**
 * The account lifecycle around an unlocked {@link PeersHost}: phrase
 * generation, first-run identity creation (`initFromPhrase`), password
 * unlock, lock. Port of Rust's `AppState` keystore dance (lib.rs
 * `init_from_phrase`/`unlock`/`lock`).
 *
 * While locked, only the session commands answer — everything else
 * rejects with "locked", so a UI can drive login without special cases.
 * Event subscriptions made while locked are queued and attached at
 * unlock, so screens can subscribe before credentials exist.
 */
export class PeersAccount {
  private readonly keystore: Keystore;
  private readonly store: Store;
  private host_: PeersHost | null = null;
  private readonly queued: {event: EventName; cb: (payload: never) => void}[] = [];
  private offs: (() => void)[] = [];

  constructor(
    private readonly opts: {
      /** Config/state dir — everything lives inside it. */
      dataDir: string;
      /** KDF params; tests inject TEST_KDF to keep unlocks instant. */
      kdf?: KdfParams;
      listenAddrs?: string[];
      /** Always-on nodes (PEERS_NODES / nodes.json) dialed at unlock. */
      bootstrapAddrs?: string[];
      powerSource?: Parameters<typeof PeersNode.start>[0]['powerSource'];
      /** Test seam: build the node yourself instead of dialing the world. */
      nodeFactory?: (identity: Identity) => Promise<PeersNode>;
    },
  ) {
    this.keystore = new Keystore(join(opts.dataDir, 'keystore.json'), {kdf: opts.kdf});
    this.store = new Store(join(opts.dataDir, 'state.json'), {kdf: opts.kdf});
  }

  hasIdentity(): boolean {
    return this.keystore.exists();
  }

  isUnlocked(): boolean {
    return this.host_ !== null;
  }

  /** The live engine, or null while locked. */
  get host(): PeersHost | null {
    return this.host_;
  }

  async generatePhrase(wordCount?: number): Promise<string> {
    return generatePhrase((wordCount ?? 12) as WordCount);
  }

  /**
   * First run *or* recovery: derives the identity from `phrase`, seals the
   * keystore with it, unlocks, and starts networking. A phrase that
   * already has a keystore rebuilds the same identity — that is what makes
   * a lost install recoverable.
   */
  async initFromPhrase(phrase: string): Promise<IdentityInfoDto> {
    if (this.host_) throw new Error('already unlocked');
    await this.keystore.createFromPhrase(phrase);
    return this.unlockWith(phrase);
  }

  async unlock(password: string): Promise<IdentityInfoDto> {
    if (this.host_) throw new Error('already unlocked');
    return this.unlockWith(password);
  }

  /** Flushes sealed state to disk and stops the node. Idempotent. */
  async lock(): Promise<void> {
    const host = this.host_;
    if (!host) return;
    this.host_ = null;
    for (const off of this.offs.splice(0)) off();
    await host.stop();
  }

  async request<K extends CommandName>(cmd: K, args: Commands[K]['args']): Promise<Commands[K]['ret']> {
    const a = args as never;
    switch (cmd) {
      case 'has_identity':
        return this.hasIdentity();
      case 'is_unlocked':
        return this.isUnlocked();
      case 'generate_phrase':
        return this.generatePhrase((a as Commands['generate_phrase']['args']).wordCount);
      case 'init_from_phrase':
        return this.initFromPhrase((a as Commands['init_from_phrase']['args']).phrase);
      case 'unlock':
        return this.unlock((a as Commands['unlock']['args']).password);
      case 'lock':
        await this.lock();
        return null as Commands[K]['ret'];
      default: {
        if (!this.host_) throw new Error('locked — unlock first');
        return this.host_.request(cmd, args);
      }
    }
  }

  on<K extends EventName>(event: K, cb: (payload: Events[K]) => void): () => void {
    if (this.host_) return this.host_.on(event, cb);
    // Locked: queue until unlock, when the engine exists to attach to.
    const entry = {event, cb: cb as (payload: never) => void};
    this.queued.push(entry);
    return () => {
      const i = this.queued.indexOf(entry);
      if (i >= 0) this.queued.splice(i, 1);
    };
  }

  // ---------------------------------------------------------------------------

  private async unlockWith(password: string): Promise<IdentityInfoDto> {
    const identity = await this.keystore.load(password);
    const storage: StoreHandle = await this.store.open(password);
    const host = this.opts.nodeFactory
      ? PeersHost.startWithNode(identity, await this.opts.nodeFactory(identity))
      : await PeersHost.start({
          identity,
          listenAddrs: this.opts.listenAddrs,
          bootstrapAddrs: this.opts.bootstrapAddrs,
          powerSource: this.opts.powerSource,
        });
    await host.attachStorage(storage);
    this.host_ = host;
    for (const p of this.queued.splice(0)) {
      this.offs.push(host.on(p.event, p.cb as never));
    }
    return {
      peerId: identity.peerId,
      peerIdShort: identity.peerIdShort(),
      fingerprint: identity.fingerprint(),
      defaultName: defaultDisplayName(identity.peerIdBytes),
    };
  }
}
