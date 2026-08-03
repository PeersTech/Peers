use thiserror::Error;

/// Unified error type for the Peers backend.
#[derive(Debug, Error)]
pub enum PeersError {
    #[error("crypto: {0}")]
    Crypto(String),

    #[error("identity: {0}")]
    Identity(String),

    #[error("keystore: {0}")]
    Keystore(String),

    #[error("bad password")]
    BadPassword,

    #[error("keystore does not exist")]
    NoKeystore,

    #[error("message sequence already opened (replay)")]
    Replay,

    #[error("message sequence gap too large")]
    GapTooLarge,

    #[error("ciphertext authentication failed")]
    BadCipher,

    #[error("message too large")]
    MessageTooLarge,

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("p2p: {0}")]
    P2p(String),

    #[error("envelope is not addressed to us")]
    NotAddressed,

    #[error("blob not found in swarm")]
    BlobNotFound,

    #[error("blob hash mismatch (corrupt or tampered)")]
    BlobCorrupt,

    #[error("operation timed out")]
    Timeout,

    #[error("server not found")]
    ServerNotFound,

    #[error("only the server owner can do that")]
    NotOwner,

    #[error("you are already a member of this server")]
    AlreadyMember,

    #[error("invite is invalid or expired")]
    BadInvite,

    #[error("server key epoch is unknown")]
    UnknownEpoch,

    #[error("you are not allowed to do that in this channel")]
    Forbidden,

    #[error("you are not a member of this server")]
    NotInServer,

    #[error("snapshot is corrupt or its signature does not verify")]
    SnapshotCorrupt,

    #[error("{0}")]
    Other(String),
}

impl From<PeersError> for String {
    fn from(e: PeersError) -> Self {
        e.to_string()
    }
}

pub type Result<T> = std::result::Result<T, PeersError>;
