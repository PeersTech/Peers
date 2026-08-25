/**
 * @peers/core — the domain deep module: identity, seed login, sealed
 * keystore/store, E2E sessions, servers/channels/ACL, profiles, codes,
 * plaza. Pure TypeScript; accepts its dependencies, creates none of them.
 */

export {PeersError, peersErr, type PeersErrorKind} from './error.js';
export {
  generatePhrase,
  validatePhrase,
  decodePhrase,
  entropyToPhrase,
  type WordCount,
} from './mnemonic.js';
export {deriveKeys} from './seed.js';
export {derivePeerId, fingerprint, peerIdBytes as peerIdBytesOf} from './peerid.js';
export {Identity} from './identity.js';
export {shortCode, formatCode, normalizeCode, codeKey, CODE_DIGITS} from './code.js';
export {
  FriendNotice,
  encodeFriendNotice,
  decodeFriendNotice,
  friendRequestTopic,
  FRIEND_REQUEST_TOPIC_PREFIX,
  type FriendNoticeKind,
} from './friend.js';
export {Session, MAX_SESSION_GAP, type SessionState} from './session.js';
export {seal, open, nonceFor, MAX_MESSAGE_SIZE} from './cipher.js';
export {
  PeerCard,
  SignedProfile,
  SessionDir,
  cardFromEnvelope,
  defaultDisplayName,
} from './card.js';
export {Keystore, VERSION as KEYSTORE_VERSION} from './keystore.js';
export {PROD_KDF, TEST_KDF, deriveKey, sealX, openX, type KdfParams} from './kdf.js';
export {History, PersistedState, Store, StoreHandle} from './store.js';
export {
  Role,
  Invite,
  ServerKeys,
  ServerRecord,
  ServerDir,
  Snapshot,
  JoinNotice,
  ProfileNotice,
  PlazaMessage,
  SignedMessage,
  serverTopic,
  channelTopic,
  newServerId,
  PLAZA_TOPIC,
} from './server.js';
export type {DmMessage} from './store.js';
export type {
  Member,
  ChannelConfig,
  ListPayload,
  SignedList,
  InvitePayload,
  PersistedKeys,
  PersistedServer,
  ServerView,
  SnapshotShape,
  PlazaMessageShape,
} from './server.js';
