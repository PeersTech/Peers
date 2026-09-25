//! Sealed at-rest persistence for servers, DM contacts/sessions and message
//! history.
//!
//! Everything is encrypted with a key derived from the unlock password
//! (Argon2id → XChaCha20-Poly1305), mirroring the identity keystore, so
//! server signing keys and decrypted history never sit on disk in
//! plaintext. The salt lives in the state file itself; a fresh salt is
//! minted on first unlock.

use crate::atomic;
use crate::crypto::card::{SessionDir, SignedProfile};
use crate::crypto::group::GroupDescriptor;
use crate::crypto::server::{PersistedServer, SignedMessage};
use crate::error::{PeersError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const KDF_TIME: u32 = 3;
const KDF_MEMORY: u32 = 64 * 1024; // 64 MiB
const KDF_THREADS: u32 = 4;
const KDF_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const MAX_HISTORY_PER_CONVERSATION: usize = 2_000;
const MAX_HISTORY_CONVERSATIONS: usize = 512;

/// A pending direct message that can be re-encrypted and retried after a
/// disconnect. The payload is plaintext only inside the sealed state store.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    pub id: String,
    pub peer: String,
    pub payload: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub group_id: Option<String>,
    pub created_at: u64,
    pub attempts: u32,
}

/// One message stored in a direct-message conversation. `peer` is the
/// remote peer id; `mine` marks the side that sent it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmMessage {
    pub peer: String,
    pub text: String,
    pub ts: u64,
    pub mine: bool,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub attachment_name: Option<String>,
    #[serde(default)]
    pub attachment_mime: Option<String>,
    #[serde(default)]
    pub attachment_data: Option<Vec<u8>>,
}

/// Keyed message history. Server channels are keyed `"{serverId}/{channel}"`
/// and store the raw signed messages (so they can be re-verified); DMs are
/// keyed by the remote peer id.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub server: HashMap<String, Vec<SignedMessage>>,
    pub dm: HashMap<String, Vec<DmMessage>>,
}

impl History {
    pub fn push_server(&mut self, key: &str, msg: SignedMessage) {
        if !self.server.contains_key(key) && self.server.len() >= MAX_HISTORY_CONVERSATIONS {
            let oldest = self
                .server
                .iter()
                .min_by_key(|(_, messages)| messages.last().map(|message| message.ts).unwrap_or(0))
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.server.remove(&oldest);
            }
        }
        let messages = self.server.entry(key.to_string()).or_default();
        if messages.iter().any(|existing| existing.sig == msg.sig) {
            return;
        }
        messages.push(msg);
        if messages.len() > MAX_HISTORY_PER_CONVERSATION {
            let overflow = messages.len() - MAX_HISTORY_PER_CONVERSATION;
            messages.drain(0..overflow);
        }
    }

    pub fn push_dm(&mut self, peer: &str, msg: DmMessage) {
        if !self.dm.contains_key(peer) && self.dm.len() >= MAX_HISTORY_CONVERSATIONS {
            let oldest = self
                .dm
                .iter()
                .min_by_key(|(_, messages)| messages.last().map(|message| message.ts).unwrap_or(0))
                .map(|(peer, _)| peer.clone());
            if let Some(oldest) = oldest {
                self.dm.remove(&oldest);
            }
        }
        let messages = self.dm.entry(peer.to_string()).or_default();
        if !msg.id.is_empty() && messages.iter().any(|existing| existing.id == msg.id) {
            return;
        }
        messages.push(msg);
        if messages.len() > MAX_HISTORY_PER_CONVERSATION {
            let overflow = messages.len() - MAX_HISTORY_PER_CONVERSATION;
            messages.drain(0..overflow);
        }
    }

    pub fn server_messages(&self, key: &str) -> &[SignedMessage] {
        self.server.get(key).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn dm_messages(&self, peer: &str) -> &[DmMessage] {
        self.dm.get(peer).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// All signed messages across every channel of `server_id`, sorted by
    /// timestamp — the payload of a server snapshot.
    pub fn server_snapshot(&self, server_id: &str) -> Vec<SignedMessage> {
        let prefix = format!("{server_id}/");
        let mut out: Vec<SignedMessage> = self
            .server
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .flat_map(|(_, v)| v.iter().cloned())
            .collect();
        out.sort_by_key(|m| m.ts);
        out
    }
}

/// Everything that survives a restart, serialized into one sealed blob.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub sessions: Vec<(Vec<u8>, crate::crypto::session::SessionState)>,
    pub contacts: Vec<(String, Vec<u8>)>,
    pub servers: Vec<PersistedServer>,
    pub history: History,
    #[serde(default)]
    pub outbox: Vec<OutboxEntry>,
    /// Our own signed display profile, so name/avatar/about survive a
    /// restart without re-signing.
    #[serde(default)]
    pub profile: Option<SignedProfile>,
    #[serde(default)]
    pub groups: Vec<GroupDescriptor>,
}

/// The file on disk: version + salt + one sealed payload.
#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    salt: String,
    nonce: String,
    sealed: String,
}

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Default location: <config-dir>/peers/state.json
    pub fn default_path() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("peers").join("state.json")
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Unlocks the store: reads (or mints) the salt, derives the storage
    /// key from `password`, and hands back a handle that can load/save the
    /// sealed state. Fails with [`PeersError::BadPassword`] on a wrong
    /// password.
    pub fn open(&self, password: &str) -> Result<StoreHandle> {
        let salt: [u8; SALT_LEN] = if self.exists() {
            let raw = fs::read(&self.path)?;
            let file: StoreFile = serde_json::from_slice(&raw)?;
            decode(&file.salt)?
                .try_into()
                .map_err(|_| PeersError::Keystore("bad state salt".into()))?
        } else {
            let mut salt = [0u8; SALT_LEN];
            OsRng.fill_bytes(&mut salt);
            salt
        };
        let key = derive_key(password, &salt)?;
        let handle = StoreHandle {
            key,
            salt,
            path: self.path.clone(),
        };
        if !self.exists() {
            // First run: write an empty state so the salt is persisted and
            // future unlocks derive the same key.
            handle.save(&PersistedState::default())?;
        }
        Ok(handle)
    }
}

#[derive(Clone)]
pub struct StoreHandle {
    key: [u8; 32],
    salt: [u8; SALT_LEN],
    path: PathBuf,
}

impl StoreHandle {
    /// Decrypts and returns the persisted state.
    pub fn load(&self) -> Result<PersistedState> {
        let raw = fs::read(&self.path)?;
        let file: StoreFile = serde_json::from_slice(&raw)?;
        if file.version != 1 {
            return Err(PeersError::Keystore(format!(
                "state version {} is not supported",
                file.version
            )));
        }
        let nonce = decode(&file.nonce)?;
        let sealed = decode(&file.sealed)?;
        if nonce.len() != 24 || sealed.is_empty() {
            return Err(PeersError::Keystore("malformed encrypted state".into()));
        }
        let plain = self.decrypt(&nonce, &sealed)?;
        Ok(serde_json::from_slice(&plain)?)
    }

    /// Encrypts and writes `state`.
    pub fn save(&self, state: &PersistedState) -> Result<()> {
        let plain = serde_json::to_vec(state)?;
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let sealed = self.encrypt(&nonce, &plain)?;
        let file = StoreFile {
            version: 1,
            salt: encode(&self.salt),
            nonce: encode(&nonce),
            sealed: encode(&sealed),
        };
        let data = serde_json::to_vec_pretty(&file)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        atomic::write_private(&self.path, &data)?;
        Ok(())
    }

    fn encrypt(&self, nonce: &[u8; 24], plain: &[u8]) -> Result<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key));
        cipher
            .encrypt(XNonce::from_slice(nonce), plain)
            .map_err(|e| PeersError::Keystore(format!("encrypt state: {e}")))
    }

    fn decrypt(&self, nonce: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key));
        cipher
            .decrypt(XNonce::from_slice(nonce), sealed)
            .map_err(|_| PeersError::BadPassword)
    }
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let params = Params::new(KDF_MEMORY, KDF_TIME, KDF_THREADS, Some(KDF_KEY_LEN))
        .map_err(|e| PeersError::Keystore(format!("argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KDF_KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| PeersError::Keystore(format!("argon2: {e}")))?;
    Ok(key)
}

fn encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.encode(bytes)
}

fn decode(s: &str) -> Result<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD
        .decode(s)
        .map_err(|e| PeersError::Keystore(format!("decode base64: {e}")))
}

/// Convenience: export the whole `SessionDir` + servers + history + own
/// profile into a [`PersistedState`] and back.
pub fn state_from(
    dir: &SessionDir,
    servers: &[PersistedServer],
    history: &History,
    profile: &Option<SignedProfile>,
    groups: &[GroupDescriptor],
) -> PersistedState {
    let (sessions, contacts) = dir.export();
    PersistedState {
        sessions,
        contacts,
        servers: servers.to_vec(),
        history: history.clone(),
        profile: profile.clone(),
        groups: groups.to_vec(),
    }
}

pub fn state_apply(
    state: &mut SessionDir,
    identity: &crate::crypto::Identity,
    dir_servers: &mut crate::crypto::server::ServerDir,
    history: &mut History,
    persisted: &PersistedState,
) -> Result<()> {
    state.restore(identity, &persisted.sessions, &persisted.contacts);
    for p in &persisted.servers {
        dir_servers.restore(crate::crypto::server::ServerRecord::from_persisted(p)?);
    }
    *history = persisted.history.clone();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> Store {
        let dir =
            std::env::temp_dir().join(format!("peers-store-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        Store::new(dir.join("state.json"))
    }

    #[test]
    fn round_trip_with_password() {
        let store = temp_store("roundtrip");
        let handle = store.open("hunter2hunter").unwrap();
        let mut state = handle.load().unwrap();
        state.history.push_dm(
            "peer1",
            DmMessage {
                peer: "peer1".into(),
                text: "hello".into(),
                ts: 1,
                mine: true,
                sender: None,
                id: String::new(),
                attachment_name: None,
                attachment_mime: None,
                attachment_data: None,
            },
        );
        handle.save(&state).unwrap();

        let handle2 = store.open("hunter2hunter").unwrap();
        let state2 = handle2.load().unwrap();
        assert_eq!(state2.history.dm_messages("peer1").len(), 1);
    }

    #[test]
    fn wrong_password_rejected() {
        let store = temp_store("badpass");
        let handle = store.open("correct password").unwrap();
        handle.save(&PersistedState::default()).unwrap();

        // `open` derives the key; the wrong password is detected on the
        // first decrypt in `load` (mirrors the unlock flow).
        let bad = store.open("wrong password").unwrap();
        assert!(matches!(bad.load(), Err(PeersError::BadPassword)));
    }

    #[test]
    fn plaintext_never_leaks() {
        let store = temp_store("leak");
        let handle = store.open("hunter2hunter").unwrap();
        let mut state = PersistedState::default();
        state.history.push_dm(
            "sensitive-peer",
            DmMessage {
                peer: "sensitive-peer".into(),
                text: "super secret contents".into(),
                ts: 1,
                mine: true,
                sender: None,
                id: String::new(),
                attachment_name: None,
                attachment_mime: None,
                attachment_data: None,
            },
        );
        handle.save(&state).unwrap();
        let raw = fs::read_to_string(&store.path).unwrap();
        assert!(!raw.contains("super secret"));
        assert!(!raw.contains("sensitive-peer"));
    }
}
