use crate::error::{PeersError, Result};
use libp2p::identity::Keypair;
use libp2p::PeerId;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as XPublic, StaticSecret};

/// The node's cryptographic identity: an Ed25519 keypair that derives the
/// peer ID (the "crypto hash" other peers know us by) plus an X25519
/// keypair used for ECDH key agreement in DM sessions.
#[derive(Clone)]
pub struct Identity {
    pub keypair: Keypair,
    pub x25519_secret: StaticSecret,
    pub peer_id: PeerId,
}

impl Identity {
    /// Generates a fresh identity.
    pub fn new() -> Result<Self> {
        let keypair = Keypair::generate_ed25519();
        let peer_id = PeerId::from(keypair.public());
        let x25519_secret = StaticSecret::random_from_rng(OsRng);
        Ok(Self {
            keypair,
            x25519_secret,
            peer_id,
        })
    }

    /// The X25519 public key (32 bytes).
    pub fn x25519_public(&self) -> [u8; 32] {
        XPublic::from(&self.x25519_secret).to_bytes()
    }

    /// Raw Ed25519 public key bytes.
    pub fn ed25519_public(&self) -> Result<[u8; 32]> {
        self.ed25519_raw()
    }

    /// Raw Ed25519 public key bytes.
    fn ed25519_raw(&self) -> Result<[u8; 32]> {
        self.keypair
            .public()
            .try_into_ed25519()
            .map(|pk| pk.to_bytes())
            .map_err(|_| PeersError::Identity("expected ed25519 public key".into()))
    }

    /// Serializes the identity: [protobuf-encoded ed25519 keypair][x25519 secret].
    /// The output is sensitive and must be sealed before hitting disk.
    pub fn marshal(&self) -> Result<Vec<u8>> {
        let key_bytes = self
            .keypair
            .to_protobuf_encoding()
            .map_err(|e| PeersError::Identity(format!("marshal keypair: {e}")))?;
        let mut out = Vec::with_capacity(key_bytes.len() + 32);
        out.extend_from_slice(&key_bytes);
        out.extend_from_slice(&self.x25519_secret.to_bytes());
        Ok(out)
    }

    /// Restores an identity from `marshal` output.
    pub fn unmarshal(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 33 {
            return Err(PeersError::Identity("blob too short".into()));
        }
        let (key_bytes, secret_bytes) = bytes.split_at(bytes.len() - 32);
        let keypair = Keypair::from_protobuf_encoding(key_bytes)
            .map_err(|e| PeersError::Identity(format!("unmarshal keypair: {e}")))?;
        let secret: [u8; 32] = secret_bytes
            .try_into()
            .map_err(|_| PeersError::Identity("x25519 secret has wrong length".into()))?;
        let peer_id = PeerId::from(keypair.public());
        Ok(Self {
            keypair,
            x25519_secret: StaticSecret::from(secret),
            peer_id,
        })
    }

    /// SHA-256 of both public keys, base32-encoded in groups of 4. Must
    /// match out-of-band between two peers to rule out a man-in-the-middle.
    pub fn fingerprint(&self) -> Result<String> {
        let ed = self.ed25519_raw()?;
        let mut h = Sha256::new();
        h.update(ed);
        h.update(self.x25519_public());
        let digest = h.finalize();
        let b32 = base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &digest)
            .to_ascii_uppercase();
        let bytes = b32.as_bytes();
        let mut out = String::with_capacity(bytes.len() + bytes.len() / 4);
        for (i, chunk) in bytes.chunks(4).enumerate() {
            if i > 0 {
                out.push(' ');
            }
            out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        }
        Ok(out)
    }

    /// Compact "XXXX…XXXX" form of the fingerprint.
    pub fn fingerprint_short(&self) -> Result<String> {
        let plain = self.fingerprint()?.replace(' ', "");
        if plain.chars().count() <= 12 {
            return Ok(plain);
        }
        let start: String = plain.chars().take(4).collect();
        let end: String = plain
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        Ok(format!("{start}…{end}"))
    }

    /// Conventional short form of the peer ID.
    pub fn peer_id_short(&self) -> String {
        let s = self.peer_id.to_string();
        let chars: Vec<char> = s.chars().collect();
        if chars.len() <= 12 {
            return s;
        }
        let start: String = chars[..8].iter().collect();
        let end: String = chars[chars.len() - 4..].iter().collect();
        format!("{start}…{end}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base32::Alphabet;

    #[test]
    fn identity_round_trip() {
        let id = Identity::new().unwrap();
        let blob = id.marshal().unwrap();
        let got = Identity::unmarshal(&blob).unwrap();
        assert_eq!(got.peer_id, id.peer_id);
        assert_eq!(got.x25519_secret.to_bytes(), id.x25519_secret.to_bytes());
        assert_eq!(got.fingerprint().unwrap(), id.fingerprint().unwrap());
    }

    #[test]
    fn fingerprint_format() {
        let id = Identity::new().unwrap();
        let fp = id.fingerprint().unwrap();
        let plain = fp.replace(' ', "");
        assert_eq!(plain.len(), 52, "SHA-256 → 52 base32 chars");
        let decoded = base32::decode(Alphabet::Rfc4648 { padding: false }, &plain).unwrap();
        assert_eq!(decoded.len(), 32);
        assert_eq!(id.fingerprint_short().unwrap().chars().count(), 9);
    }

    #[test]
    fn two_identities_differ() {
        let a = Identity::new().unwrap();
        let b = Identity::new().unwrap();
        assert_ne!(a.peer_id, b.peer_id);
    }
}
