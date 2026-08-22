import {ed25519} from '@noble/curves/ed25519.js';
import {randomBytes} from '@noble/hashes/utils.js';
import {peersErr} from './error.js';
import type {Identity} from './identity.js';
import {derivePeerId} from './peerid.js';
import {PeerCard, SignedProfile} from './card.js';
import {b64decode, b64encode, canonicalJson, unixNow} from './util.js';

/**
 * Servers: owner-signed member lists, rotating signing keys, invites.
 *
 * A server is an ephemeral group owned by one peer. Every mutation
 * (member add/remove/role change, channel ACL change, key rotation) is
 * applied by the owner and published as a SignedList on the server topic.
 * Members verify the list against the key they already trust and follow
 * the rotation chain (`signingPub` signs this list, `nextPub` signs the
 * next one).
 *
 * Invites are self-contained: they embed the chain-head key (the key that
 * will sign the next list), so a joiner can anchor trust immediately.
 *
 * All signatures cover canonical JSON with fixed field order; signers and
 * verifiers build the same object shape, so bytes always agree.
 */

// ---------------------------------------------------------------------------
// Roles

export type Role = 'member' | 'admin' | 'owner';

export const Role = {
  rank(role: Role): number {
    return role === 'owner' ? 3 : role === 'admin' ? 2 : 1;
  },
};

// ---------------------------------------------------------------------------
// Members and channels

export interface Member {
  peerId: string;
  name: string;
  role: Role;
  joinedEpoch: number;
  /** Validated identity card — riding inside the signed list doubles as
   * the DM key exchange. */
  card?: PeerCard | null;
  /** The member's signed display profile, if known. */
  profile?: SignedProfile | null;
}

/** A channel plus its ACL (minimum roles to read / write). */
export interface ChannelConfig {
  name: string;
  topic: string;
  readMin: Role;
  writeMin: Role;
}

// ---------------------------------------------------------------------------
// Signed lists

/** The part of a SignedList that is signed. Field order is fixed so the
 * serialized bytes are canonical for signature verification. */
export interface ListPayload {
  version: number;
  serverId: string;
  epoch: number;
  /** Key that produced `sig`; must equal the `nextPub` we knew. */
  signingPub: number[];
  /** Key that will sign the next list (after the next rotation). */
  nextPub: number[];
  members: Member[];
  channels: ChannelConfig[];
}

export interface SignedList {
  payload: ListPayload;
  /** base64 Ed25519 signature over the canonical JSON of `payload`. */
  sig: string;
}

// ---------------------------------------------------------------------------
// Invites

/** The part of an Invite that is signed by the current server key. */
export interface InvitePayload {
  version: number;
  serverId: string;
  serverName: string;
  ownerPeer: string;
  nonce: number[];
  /** Key that signs this invite and the next list; the joiner's trust
   * anchor (`knownPub`). The invite's signature verifies against it. */
  nextPub: number[];
}

/** Self-contained join credential. Anyone holding a valid invite can join. */
export interface Invite {
  payload: InvitePayload;
  sig: string;
  /** The owner's listen multiaddrs, so the joiner can dial directly.
   * Routing metadata only — unsigned. */
  addrs: string[];
}

export const Invite = {
  /**
   * Verifies the invite against the key embedded in its own payload, so a
   * joiner can authenticate it before trusting `nextPub`.
   */
  verify(invite: Invite): boolean {
    try {
      return ed25519.verify(
        b64decode(invite.sig),
        canonicalJson(invite.payload),
        Uint8Array.from(invite.payload.nextPub),
      );
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Rotating server signing keys

interface KeyPair {
  seed: Uint8Array;
  pub: number[];
}

function freshKey(): KeyPair {
  const seed = ed25519.utils.randomSecretKey();
  return {seed, pub: Array.from(ed25519.getPublicKey(seed))};
}

function keyFromSeed(seed: Uint8Array): KeyPair {
  return {seed, pub: Array.from(ed25519.getPublicKey(seed))};
}

/**
 * Rotating server signing keys. `prev` signs the first list after a
 * rotation so members can follow the chain; every rotation re-signs
 * immediately, keeping the invariant: list(E+1) is signed by key(E).
 */
export class ServerKeys {
  epoch = 0;
  private current: KeyPair;
  private prev: KeyPair | null;

  constructor() {
    this.current = freshKey();
    this.prev = null;
  }

  /** Rotates: the current key becomes the chain-linking previous key. */
  rotate(): void {
    this.prev = this.current;
    this.current = freshKey();
    this.epoch += 1;
  }

  /** The key that signs the current list (`prev` right after rotation). */
  get signingKey(): KeyPair {
    return this.prev ?? this.current;
  }

  get signingPub(): number[] {
    return [...this.signingKey.pub];
  }

  /** The key that will sign the next list. */
  get nextPub(): number[] {
    return [...this.current.pub];
  }

  sign(bytes: Uint8Array): string {
    return b64encode(ed25519.sign(bytes, this.signingKey.seed));
  }

  toPersisted(): PersistedKeys {
    return {
      current: b64encode(this.current.seed),
      prev: this.prev ? b64encode(this.prev.seed) : null,
      epoch: this.epoch,
    };
  }

  static fromPersisted(p: PersistedKeys): ServerKeys {
    if (p.prev === undefined) throw peersErr('SnapshotCorrupt', 'malformed persisted keys');
    const keys = new ServerKeys();
    keys.current = keyFromSeed(b64decode(p.current));
    keys.prev = p.prev ? keyFromSeed(b64decode(p.prev)) : null;
    keys.epoch = p.epoch;
    return keys;
  }
}

export interface PersistedKeys {
  current: string;
  prev: string | null;
  epoch: number;
}

// ---------------------------------------------------------------------------
// Server records

/** A server known to this node. `keys` is only present for the owner. */
export class ServerRecord {
  id: string;
  name: string;
  ownerPeer: string;
  /** The key we last verified; lists must be signed by it. */
  knownPub: number[];
  members: Member[];
  channels: ChannelConfig[];
  keys: ServerKeys | null;

  private constructor(init: {
    id: string;
    name: string;
    ownerPeer: string;
    knownPub: number[];
    members: Member[];
    channels: ChannelConfig[];
    keys: ServerKeys | null;
  }) {
    this.id = init.id;
    this.name = init.name;
    this.ownerPeer = init.ownerPeer;
    this.knownPub = init.knownPub;
    this.members = init.members;
    this.channels = init.channels;
    this.keys = init.keys;
  }

  /** Creates a server owned by `ownerPeer` with a fresh signing key. */
  static newOwned(id: string, name: string, ownerPeer: string, ownerCard: PeerCard): ServerRecord {
    const keys = new ServerKeys();
    return new ServerRecord({
      id,
      name,
      ownerPeer,
      knownPub: keys.signingPub,
      keys,
      members: [
        {peerId: ownerPeer, name: 'owner', role: 'owner', joinedEpoch: 0, card: ownerCard, profile: null},
      ],
      channels: [newChannel('general', 'general')],
    });
  }

  /** Creates a joined (non-owner) record anchored on the invite's key.
   * Members/channels stay empty until the first verifiable list arrives. */
  static newJoined(invite: Invite): ServerRecord {
    return new ServerRecord({
      id: invite.payload.serverId,
      name: invite.payload.serverName,
      ownerPeer: invite.payload.ownerPeer,
      knownPub: [...invite.payload.nextPub],
      keys: null,
      members: [],
      channels: [],
    });
  }

  /** Signs the current member list with the chain-linking key. */
  signedList(): SignedList {
    const keys = this.keys;
    if (!keys) throw peersErr('NotOwner');
    const payload: ListPayload = {
      version: 1,
      serverId: this.id,
      epoch: keys.epoch,
      signingPub: keys.signingPub,
      nextPub: keys.nextPub,
      members: this.members.map(cloneMember),
      channels: this.channels.map((c) => ({...c})),
    };
    return {payload, sig: keys.sign(canonicalJson(payload))};
  }

  /** Verifies a list against our known key and advances the chain. */
  verifyList(list: SignedList): void {
    if (list.payload.serverId !== this.id) throw peersErr('ServerNotFound');
    if (!arrayEq(list.payload.signingPub, this.knownPub)) throw peersErr('UnknownEpoch');
    let ok = false;
    try {
      ok = ed25519.verify(
        b64decode(list.sig),
        canonicalJson(list.payload),
        Uint8Array.from(this.knownPub),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw peersErr('SnapshotCorrupt');
    this.members = list.payload.members.map(cloneMember);
    this.channels = list.payload.channels.map((c) => ({...c}));
    this.knownPub = [...list.payload.nextPub];
  }

  /**
   * Creates an invite anchored on the chain head (the key that signs the
   * next list), signed by that same key.
   */
  invite(): Invite {
    const keys = this.keys;
    if (!keys) throw peersErr('NotOwner');
    const nonce = Array.from(randomBytes(16));
    const payload: InvitePayload = {
      version: 1,
      serverId: this.id,
      serverName: this.name,
      ownerPeer: this.ownerPeer,
      nonce,
      nextPub: keys.signingPub,
    };
    const sig = b64encode(ed25519.sign(canonicalJson(payload), keys.signingKey.seed));
    return {payload, sig, addrs: []};
  }

  roleOf(peerId: string): Role | undefined {
    return this.members.find((m) => m.peerId === peerId)?.role;
  }

  /** Whether `peerId` may publish to the channel. */
  canWrite(peerId: string, channel: string): boolean {
    const cfg = this.channels.find((c) => c.name === channel);
    if (!cfg) return false;
    const role = this.roleOf(peerId);
    if (!role) return false;
    return Role.rank(role) >= Role.rank(cfg.writeMin);
  }

  view(me: string): ServerView {
    return {
      id: this.id,
      name: this.name,
      ownerPeer: this.ownerPeer,
      isOwner: this.ownerPeer === me,
      myRole: this.roleOf(me) ?? null,
      memberCount: this.members.length,
      epoch: this.keys?.epoch ?? 0,
      pending: this.keys === null && this.roleOf(me) === undefined,
      channels: this.channels.map((c) => ({...c})),
      members: this.members.map(cloneMember),
    };
  }

  toPersisted(): PersistedServer {
    return {
      id: this.id,
      name: this.name,
      ownerPeer: this.ownerPeer,
      knownPub: [...this.knownPub],
      members: this.members.map(cloneMember),
      channels: this.channels.map((c) => ({...c})),
      keys: this.keys?.toPersisted() ?? null,
    };
  }

  static fromPersisted(p: PersistedServer): ServerRecord {
    if (p.knownPub.length !== 32) throw peersErr('SnapshotCorrupt');
    return new ServerRecord({
      id: p.id,
      name: p.name,
      ownerPeer: p.ownerPeer,
      knownPub: [...p.knownPub],
      members: p.members.map(cloneMember),
      channels: p.channels.map((c) => ({...c})),
      keys: p.keys ? ServerKeys.fromPersisted(p.keys) : null,
    });
  }
}

export interface PersistedServer {
  id: string;
  name: string;
  ownerPeer: string;
  knownPub: number[];
  members: Member[];
  channels: ChannelConfig[];
  keys: PersistedKeys | null;
}

function newChannel(name: string, topic: string): ChannelConfig {
  return {name, topic, readMin: 'member', writeMin: 'member'};
}

/** Deep-ish clone so signed payloads never alias mutable live state. */
function cloneMember(m: Member): Member {
  return {...m};
}

function arrayEq(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Snapshots

/**
 * Owner-signed export of a server's full state (members, channels and
 * message history). Anyone holding the server's verified member list can
 * check the signature and import the history; the owner signs with the
 * current chain key.
 */
export interface SnapshotShape {
  version: number;
  serverId: string;
  serverName: string;
  exportedEpoch: number;
  channels: ChannelConfig[];
  members: Member[];
  messages: SignedMessage[];
  sig: string;
}

export const Snapshot = {
  /** Builds and signs a snapshot with the server's chain-linking key. */
  sign(rec: ServerRecord, messages: SignedMessage[]): SnapshotShape {
    const keys = rec.keys;
    if (!keys) throw peersErr('NotOwner');
    const snap: SnapshotShape = {
      version: 1,
      serverId: rec.id,
      serverName: rec.name,
      exportedEpoch: keys.epoch,
      channels: rec.channels.map((c) => ({...c})),
      members: rec.members.map(cloneMember),
      messages: messages.map((m) => ({...m})),
      sig: '',
    };
    snap.sig = keys.sign(canonicalJson(snap));
    return snap;
  },

  /**
   * Verifies the snapshot against the chain key we already trust for this
   * server, and that it describes the same server id.
   */
  verify(snap: SnapshotShape, rec: ServerRecord): void {
    if (snap.serverId !== rec.id) throw peersErr('ServerNotFound');
    const copy: SnapshotShape = {...snap, sig: ''};
    let ok = false;
    try {
      ok = ed25519.verify(
        b64decode(snap.sig),
        canonicalJson(copy),
        Uint8Array.from(rec.knownPub),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw peersErr('SnapshotCorrupt');
  },
};

// ---------------------------------------------------------------------------
// Topics and ids

/** The server-wide gossip topic used for control messages. */
export function serverTopic(serverId: string): string {
  return `peers/v1/srv/${serverId}`;
}

/** The gossip topic for a channel inside a server. */
export function channelTopic(serverId: string, channel: string): string {
  return `peers/v1/ch/${serverId}/${channel}`;
}

/** Generates a random server id (hex, 16 chars). */
export function newServerId(): string {
  return Buffer.from(randomBytes(8)).toString('hex');
}

// ---------------------------------------------------------------------------
// Notices

/** Plaintext notice a joiner publishes on the server topic asking the
 * owner to add them to the signed list. The owner verifies membership
 * itself; this is only a request. */
export interface JoinNotice {
  kind: string;
  serverId: string;
  peerId: string;
  name: string;
  nonce: number[];
  card: PeerCard;
  profile?: SignedProfile | null;
}

export const JoinNotice = {
  KIND: 'join',
  new(
    serverId: string,
    peerId: string,
    name: string,
    nonce: number[],
    card: PeerCard,
    profile?: SignedProfile | null,
  ): JoinNotice {
    return {kind: 'join', serverId, peerId, name, nonce, card, profile: profile ?? null};
  },
};

/** Notice a member publishes when their profile changes; the owner folds
 * it back into the next signed list. */
export interface ProfileNotice {
  kind: string;
  serverId: string;
  peerId: string;
  profile: SignedProfile;
}

export const ProfileNotice = {
  KIND: 'profile',
  new(serverId: string, peerId: string, profile: SignedProfile): ProfileNotice {
    return {kind: 'profile', serverId, peerId, profile};
  },
};

// ---------------------------------------------------------------------------
// Plaza

/** The global community topic every peer auto-joins. Self-signed messages
 * only — no owner, no ACL. Membership ("who's here") derives from the
 * verified profiles seen on it. */
export const PLAZA_TOPIC = 'peers/v1/plaza';

/** A self-signed Plaza message: "chat" for community chat, "profile" to
 * announce who you are. Authorship verifies from the embedded pubkey +
 * signature; there is no membership to check. */
export interface PlazaMessageShape {
  version: number;
  kind: string;
  from: string;
  pubkey: number[];
  ts: number;
  text: string;
  profile?: SignedProfile | null;
  card?: PeerCard | null;
  sig: string;
}

export const PlazaMessage = {
  KIND_CHAT: 'chat',
  KIND_PROFILE: 'profile',

  sign(
    identity: Identity,
    kind: string,
    text: string,
    extras?: {profile?: SignedProfile | null; card?: PeerCard | null},
  ): PlazaMessageShape {
    const msg: PlazaMessageShape = {
      version: 1,
      kind,
      from: identity.peerId,
      pubkey: identity.edPublicAsArray(),
      ts: unixNow(),
      text,
      profile: extras?.profile ?? null,
      card: extras?.card ?? null,
      sig: '',
    };
    msg.sig = b64encode(identity.sign(canonicalJson(msg)));
    return msg;
  },

  /** Verifies authorship and any riding profile/card are bound to it. */
  verify(msg: PlazaMessageShape): void {
    let ok = false;
    try {
      ok = ed25519.verify(
        b64decode(msg.sig),
        canonicalJson(plazaSignView(msg)),
        Uint8Array.from(msg.pubkey),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw peersErr('SnapshotCorrupt');
    if (derivePeerId(Uint8Array.from(msg.pubkey)) !== msg.from) {
      throw peersErr('SnapshotCorrupt');
    }
    if (msg.profile) {
      // Throws on tamper or peer-id mismatch.
      SignedProfile.verify(msg.profile);
      if (msg.profile.peerId !== msg.from) throw peersErr('SnapshotCorrupt');
    }
    if (msg.card) {
      if (!PeerCard.verify(msg.card)) throw peersErr('SnapshotCorrupt');
      if (!arrayEq(Array.from(msg.card.edPub), msg.pubkey)) throw peersErr('SnapshotCorrupt');
    }
  },
};

function plazaSignView(msg: PlazaMessageShape): Record<string, unknown> {
  return {...msg, sig: ''};
}

// ---------------------------------------------------------------------------
// Channel messages

/**
 * A channel message: signed by the sender's Ed25519 key, whose public key
 * is embedded so any member can verify authenticity and bind it to the
 * sender's peer ID. Channel messages are broadcast (not encrypted).
 */
export interface SignedMessage {
  version: number;
  serverId: string;
  channel: string;
  from: string;
  /** Ed25519 public key of the sender. */
  pubkey: number[];
  text: string;
  ts: number;
  sig: string;
}

export const SignedMessage = {
  /** Signs `text`; the signature covers every field except `sig` itself
   * (canonical JSON, declared order, sig serialized as ""). */
  sign(identity: Identity, serverId: string, channel: string, text: string): SignedMessage {
    const msg: SignedMessage = {
      version: 1,
      serverId,
      channel,
      from: identity.peerId,
      pubkey: identity.edPublicAsArray(),
      text,
      ts: unixNow(),
      sig: '',
    };
    msg.sig = b64encode(identity.sign(canonicalJson(msg)));
    return msg;
  },

  /** Verifies the signature, that the embedded key matches `from`, and
   * that `from` is a member of `rec`. */
  verify(msg: SignedMessage, rec: ServerRecord): void {
    if (rec.roleOf(msg.from) === undefined) throw peersErr('NotInServer');
    let ok = false;
    try {
      ok = ed25519.verify(
        b64decode(msg.sig),
        canonicalJson({...msg, sig: ''}),
        Uint8Array.from(msg.pubkey),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw peersErr('SnapshotCorrupt');
    if (derivePeerId(Uint8Array.from(msg.pubkey)) !== msg.from) {
      throw peersErr('SnapshotCorrupt');
    }
  },
};

// ---------------------------------------------------------------------------
// Server directory

/** Registry of servers this node owns or has joined. */
export class ServerDir {
  private readonly servers = new Map<string, ServerRecord>();

  create(id: string, name: string, ownerPeer: string, ownerCard: PeerCard): ServerRecord {
    const rec = ServerRecord.newOwned(id, name, ownerPeer, ownerCard);
    this.servers.set(id, rec);
    return rec;
  }

  get(id: string): ServerRecord | undefined {
    return this.servers.get(id);
  }

  /** Verifies and applies a joined invite. */
  join(invite: Invite): ServerRecord {
    if (!Invite.verify(invite)) throw peersErr('BadInvite');
    if (this.servers.has(invite.payload.serverId)) throw peersErr('AlreadyMember');
    const rec = ServerRecord.newJoined(invite);
    this.servers.set(rec.id, rec);
    return rec;
  }

  remove(id: string): boolean {
    return this.servers.delete(id);
  }

  views(me: string): ServerView[] {
    return [...this.servers.values()].map((s) => s.view(me));
  }

  records(): ServerRecord[] {
    return [...this.servers.values()];
  }

  restore(rec: ServerRecord): void {
    this.servers.set(rec.id, rec);
  }
}

/** Frontend-friendly snapshot of a server. */
export interface ServerView {
  id: string;
  name: string;
  ownerPeer: string;
  isOwner: boolean;
  myRole: Role | null;
  memberCount: number;
  epoch: number;
  /** Joined via invite but not yet on the owner's signed list. */
  pending: boolean;
  channels: ChannelConfig[];
  members: Member[];
}
