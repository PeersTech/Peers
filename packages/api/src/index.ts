/**
 * The Peers host interface: every fact a renderer (or test) must know to
 * drive a running node, and every event a node emits back.
 *
 * This is THE seam between the UI and the network. Three adapters satisfy
 * it — Electron IPC, localhost WebSocket bridge, and direct in-process
 * calls (CLI/tests) — so it must stay transport-agnostic: plain JSON-
 * serialisable DTOs only, no Node or browser globals.
 */

export type Role = 'member' | 'admin' | 'owner';

/** Role ordering used for channel ACL checks. */
export const ROLE_RANK: Record<Role, number> = {member: 1, admin: 2, owner: 3};

export interface PeerCardDto {
  edPub: number[];
  x25519Pub: number[];
  sig: number[];
}

export interface SignedProfileDto {
  version: number;
  peerId: string;
  pubkey: number[];
  displayName: string;
  about: string;
  avatarHash: string | null;
  sig: string;
}

export interface ChannelConfigDto {
  name: string;
  topic: string;
  readMin: Role;
  writeMin: Role;
}

export interface MemberDto {
  peerId: string;
  name: string;
  role: Role;
  joinedEpoch: number;
  card?: PeerCardDto;
  profile?: SignedProfileDto;
}

export interface ServerViewDto {
  id: string;
  name: string;
  ownerPeer: string;
  isOwner: boolean;
  myRole: Role | null;
  memberCount: number;
  epoch: number;
  /** Joined via invite but not yet on the owner's signed list. */
  pending: boolean;
  channels: ChannelConfigDto[];
  members: MemberDto[];
}

export interface IdentityInfoDto {
  peerId: string;
  peerIdShort: string;
  fingerprint: string;
  defaultName?: string;
}

export interface ServerMessageDto {
  serverId: string;
  channel: string;
  from: string;
  text: string;
  ts: number;
}

export interface SignedMessageDto {
  version: number;
  serverId: string;
  channel: string;
  from: string;
  pubkey: number[];
  text: string;
  ts: number;
  sig: string;
}

export interface DmMessageDto {
  peer: string;
  text: string;
  ts: number;
  mine: boolean;
}

export interface JoinNoticeDto {
  kind: string;
  serverId: string;
  peerId: string;
  name: string;
  nonce: number[];
  card: PeerCardDto;
  profile?: SignedProfileDto | null;
}

export interface PlazaMessageDto {
  version: number;
  kind: string;
  from: string;
  pubkey: number[];
  ts: number;
  text: string;
  profile?: SignedProfileDto | null;
  sig: string;
}

export interface PlazaPresenceDto {
  peerId: string;
  lastTs: number;
}

export interface NetStatusDto {
  peers: number;
  listenAddrs: string[];
  externalAddrs: string[];
  relayReservations: number;
  reachability: 'direct' | 'relayed' | 'unreachable' | 'unknown';
  reachabilityMeasured: boolean;
  knownNodes: number;
}

export interface PeerCodeDto {
  code: string;
  formatted: string;
}

/**
 * Every request the renderer can make, keyed by command name.
 * `Args` is what goes over the wire; `Ret` comes back (or the call rejects).
 */
export interface Commands {
  // identity / session
  has_identity: {args: Record<string, never>; ret: boolean};
  is_unlocked: {args: Record<string, never>; ret: boolean};
  generate_phrase: {args: {wordCount?: number}; ret: string};
  init_from_phrase: {args: {phrase: string}; ret: IdentityInfoDto};
  unlock: {args: {password: string}; ret: IdentityInfoDto};
  lock: {args: Record<string, never>; ret: null};

  // friend codes (M8/M17)
  my_code: {args: Record<string, never>; ret: PeerCodeDto};
  lookup_code: {args: {code: string}; ret: string};
  add_contact: {args: {peerId: string}; ret: null};
  send_friend_request: {args: {peerId: string}; ret: null};
  accept_friend: {args: {peerId: string}; ret: null};

  // network status
  net_status: {args: Record<string, never>; ret: NetStatusDto};
  online_peers: {args: Record<string, never>; ret: string[]};

  // legacy raw topics (DMs pre-date servers; kept for parity)
  subscribe: {args: {channel: string}; ret: null};
  unsubscribe: {args: {channel: string}; ret: null};
  publish: {args: {channel: string; text: string}; ret: null};

  // servers
  create_server: {args: {name: string}; ret: ServerViewDto};
  list_servers: {args: Record<string, never>; ret: ServerViewDto[]};
  create_invite: {args: {serverId: string}; ret: string};
  join_server: {args: {inviteJson: string; name: string}; ret: ServerViewDto};
  leave_server: {args: {serverId: string}; ret: null};
  add_member: {
    args: {serverId: string; peerId: string; name: string; role: Role; card?: PeerCardDto};
    ret: ServerViewDto;
  };
  remove_member: {args: {serverId: string; peerId: string}; ret: ServerViewDto};
  set_role: {args: {serverId: string; peerId: string; role: Role}; ret: ServerViewDto};
  rotate_key: {args: {serverId: string}; ret: ServerViewDto};
  set_channel: {
    args: {serverId: string; name: string; topic: string; readMin: Role; writeMin: Role};
    ret: ServerViewDto;
  };
  rename_server: {args: {serverId: string; name: string}; ret: ServerViewDto};
  subscribe_channel: {args: {serverId: string; channel: string}; ret: null};
  unsubscribe_channel: {args: {serverId: string; channel: string}; ret: null};
  publish_channel: {args: {serverId: string; channel: string; text: string}; ret: null};
  server_history: {args: {serverId: string; channel: string}; ret: SignedMessageDto[]};
  dm_history: {args: {peer: string}; ret: DmMessageDto[]};
  export_snapshot: {args: {serverId: string}; ret: string};
  import_snapshot: {args: {serverId: string; snapshotJson: string}; ret: number};

  // profiles (M14)
  set_profile: {
    args: {displayName: string; about: string; avatarHash: string | null};
    ret: SignedProfileDto;
  };
  get_profile: {args: Record<string, never>; ret: SignedProfileDto | null};
  contact_profiles: {args: Record<string, never>; ret: Record<string, SignedProfileDto>};

  // blobs (DHT parking)
  park_blob: {args: {data: number[]}; ret: string};
  fetch_blob: {args: {hash: string}; ret: null};

  // plaza (M15)
  publish_plaza: {args: {text: string}; ret: null};
  plaza_history: {args: Record<string, never>; ret: PlazaMessageDto[]};
  plaza_who: {args: Record<string, never>; ret: PlazaPresenceDto[]};
}

export type CommandName = keyof Commands;

/** A single typed request across any transport adapter. */
export interface CommandRequest<K extends CommandName = CommandName> {
  cmd: K;
  args: Commands[K]['args'];
}

/** Every event the host pushes to the renderer, keyed by event name. */
export interface Events {
  'presence://peer-connected': string;
  'presence://peer-disconnected': string;
  'node://message': {from: string; channel: string; text?: string; error?: string};
  'net://hole-punch': {peerId: string; direct: boolean};
  'code://resolved': {code: string; peerId: string | null};
  'friend://request': {peerId: string; displayName: string; avatarHash: string | null};
  'blob://parked': {hash: string};
  'blob://fetched': {hash: string; data: number[]};
  'blob://failed': {hash: string; reason: string};
  'server://list': ServerViewDto;
  'server://message': ServerMessageDto;
  'server://error': {serverId: string; error: string};
  'server://join-request': JoinNoticeDto;
  'plaza://message': {from: string; text: string; ts: number; profile?: SignedProfileDto | null};
  'plaza://profile': {peerId: string; profile: SignedProfileDto | null};
}

export type EventName = keyof Events;

/**
 * The full client-side interface a Peers host exposes. Transport adapters
 * implement exactly this; the renderer consumes exactly this.
 */
export interface PeersApi {
  request<K extends CommandName>(cmd: K, args: Commands[K]['args']): Promise<Commands[K]['ret']>;
  on<K extends EventName>(event: K, cb: (payload: Events[K]) => void): () => void;
}
