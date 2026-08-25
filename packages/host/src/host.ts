import type {
  StoreHandle} from '@peers/core';
import {
  JoinNotice,
  PeerCard,
  PlazaMessage,
  PLAZA_TOPIC,
  ProfileNotice,
  ServerDir,
  ServerRecord,
  SessionDir,
  SignedMessage,
  SignedProfile,
  Snapshot,
  channelTopic,
  formatCode,
  newServerId,
  normalizeCode,
  serverTopic,
  shortCode,
  utf8,
  type FriendNotice,
  type Identity,
  PersistedState,
  type PlazaMessageShape,
} from '@peers/core';
import {PeersNode, type IncomingMessage} from '@peers/node';
import type {
  CommandName,
  Commands,
  DmMessageDto,
  EventName,
  Events,
  MemberDto,
  NetStatusDto,
  PeerCardDto,
  PlazaMessageDto,
  ServerViewDto,
  SignedMessageDto,
  SignedProfileDto,
} from '@peers/api';

/** How many recent Plaza messages we keep (Rust: PLAZA_HISTORY_LIMIT). */
const PLAZA_HISTORY_LIMIT = 200;
/** How long a participant counts as "here" after their last message. */
const PLAZA_PRESENCE_WINDOW_SECS = 600;

/**
 * The Peers host engine: ONE implementation of the {@link Commands}/
 * {@link Events} seam from @peers/api, composed from the core domain
 * (identity, sessions, servers) and the network node.
 *
 * Depth: hosts stay thin transports. The whole app — friend handshakes
 * becoming DM keys, sealed envelopes on DM topics, signed member lists on
 * server topics, join flow authorized by invite nonces, profiles riding
 * lists — is this one class. Locality: every verification and wire-format
 * decision lives here once; the three hosts never re-implement it.
 */
export class PeersHost {
  private readonly listeners = new Map<EventName, Set<(payload: never) => void>>();
  /** Outstanding invite nonces per owned server (join authorization). */
  private readonly openInvites = new Map<string, Set<string>>();
  private readonly dmHistory = new Map<string, DmMessageDto[]>();
  private readonly serverHistory = new Map<string, Map<string, SignedMessage[]>>();
  private readonly contactProfiles = new Map<string, SignedProfileDto>();
  /** Recent verified Plaza messages, oldest first (deduped by sig). */
  private readonly plaza: PlazaMessageDto[] = [];
  /** Last-seen ts per Plaza participant (presence). */
  private readonly plazaSeen = new Map<string, number>();
  private profile: SignedProfile | null = null;
  /** Sealed at-rest storage; null = ephemeral host (tests). */
  private storage: StoreHandle | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly identity: Identity,
    private readonly node: PeersNode,
    private sessions = new SessionDir(identity),
    private servers = new ServerDir(),
  ) {}

  static async start(opts: {
    identity: Identity;
    listenAddrs?: string[];
    /** Battery/idle guard handed to the underlying node (desktop hosts). */
    powerSource?: Parameters<typeof PeersNode.start>[0]['powerSource'];
    nodeFactory?: (identity: Identity) => Promise<PeersNode>;
  }): Promise<PeersHost> {
    const make = opts.nodeFactory ?? ((id: Identity) => PeersNode.start({identity: id, listenAddrs: opts.listenAddrs, powerSource: opts.powerSource}));
    const node = await make(opts.identity);
    return PeersHost.startWithNode(opts.identity, node);
  }

  /** Composes onto an existing node (tests, custom assemblies). Takes over
   * its message dispatch for app-level traffic. */
  static startWithNode(identity: Identity, node: PeersNode): PeersHost {
    const host = new PeersHost(identity, node);
    // Receive DMs addressed to us: our peer id IS our DM topic (Rust parity).
    node.subscribe(`peers/v1/ch/${node.peerId}`);
    // Auto-join the global Plaza — no invites, can't leave (M15).
    node.subscribe(PLAZA_TOPIC);
    node.onMessage((msg) => host.onWireMessage(msg));
    node.onFriendNotice((n) => host.onFriendNotice(n));
    return host;
  }

  /**
   * Attaches sealed at-rest storage and restores whatever survived the
   * last run: E2E sessions, contacts, servers, histories, profile. Called
   * right after construction, before any traffic flows.
   */
  async attachStorage(handle: StoreHandle): Promise<void> {
    this.storage = handle;
    const state = await handle.load();
    if (state.sessions.length > 0 || state.contacts.length > 0) {
      this.sessions = SessionDir.restore(
        {sessions: state.sessions, contacts: state.contacts},
        this.identity,
      );
    }
    for (const raw of state.servers as ReturnType<ServerRecord['toPersisted']>[]) {
      try {
        this.servers.restore(ServerRecord.fromPersisted(raw));
      } catch {
        continue; // a corrupt record must not take the rest down
      }
    }
    for (const [key, msgs] of state.history.server) {
      const slash = key.indexOf('/');
      if (slash === -1) continue;
      const map = historyFor(this.serverHistory, key.slice(0, slash));
      map.set(key.slice(slash + 1), msgs);
    }
    for (const [peer, msgs] of state.history.dm) this.dmHistory.set(peer, msgs);
    if (state.profile) {
      this.profile = state.profile;
      void this.announcePlazaProfile().catch(() => {});
    }
    // Rejoin everything we were part of.
    for (const rec of this.servers.records()) {
      this.node.subscribe(serverTopic(rec.id));
      for (const c of rec.channels) this.node.subscribe(channelTopic(rec.id, c.name));
    }
  }

  /** Collects everything worth surviving a restart. */
  private collectState(): PersistedState {
    const state = new PersistedState();
    const dir = this.sessions.export();
    state.sessions = dir.sessions;
    state.contacts = dir.contacts;
    state.servers = this.servers.records().map((r) => r.toPersisted());
    for (const [serverId, channels] of this.serverHistory) {
      for (const [channel, msgs] of channels) state.history.server.set(`${serverId}/${channel}`, msgs);
    }
    for (const [peer, msgs] of this.dmHistory) state.history.dm.set(peer, msgs);
    state.profile = this.profile;
    return state;
  }

  /** Debounced best-effort save — mutations call `touch()`, never await. */
  private touch(): void {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.storage!.save(this.collectState()).catch(() => {});
    }, 300);
  }

  /** Flushes pending state now (lock/shutdown path). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.storage) return;
    await this.storage.save(this.collectState()).catch(() => {});
  }

  get peerId(): string {
    return this.node.peerId;
  }

  /** Addresses other peers can dial us on (invites embed these). */
  get listenAddrs(): string[] {
    return this.node.listenAddrs;
  }

  /** Dial a peer by multiaddr (bootstrap, invites). */
  async dial(addr: string): Promise<void> {
    await this.node.dial(addr);
  }

  stop(): Promise<void> {
    return this.flush().finally(() => this.node.stop());
  }

  // -------------------------------------------------------------------------
  // Command surface (@peers/api)

  async request<K extends CommandName>(cmd: K, args: Commands[K]['args']): Promise<Commands[K]['ret']> {
    const handler = this.handlers[cmd] as (args: Commands[K]['args']) => Promise<Commands[K]['ret']>;
    return handler(args);
  }

  /**
   * One typed entry per command. The mapped table makes every arrow
   * function see its exact args/ret pair — no casts inside the bodies.
   */
  private readonly handlers: {
    [K in CommandName]: (args: Commands[K]['args']) => Promise<Commands[K]['ret']>;
  } = {
    // -- identity / session -------------------------------------------------
    has_identity: async () => true,
    is_unlocked: async () => true,
    generate_phrase: async () => {
      throw new Error('phrase generation belongs to the keystore host shell');
    },
    init_from_phrase: async () => {
      throw new Error('unlock flow belongs to the keystore host shell');
    },
    unlock: async () => {
      throw new Error('unlock flow belongs to the keystore host shell');
    },
    lock: async () => null,

    // -- friend codes (M8/M17) ----------------------------------------------
    my_code: async () => {
      const code = shortCode(this.identity.peerIdBytes);
      return {code, formatted: formatCode(code)};
    },
    lookup_code: async (a) => {
      const ids = await this.node.lookupCode(a.code);
      const peerId = ids[0] ?? null;
      this.emit('code://resolved', {code: normalizeCode(a.code) ?? a.code, peerId});
      if (!peerId) throw new Error('nobody is providing that code');
      return peerId;
    },
    add_contact: async (a) => {
      // Their DM topic is their peer id; subscribing receives their mail.
      this.node.subscribe(dmTopic(a.peerId));
      return null;
    },
    send_friend_request: async (a) => {
      await this.node.sendFriendRequest(a.peerId, {profile: this.profile});
      this.node.subscribe(dmTopic(a.peerId));
      return null;
    },
    accept_friend: async (a) => {
      await this.node.acceptFriend(a.peerId, {profile: this.profile});
      this.node.subscribe(dmTopic(a.peerId));
      return null;
    },

    // -- network status -------------------------------------------------------
    net_status: async () => this.netStatus(),
    online_peers: async () => this.node.remotePeers(),

    // -- legacy raw topics (DMs pre-date servers) ------------------------------
    subscribe: async (a) => {
      this.node.subscribe(dmTopic(a.channel));
      return null;
    },
    unsubscribe: async (a) => {
      this.node.unsubscribe(dmTopic(a.channel));
      return null;
    },
    publish: async (a) => {
      await this.sendDmOrRaw(a.channel, a.text);
      return null;
    },

    // -- servers ----------------------------------------------------------------
    create_server: async (a) => {
      const rec = this.servers.create(newServerId(), a.name, this.peerId, PeerCard.sign(this.identity));
      this.openInvites.set(rec.id, new Set());
      this.node.subscribe(serverTopic(rec.id));
      this.node.subscribe(channelTopic(rec.id, 'general'));
      await this.publishList(rec);
      return this.viewOf(rec);
    },
    list_servers: async () => this.servers.views(this.peerId).map((v) => this.dtoView(v)),
    create_invite: async (a) => {
      const rec = this.owned(a.serverId);
      const invite = rec.invite();
      invite.addrs = this.node.listenAddrs;
      nonceSet(this.openInvites, rec.id).add(nonceKey(invite.payload.nonce));
      return jsonStr(invite);
    },
    join_server: async (a) => {
      const invite = JSON.parse(a.inviteJson) as Parameters<ServerDir['join']>[0];
      const rec = this.servers.join(invite); // verifies signature
      for (const addr of invite.addrs ?? []) {
        try {
          await this.node.dial(addr);
        } catch {
          // Routing metadata only — mesh via shared nodes instead.
        }
      }
      this.node.subscribe(serverTopic(rec.id));
      const notice = JoinNotice.new(
        rec.id,
        this.peerId,
        a.name,
        invite.payload.nonce,
        PeerCard.sign(this.identity),
        this.profile,
      );
      // Gossip needs a beat to mesh a fresh topic; re-announce until the
      // owner's signed list admits us (or give up and stay `pending`).
      const admitted = (): boolean => rec.members.some((m) => m.peerId === this.peerId);
      for (let i = 0; i < 20 && !admitted(); i++) {
        try {
          await this.publishJson(serverTopic(rec.id), notice);
        } catch {
          /* isolated node — keep trying until deadline */
        }
        await sleep(300);
      }
      return this.viewOf(rec);
    },
    leave_server: async (a) => {
      const rec = this.servers.get(a.serverId);
      if (rec) {
        this.node.unsubscribe(serverTopic(rec.id));
        for (const c of rec.channels) this.node.unsubscribe(channelTopic(rec.id, c.name));
      }
      this.servers.remove(a.serverId);
      this.serverHistory.delete(a.serverId);
      this.openInvites.delete(a.serverId);
      this.touch();
      return null;
    },
    add_member: async (a) => {
      const rec = this.owned(a.serverId);
      if (rec.members.some((m) => m.peerId === a.peerId)) throw new Error('already a member');
      rec.members.push({
        peerId: a.peerId,
        name: a.name,
        role: a.role,
        joinedEpoch: rec.keys?.epoch ?? 0,
        card: a.card ? dtoToCard(a.card) : null,
        profile: null,
      });
      await this.publishList(rec);
      return this.viewOf(rec);
    },
    remove_member: async (a) => {
      const rec = this.owned(a.serverId);
      rec.members = rec.members.filter((m) => m.peerId !== a.peerId);
      await this.publishList(rec);
      return this.viewOf(rec);
    },
    set_role: async (a) => {
      const rec = this.owned(a.serverId);
      const m = rec.members.find((x) => x.peerId === a.peerId);
      if (!m) throw new Error('not a member');
      m.role = a.role;
      await this.publishList(rec);
      return this.viewOf(rec);
    },
    rotate_key: async (a) => {
      const rec = this.owned(a.serverId);
      rec.keys?.rotate();
      await this.publishList(rec); // list(E+1) is signed by key(E)
      return this.viewOf(rec);
    },
    set_channel: async (a) => {
      const rec = this.owned(a.serverId);
      const cfg = rec.channels.find((c) => c.name === a.name);
      if (cfg) {
        cfg.topic = a.topic;
        cfg.readMin = a.readMin;
        cfg.writeMin = a.writeMin;
      } else {
        rec.channels.push({name: a.name, topic: a.topic, readMin: a.readMin, writeMin: a.writeMin});
        this.node.subscribe(channelTopic(rec.id, a.name));
      }
      await this.publishList(rec);
      return this.viewOf(rec);
    },
    rename_server: async (a) => {
      const rec = this.owned(a.serverId);
      rec.name = a.name;
      await this.publishList(rec);
      return this.viewOf(rec);
    },
    subscribe_channel: async (a) => {
      this.node.subscribe(channelTopic(a.serverId, a.channel));
      return null;
    },
    unsubscribe_channel: async (a) => {
      this.node.unsubscribe(channelTopic(a.serverId, a.channel));
      return null;
    },
    publish_channel: async (a) => {
      const rec = this.servers.get(a.serverId);
      if (!rec) throw new Error('unknown server');
      if (!rec.canWrite(this.peerId, a.channel)) throw new Error('not allowed to write there');
      const msg = SignedMessage.sign(this.identity, a.serverId, a.channel, a.text);
      this.node.subscribe(channelTopic(a.serverId, a.channel));
      await this.node.publish(channelTopic(a.serverId, a.channel), utf8(JSON.stringify(msg)));
      this.pushServerHistory(msg);
      return null;
    },
    server_history: async (a) =>
      (this.serverHistory.get(a.serverId)?.get(a.channel) ?? []).map(msgToDto),
    dm_history: async (a) => [...(this.dmHistory.get(a.peer) ?? [])],
    export_snapshot: async (a) => {
      const rec = this.owned(a.serverId);
      const messages = [...(this.serverHistory.get(rec.id)?.values() ?? [])].flat();
      return jsonStr(Snapshot.sign(rec, messages));
    },
    import_snapshot: async (a) => {
      const rec = this.servers.get(a.serverId);
      if (!rec) throw new Error('unknown server');
      const snap = JSON.parse(a.snapshotJson) as Parameters<typeof Snapshot.verify>[0];
      Snapshot.verify(snap, rec);
      const map = historyFor(this.serverHistory, rec.id);
      let n = 0;
      for (const m of snap.messages) {
        try {
          SignedMessage.verify(m, rec);
        } catch {
          continue; // skip unverifiable entries rather than reject the batch
        }
        const arr = map.get(m.channel) ?? [];
        if (!arr.some((x) => x.sig === m.sig && x.ts === m.ts)) {
          arr.push(m);
          map.set(m.channel, arr);
          n++;
        }
      }
      this.touch();
      return n;
    },

    // -- profiles (M14) ----------------------------------------------------------
    set_profile: async (a) => {
      const p = SignedProfile.sign(this.identity, a.displayName, a.about, a.avatarHash);
      this.profile = p;
      for (const rec of this.servers.records()) {
        await this.publishJson(serverTopic(rec.id), ProfileNotice.new(rec.id, this.peerId, p));
      }
      // Let the Plaza learn the new name/avatar (Rust: announce_plaza_profile).
      await this.announcePlazaProfile().catch(() => {});
      this.touch();
      return {...p};
    },
    get_profile: async () => (this.profile ? {...this.profile} : null),
    contact_profiles: async () => Object.fromEntries(this.contactProfiles),

    // -- blobs (DHT parking) --------------------------------------------------------
    park_blob: async (a) => this.node.parkBlob(Uint8Array.from(a.data)),
    fetch_blob: async (a) => {
      await this.node.fetchBlob(a.hash);
      return null;
    },

    // -- plaza (M15) ------------------------------------------------------------
    publish_plaza: async (a) => {
      const text = a.text.trim();
      if (text.length === 0) return null;
      const msg = PlazaMessage.sign(this.identity, PlazaMessage.KIND_CHAT, text, {
        card: PeerCard.sign(this.identity),
      });
      await this.publishJson(PLAZA_TOPIC, msg);
      this.pushPlaza(plazaToDto(msg));
      return null;
    },
    plaza_history: async () => [...this.plaza],
    plaza_who: async () => {
      const now = Math.floor(Date.now() / 1000);
      return [...this.plazaSeen]
        .filter(([, ts]) => now - ts < PLAZA_PRESENCE_WINDOW_SECS)
        .map(([peerId, lastTs]) => ({peerId, lastTs}));
    },
  };

  on<K extends EventName>(event: K, cb: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as (payload: never) => void);
    return () => set!.delete(cb as (payload: never) => void);
  }

  // -------------------------------------------------------------------------
  // Wire dispatch

  private onWireMessage(msg: IncomingMessage): void {
    try {
      if (msg.topic === PLAZA_TOPIC) return this.onPlazaMessage(msg);
      if (msg.topic.startsWith('peers/v1/ch/')) {
        const rest = msg.topic.slice('peers/v1/ch/'.length);
        const slash = rest.indexOf('/');
        if (slash === -1) return this.onDmTopic(rest, msg);
        return this.onChannelTopic(rest.slice(0, slash), rest.slice(slash + 1), msg);
      }
      if (msg.topic.startsWith('peers/v1/srv/')) {
        return this.onServerTopic(msg.topic.slice('peers/v1/srv/'.length), msg);
      }
    } catch {
      // A malformed wire message must never crash the engine.
    }
  }

  /** Self-signed Plaza traffic (M15): chat and profile announcements. */
  private onPlazaMessage(msg: IncomingMessage): void {
    let parsed: PlazaMessageDto & {card?: unknown};
    try {
      parsed = JSON.parse(new TextDecoder().decode(msg.data));
      const coreMsg: Parameters<typeof PlazaMessage.verify>[0] = {
        ...parsed,
        card: null,
      } as never;
      // The riding card is verified separately (byte arrays over JSON).
      const card = hydrateCard(parsed.card) ?? undefined;
      if (card) {
        if (!PeerCard.verify(card)) return;
        coreMsg.card = card;
      }
      PlazaMessage.verify(coreMsg);
    } catch {
      return; // unsigned/tampered — the Plaza trusts only valid signatures
    }
    if (this.plaza.some((m) => m.sig === parsed.sig)) return; // dedup
    this.pushPlaza(parsed);
    this.plazaSeen.set(parsed.from, parsed.ts);

    if (parsed.profile) {
      try {
        SignedProfile.verify(parsed.profile as SignedProfile);
        this.contactProfiles.set(parsed.from, {...(parsed.profile as SignedProfile)});
      } catch {
        parsed.profile = undefined;
      }
    }
    this.emit('plaza://message', {from: parsed.from, text: parsed.text, ts: parsed.ts, profile: parsed.profile ?? null});
    if (parsed.profile) {
      this.emit('plaza://profile', {peerId: parsed.from, profile: {...(parsed.profile as SignedProfile)}});
    }
  }

  private pushPlaza(msg: PlazaMessageDto): void {
    this.plaza.push(msg);
    if (this.plaza.length > PLAZA_HISTORY_LIMIT) {
      this.plaza.splice(0, this.plaza.length - PLAZA_HISTORY_LIMIT);
    }
  }

  /** Best-effort "who I am" announcement so the Plaza learns our profile. */
  private async announcePlazaProfile(): Promise<void> {
    if (!this.profile) return;
    await this.publishJson(
      PLAZA_TOPIC,
      PlazaMessage.sign(this.identity, PlazaMessage.KIND_PROFILE, '', {
        profile: this.profile,
        card: PeerCard.sign(this.identity),
      }),
    );
  }

  /** Sealed envelope on a DM topic addressed to us. */
  private onDmTopic(peer: string, msg: IncomingMessage): void {
    if (peer !== this.peerId) return; // only our own topic carries our mail
    let text: string;
    let from: string;
    try {
      const plain = this.sessions.open(utf8(msg.topic), msg.data);
      text = new TextDecoder().decode(plain);
      from = envelopeSenderId(msg.data);
    } catch {
      return; // replay / not addressed to us / garbage — dropped
    }
    const dto: DmMessageDto = {peer: from, text, ts: Date.now(), mine: false};
    this.dmHistory.set(from, [...(this.dmHistory.get(from) ?? []), dto]);
    this.touch();
    this.emit('node://message', {from, channel: from, text});
  }

  /** Signed broadcast on a server channel topic. */
  private onChannelTopic(serverId: string, channel: string, msg: IncomingMessage): void {
    const rec = this.servers.get(serverId);
    if (!rec) return;
    let parsed: SignedMessage;
    try {
      parsed = JSON.parse(new TextDecoder().decode(msg.data)) as SignedMessage;
      SignedMessage.verify(parsed, rec);
      if (parsed.channel !== channel || parsed.serverId !== serverId) return;
    } catch {
      return;
    }
    this.pushServerHistory(parsed);
    this.emit('server://message', {serverId, channel, from: parsed.from, text: parsed.text, ts: parsed.ts});
  }

  /** Control traffic on a server topic: signed lists, join/profile notices. */
  private onServerTopic(serverId: string, msg: IncomingMessage): void {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(msg.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if ('payload' in body) return void this.onSignedList(hydrateList(body as never));
    switch (body.kind) {
      case JoinNotice.KIND:
        return void this.onJoinNotice(serverId, hydrateJoin(body as never));
      case ProfileNotice.KIND:
        return void this.onProfileNotice(serverId, hydrateProfileNotice(body as never));
      default:
        return;
    }
  }

  private onSignedList(list: Parameters<ServerRecord['verifyList']>[0]): void {
    const rec = this.servers.get(list.payload?.serverId ?? '');
    if (!rec) return;
    try {
      rec.verifyList(list);
    } catch {
      return; // wrong epoch / bad sig — keep what we had
    }
    // Cards riding the list double as the DM key exchange (M14).
    for (const m of rec.members) {
      if (m.card && PeerCard.verify(m.card) && PeerCard.peerIdOf(m.card) === m.peerId) {
        this.sessions.rememberContact(m.peerId, m.card);
      }
      if (m.profile) {
        try {
          SignedProfile.verify(m.profile);
          this.contactProfiles.set(m.profile.peerId, {...m.profile});
        } catch {
          /* ignore bad profile */
        }
      }
    }
    this.touch(); // riding cards became contact keys — keep them sealed
    this.emit('server://list', this.dtoView(rec.view(this.peerId)));
  }

  private async onJoinNotice(serverId: string, notice: JoinNotice): Promise<void> {
    const rec = this.servers.get(serverId);
    if (!rec || !rec.keys) return; // only the owner admits members
    if (notice.serverId !== serverId || notice.peerId === this.peerId) return;
    if (!PeerCard.verify(notice.card) || PeerCard.peerIdOf(notice.card) !== notice.peerId) return;
    const nonces = this.openInvites.get(serverId);
    if (!nonces || !nonces.delete(nonceKey(notice.nonce ?? []))) return; // unknown/used nonce
    if (notice.profile) {
      try {
        SignedProfile.verify(notice.profile);
      } catch {
        notice.profile = null;
      }
    }
    rec.members.push({
      peerId: notice.peerId,
      name: notice.name,
      role: 'member',
      joinedEpoch: rec.keys.epoch,
      card: notice.card,
      profile: notice.profile ?? null,
    });
    try {
      await this.publishList(rec);
    } catch {
      /* list publication races shutdown — nothing to do */
    }
  }

  private async onProfileNotice(serverId: string, notice: ProfileNotice): Promise<void> {
    const rec = this.servers.get(serverId);
    if (!rec || notice.serverId !== serverId) return;
    try {
      SignedProfile.verify(notice.profile);
    } catch {
      return;
    }
    if (notice.profile.peerId !== notice.peerId) return;
    this.contactProfiles.set(notice.peerId, {...notice.profile});
    const m = rec.members.find((x) => x.peerId === notice.peerId);
    if (m) m.profile = notice.profile;
    // Owner folds the change into the next signed list so late joiners
    // inherit it; plain members just cache it locally.
    if (rec.keys) {
      try {
        await this.publishList(rec);
      } catch {
        /* shutdown race */
      }
    }
  }

  /** Verified friend request/accept: remember their card so envelopes can
   * be sealed immediately after a full handshake. */
  private onFriendNotice(notice: FriendNotice): void {
    this.sessions.rememberContact(notice.from, notice.card);
    if (notice.profile) this.contactProfiles.set(notice.from, {...notice.profile});
    this.touch();
    if (notice.kind === 'request') {
      this.emit('friend://request', {
        peerId: notice.from,
        displayName: notice.profile?.displayName ?? '',
        avatarHash: notice.profile?.avatarHash ?? null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internals

  /** publish() legacy path: seal to a peer when we hold their card, else
   * raw plaintext on their DM topic (pre-server behaviour). */
  private async sendDmOrRaw(channel: string, text: string): Promise<void> {
    const topic = dmTopic(channel);
    const key = this.sessions.recipientKey(channel);
    if (key) {
      const envelope = this.sessions.seal([key], utf8(topic), utf8(text));
      this.node.subscribe(topic);
      await this.node.publish(topic, envelope);
      this.dmHistory.set(channel, [
        ...(this.dmHistory.get(channel) ?? []),
        {peer: channel, text, ts: Date.now(), mine: true},
      ]);
      this.touch();
      return;
    }
    this.node.subscribe(topic);
    await this.node.publish(topic, utf8(text));
  }

  private netStatus(): NetStatusDto {
    return {
      peers: this.node.peerCount,
      listenAddrs: this.node.listenAddrs,
      externalAddrs: [],
      relayReservations: this.node.reservationCount,
      reachability: 'unknown',
      reachabilityMeasured: false,
      knownNodes: 0,
    };
  }

  private owned(serverId: string): ServerRecord {
    const rec = this.servers.get(serverId);
    if (!rec || !rec.keys) throw new Error('you do not own that server');
    return rec;
  }

  private async publishList(rec: ServerRecord): Promise<void> {
    await this.publishJson(serverTopic(rec.id), rec.signedList());
    this.touch(); // every owner mutation funnels through here
    this.emit('server://list', this.dtoView(rec.view(this.peerId)));
  }

  private async publishJson(topic: string, value: unknown): Promise<void> {
    await this.node.publish(topic, jsonBytes(value));
  }

  private pushServerHistory(msg: SignedMessage): void {
    const map = historyFor(this.serverHistory, msg.serverId);
    const arr = map.get(msg.channel) ?? [];
    arr.push(msg);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    map.set(msg.channel, arr);
    this.touch();
  }

  private viewOf(rec: ServerRecord): ServerViewDto {
    return this.dtoView(rec.view(this.peerId));
  }

  private dtoView(v: ReturnType<ServerRecord['view']>): ServerViewDto {
    return {
      ...v,
      channels: v.channels.map((c) => ({...c})),
      members: v.members.map(
        (m): MemberDto => ({
          peerId: m.peerId,
          name: m.name,
          role: m.role,
          joinedEpoch: m.joinedEpoch,
          card: m.card ? cardToDto(m.card) : undefined,
          profile: m.profile ? {...m.profile} : undefined,
        }),
      ),
    };
  }

  private emit<K extends EventName>(event: K, payload: Events[K]): void {
    for (const cb of this.listeners.get(event) ?? []) (cb as (p: Events[K]) => void)(payload);
  }
}

// ---------------------------------------------------------------------------
// Helpers

/** DM topics are `peers/v1/ch/<id>`; channel topics add a segment. */
function dmTopic(id: string): string {
  return `peers/v1/ch/${id}`;
}

function nonceKey(nonce: number[]): string {
  return nonce.join(',');
}

function nonceSet(map: Map<string, Set<string>>, serverId: string): Set<string> {
  let s = map.get(serverId);
  if (!s) {
    s = new Set();
    map.set(serverId, s);
  }
  return s;
}

function historyFor(map: Map<string, Map<string, SignedMessage[]>>, serverId: string): Map<string, SignedMessage[]> {
  let m = map.get(serverId);
  if (!m) {
    m = new Map();
    map.set(serverId, m);
  }
  return m;
}

function cardToDto(card: PeerCard): PeerCardDto {
  return {
    edPub: Array.from(card.edPub),
    x25519Pub: Array.from(card.x25519Pub),
    sig: Array.from(card.sig),
  };
}

function dtoToCard(dto: PeerCardDto): PeerCard {
  return {
    edPub: Uint8Array.from(dto.edPub),
    x25519Pub: Uint8Array.from(dto.x25519Pub),
    sig: Uint8Array.from(dto.sig),
  };
}

function msgToDto(m: SignedMessage): SignedMessageDto {
  return {...m};
}

/** Core PlazaMessageShape → wire DTO (drops the card; it's transport-only). */
function plazaToDto(m: PlazaMessageShape): PlazaMessageDto {
  return {
    version: m.version,
    kind: m.kind,
    from: m.from,
    pubkey: [...m.pubkey],
    ts: m.ts,
    text: m.text,
    profile: m.profile ? {...m.profile} : null,
    sig: m.sig,
  };
}

/** Sender identity embedded in a sealed envelope header (unverified bytes;
 * the session layer verifies the card before opening). */
function envelopeSenderId(envelope: Uint8Array): string {
  return PeerCard.peerIdOf({
    edPub: envelope.slice(1, 33),
    x25519Pub: envelope.slice(33, 65),
    sig: envelope.slice(65, 129),
  });
}

/** JSON with typed arrays as plain arrays — the wire shape every verifier
 * reconstructs. Plain canonicalJson would stringify Uint8Array as objects. */
function jsonBytes(value: unknown): Uint8Array {
  return utf8(
    JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v)),
  );
}

function jsonStr(value: unknown): string {
  return new TextDecoder().decode(jsonBytes(value));
}

// -- wire hydration -----------------------------------------------------------
// jsonBytes() puts byte arrays on the wire; verifiers need typed arrays back.
// Hydration rebuilds exactly the fields the domain types declare as bytes and
// leaves number[] fields (pubkey, nonce) alone, so canonical re-serialization
// reproduces the original signing bytes.

function byteArray(v: unknown): Uint8Array {
  return Array.isArray(v) ? Uint8Array.from(v as number[]) : new Uint8Array(0);
}

function hydrateCard(v: unknown): PeerCard | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  return {edPub: byteArray(c.edPub), x25519Pub: byteArray(c.x25519Pub), sig: byteArray(c.sig)};
}

function hydrateProfile(v: unknown): SignedProfile | null {
  if (!v || typeof v !== 'object') return null;
  return {...(v as SignedProfile)};
}

type WireList = Parameters<ServerRecord['verifyList']>[0];

function hydrateList(body: Record<string, unknown>): WireList {
  type WireMember = {card?: unknown; profile?: unknown};
  const payload = body.payload as WireList['payload'] & {members?: (WireMember & Record<string, unknown>)[]};
  return {
    ...body,
    payload: {
      ...payload,
      members: (payload.members ?? []).map((m) => ({
        ...m,
        card: hydrateCard(m.card),
        profile: hydrateProfile(m.profile),
      })),
    },
  } as WireList;
}

const EMPTY_CARD: PeerCard = {edPub: new Uint8Array(0), x25519Pub: new Uint8Array(0), sig: new Uint8Array(0)};

function hydrateJoin(body: Record<string, unknown>): JoinNotice {
  const b = body as unknown as JoinNotice & Record<string, unknown>;
  return {
    ...b,
    nonce: Array.isArray(b.nonce) ? (b.nonce as number[]) : [],
    card: hydrateCard(b.card) ?? EMPTY_CARD,
    profile: hydrateProfile(b.profile),
  };
}

function hydrateProfileNotice(body: Record<string, unknown>): ProfileNotice {
  const b = body as unknown as ProfileNotice;
  return {...b, profile: hydrateProfile(b.profile)!};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
