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

/// Stores the identity sealed with a password-derived key (Argon2id →
/// XChaCha20-Poly1305). The plaintext identity never touches disk.
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

    /// Generates a new identity and seals it with the password.
    pub fn create(&self, password: &str) -> Result<Identity> {
        let id = Identity::new()?;
        let blob = id.marshal()?;
        self.seal(&blob, password)?;
        Ok(id)
    }

    /// Restores the identity if the password is correct.
    pub fn load(&self, password: &str) -> Result<Identity> {
        let blob = self.open(password)?;
        Identity::unmarshal(&blob)
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Re-seals the identity with a new password.
    pub fn change_password(&self, old: &str, new: &str) -> Result<()> {
        let blob = self.open(old)?;
        self.seal(&blob, new)
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
            version: 1,
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
        if file.kdf.name != KDF_NAME {
            return Err(PeersError::Keystore(format!(
                "unsupported kdf {}",
                file.kdf.name
            )));
        }
        let salt = base64_decode(&file.kdf.salt)?;
        let nonce = base64_decode(&file.kdf.nonce)?;
        let sealed = base64_decode(&file.kdf.sealed)?;

        let params = Params::new(file.kdf.memory, file.kdf.time, file.kdf.threads, Some(KDF_KEY_LEN))
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

    #[test]
    fn create_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("peers-keystore-test-{}", std::process::id()));
        let path = dir.join("identity.json");
        let ks = Keystore::new(path.clone());
        let id = ks.create("correct horse battery staple").unwrap();

        let loaded = ks.load("correct horse battery staple").unwrap();
        assert_eq!(loaded.peer_id, id.peer_id);

        assert!(matches!(ks.load("wrong password"), Err(PeersError::BadPassword)));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "keystore must be 0600");
        }

        // File must not leak identity plaintext.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&id.peer_id.to_string()), "peer id leaked");
        assert!(!raw.contains(&id.x25519_secret.to_bytes()[..]), "x25519 secret leaked");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn change_password() {
        let dir = std::env::temp_dir().join(format!("peers-keystore-test2-{}", std::process::id()));
        let path = dir.join("identity.json");
        let ks = Keystore::new(path.clone());
        let id = ks.create("old-pass").unwrap();
        ks.change_password("old-pass", "new-pass").unwrap();
        let loaded = ks.load("new-pass").unwrap();
        assert_eq!(loaded.peer_id, id.peer_id);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_keystore() {
        let ks = Keystore::new(PathBuf::from("/nonexistent/peers/id.json"));
        assert!(matches!(ks.load("x"), Err(PeersError::NoKeystore)));
    }
}
