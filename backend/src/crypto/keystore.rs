use crate::crypto::identity::Identity;
use crate::error::{PeersError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const KDF_NAME: &str = "argon2id";
const KDF_TIME: u32 = 3;
const KDF_MEMORY: u32 = 64 * 1024; // 64 MiB
const KDF_THREADS: u32 = 4;
const KDF_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;

/// Keystore format version. v1 (random key, password-sealed) is refused: its
/// identity was never derived from a phrase, so no phrase can recover it.
const VERSION: u32 = 2;

#[derive(Serialize, Deserialize)]
struct KdfParams {
    name: String,
    salt: String,
    time: u32,
    memory: u32,
    threads: u32,
}

#[derive(Serialize, Deserialize)]
struct KeystoreFile {
    version: u32,
    kdf: KdfParams,
    nonce: String,
    sealed: String,
}

/// Stores the identity sealed with a phrase-derived key (Argon2id →
/// XChaCha20-Poly1305). The plaintext identity never touches disk.
///
/// Since M16 the keystore is a *cache*, not the source of truth: the recovery
/// phrase both seals the file and derives the identity inside it, so deleting
/// the file is recoverable and losing the phrase is not.
pub struct Keystore {
    pub path: PathBuf,
}

impl Keystore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Default location: <config-dir>/peers/identity.json
    pub fn default_path() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("peers").join("identity.json")
    }

    /// Derives the identity from `phrase` and seals it with that same phrase.
    /// Idempotent: one phrase always yields one identity, so calling this
    /// again after the file is lost recovers the original peer ID.
    pub fn create_from_phrase(&self, phrase: &str) -> Result<Identity> {
        let entropy = crate::crypto::mnemonic::decode(phrase)?;
        let id = Identity::from_entropy(&entropy)?;
        let blob = id.marshal()?;
        self.seal(&blob, phrase)?;
        Ok(id)
    }

    /// Restores the identity if the phrase is correct.
    pub fn load(&self, phrase: &str) -> Result<Identity> {
        let blob = self.open(phrase)?;
        Identity::unmarshal(&blob)
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    fn seal(&self, blob: &[u8], password: &str) -> Result<()> {
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);

        let params = Params::new(KDF_MEMORY, KDF_TIME, KDF_THREADS, Some(KDF_KEY_LEN))
            .map_err(|e| PeersError::Keystore(format!("argon2 params: {e}")))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = [0u8; KDF_KEY_LEN];
        argon2
            .hash_password_into(password.as_bytes(), &salt, &mut key)
            .map_err(|e| PeersError::Keystore(format!("argon2: {e}")))?;

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let sealed = cipher
            .encrypt(XNonce::from_slice(&nonce), blob)
            .map_err(|e| PeersError::Keystore(format!("encrypt: {e}")))?;

        let file = KeystoreFile {
            version: VERSION,
            kdf: KdfParams {
                name: KDF_NAME.into(),
                salt: base64_encode(&salt),
                time: KDF_TIME,
                memory: KDF_MEMORY,
                threads: KDF_THREADS,
            },
            nonce: base64_encode(&nonce),
            sealed: base64_encode(&sealed),
        };
        let data = serde_json::to_vec_pretty(&file)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&self.path, data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn open(&self, password: &str) -> Result<Vec<u8>> {
        if !self.path.exists() {
            return Err(PeersError::NoKeystore);
        }
        let data = fs::read(&self.path)?;
        let file: KeystoreFile = serde_json::from_slice(&data)?;
        if file.version < VERSION {
            return Err(PeersError::StaleKeystore);
        }
        if file.version > VERSION {
            return Err(PeersError::Keystore(format!(
                "keystore version {} is newer than this build supports",
                file.version
            )));
        }
        if file.kdf.name != KDF_NAME {
            return Err(PeersError::Keystore(format!(
                "unsupported kdf {}",
                file.kdf.name
            )));
        }
        let salt = base64_decode(&file.kdf.salt)?;
        let nonce = base64_decode(&file.nonce)?;
        let sealed = base64_decode(&file.sealed)?;
        if salt.len() != SALT_LEN || nonce.len() != 24 || sealed.is_empty() {
            return Err(PeersError::Keystore("malformed encrypted file".into()));
        }

        let params = Params::new(
            file.kdf.memory,
            file.kdf.time,
            file.kdf.threads,
            Some(KDF_KEY_LEN),
        )
        .map_err(|e| PeersError::Keystore(format!("argon2 params: {e}")))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = [0u8; KDF_KEY_LEN];
        argon2
            .hash_password_into(password.as_bytes(), &salt, &mut key)
            .map_err(|e| PeersError::Keystore(format!("argon2: {e}")))?;

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
        cipher
            .decrypt(XNonce::from_slice(&nonce), sealed.as_ref())
            .map_err(|_| PeersError::BadPassword)
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.encode(bytes)
}

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD
        .decode(s)
        .map_err(|e| PeersError::Keystore(format!("decode base64: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::mnemonic;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("peers-ks-{}-{}", tag, std::process::id()))
            .join("identity.json")
    }

    #[test]
    fn create_load_round_trip() {
        let path = temp_path("roundtrip");
        let ks = Keystore::new(path.clone());
        let phrase = mnemonic::generate(12).unwrap();
        let id = ks.create_from_phrase(&phrase).unwrap();

        let loaded = ks.load(&phrase).unwrap();
        assert_eq!(loaded.peer_id, id.peer_id);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "keystore must be 0600");
        }

        // File must not leak identity plaintext.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&id.peer_id.to_string()), "peer id leaked");
        assert!(
            !raw.contains(&base64_encode(&id.x25519_secret.to_bytes())),
            "x25519 secret leaked"
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn phrase_seals_and_reopens() {
        let path = temp_path("phrase");
        let ks = Keystore::new(path.clone());
        let phrase = mnemonic::generate(12).unwrap();

        let created = ks.create_from_phrase(&phrase).unwrap();
        let loaded = ks.load(&phrase).unwrap();
        assert_eq!(loaded.peer_id, created.peer_id);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn wrong_phrase_rejected() {
        let path = temp_path("wrongphrase");
        let ks = Keystore::new(path.clone());
        ks.create_from_phrase(&mnemonic::generate(12).unwrap())
            .unwrap();

        let other = mnemonic::generate(12).unwrap();
        assert!(matches!(ks.load(&other), Err(PeersError::BadPassword)));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The whole point of M16: delete the keystore, keep the phrase, and the
    /// same peer ID comes back.
    #[test]
    fn identity_is_recoverable_without_the_file() {
        let path = temp_path("recover");
        let ks = Keystore::new(path.clone());
        let phrase = mnemonic::generate(12).unwrap();
        let original = ks.create_from_phrase(&phrase).unwrap();

        fs::remove_file(&path).unwrap();
        assert!(!ks.exists());

        let recovered = ks.create_from_phrase(&phrase).unwrap();
        assert_eq!(recovered.peer_id, original.peer_id);
        assert_eq!(
            recovered.x25519_secret.to_bytes(),
            original.x25519_secret.to_bytes()
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn version_1_keystore_is_refused() {
        let path = temp_path("v1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy = r#"{"version":1,"kdf":{"name":"argon2id","salt":"AAAA","time":3,
                         "memory":65536,"threads":4},"nonce":"AAAA","sealed":"AAAA"}"#;
        fs::write(&path, legacy).unwrap();

        let ks = Keystore::new(path.clone());
        assert!(matches!(ks.load("anything"), Err(PeersError::StaleKeystore)));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn file_never_contains_the_phrase() {
        let path = temp_path("leak");
        let ks = Keystore::new(path.clone());
        let phrase = mnemonic::generate(12).unwrap();
        ks.create_from_phrase(&phrase).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        for word in phrase.split_whitespace() {
            assert!(
                !raw.contains(word),
                "phrase word leaked into keystore: {word}"
            );
        }

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_keystore() {
        let ks = Keystore::new(PathBuf::from("/nonexistent/peers/id.json"));
        assert!(matches!(ks.load("x"), Err(PeersError::NoKeystore)));
    }
}
