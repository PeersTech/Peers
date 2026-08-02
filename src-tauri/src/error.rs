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

    #[error("blob not found in swarm")]
    BlobNotFound,

    #[error("blob hash mismatch (corrupt or tampered)")]
    BlobCorrupt,

    #[error("operation timed out")]
    Timeout,

    #[error("{0}")]
    Other(String),
}

impl From<PeersError> for String {
    fn from(e: PeersError) -> Self {
        e.to_string()
    }
}

pub type Result<T> = std::result::Result<T, PeersError>;
