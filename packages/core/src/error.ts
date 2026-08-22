/** Every failure mode the domain can produce, mirroring the PeersError
 * taxonomy. Callers branch on `kind`, not on string matching. */
export type PeersErrorKind =
  | 'Crypto'
  | 'Identity'
  | 'Keystore'
  | 'BadPassword'
  | 'BadPhrase'
  | 'NoKeystore'
  | 'StaleKeystore'
  | 'Replay'
  | 'GapTooLarge'
  | 'BadCipher'
  | 'MessageTooLarge'
  | 'Io'
  | 'NotAddressed'
  | 'BlobNotFound'
  | 'BlobCorrupt'
  | 'Timeout'
  | 'ServerNotFound'
  | 'NotOwner'
  | 'AlreadyMember'
  | 'BadInvite'
  | 'UnknownEpoch'
  | 'Forbidden'
  | 'NotInServer'
  | 'SnapshotCorrupt'
  | 'Other';

const MESSAGES: Partial<Record<PeersErrorKind, string>> = {
  BadPassword: 'bad password',
  NoKeystore: 'keystore does not exist',
  StaleKeystore:
    'this identity was created by an older version of Peers and cannot be recovered with a phrase',
  Replay: 'message sequence already opened (replay)',
  GapTooLarge: 'message sequence gap too large',
  BadCipher: 'ciphertext authentication failed',
  MessageTooLarge: 'message too large',
  NotAddressed: 'envelope is not addressed to us',
  BlobNotFound: 'blob not found in swarm',
  BlobCorrupt: 'blob hash mismatch (corrupt or tampered)',
  Timeout: 'operation timed out',
  ServerNotFound: 'server not found',
  NotOwner: 'only the server owner can do that',
  AlreadyMember: 'you are already a member of this server',
  BadInvite: 'invite is invalid or expired',
  UnknownEpoch: 'server key epoch is unknown',
  Forbidden: 'you are not allowed to do that in this channel',
  NotInServer: 'you are not a member of this server',
  SnapshotCorrupt: 'snapshot is corrupt or its signature does not verify',
};

/** One error type for the whole domain. `kind` is the interface;
 * messages are diagnostics. */
export class PeersError extends Error {
  constructor(
    public readonly kind: PeersErrorKind,
    message?: string,
  ) {
    super(message ?? MESSAGES[kind] ?? kind);
    this.name = 'PeersError';
  }
}

export function peersErr(kind: PeersErrorKind, message?: string): PeersError {
  return new PeersError(kind, message);
}
