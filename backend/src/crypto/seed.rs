use crate::error::{PeersError, Result};
use hkdf::Hkdf;
use sha2::Sha256;

/// Domain-separation labels. **Frozen** — changing any of these changes every
/// peer ID derived from a phrase, orphaning existing identities.
const SEED_SALT: &[u8] = b"peers/v1/seed";
const ED25519_INFO: &[u8] = b"peers/v1/ed25519";
const X25519_INFO: &[u8] = b"peers/v1/x25519";

/// Derives the Ed25519 seed and X25519 secret from mnemonic entropy.
///
/// Entropy already carries 128 or 256 bits from `OsRng`, so no password
/// stretching is applied — HKDF is used here for domain separation, not for
/// hardening. The two outputs are independent: recovering one does not reveal
/// the other.
pub fn derive_keys(entropy: &[u8]) -> Result<([u8; 32], [u8; 32])> {
    if entropy.len() < 16 {
        return Err(PeersError::BadPhrase(format!(
            "entropy must be at least 16 bytes, got {}",
            entropy.len()
        )));
    }
    let hk = Hkdf::<Sha256>::new(Some(SEED_SALT), entropy);

    let mut ed = [0u8; 32];
    hk.expand(ED25519_INFO, &mut ed)
        .map_err(|e| PeersError::Identity(format!("hkdf ed25519: {e}")))?;

    let mut x = [0u8; 32];
    hk.expand(X25519_INFO, &mut x)
        .map_err(|e| PeersError::Identity(format!("hkdf x25519: {e}")))?;

    Ok((ed, x))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::identity::Identity;
    use crate::crypto::mnemonic;

    #[test]
    fn derivation_is_deterministic() {
        let e = [7u8; 16];
        let (a_ed, a_x) = derive_keys(&e).unwrap();
        let (b_ed, b_x) = derive_keys(&e).unwrap();
        assert_eq!(a_ed, b_ed);
        assert_eq!(a_x, b_x);
    }

    #[test]
    fn ed25519_and_x25519_keys_differ() {
        let (ed, x) = derive_keys(&[3u8; 32]).unwrap();
        assert_ne!(ed, x, "domain separation must produce distinct keys");
    }

    #[test]
    fn different_entropy_gives_different_keys() {
        let (a, _) = derive_keys(&[1u8; 16]).unwrap();
        let (b, _) = derive_keys(&[2u8; 16]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn same_phrase_rebuilds_same_peer_id() {
        let phrase = mnemonic::generate(12).unwrap();
        let e = mnemonic::decode(&phrase).unwrap();
        let a = Identity::from_entropy(&e).unwrap();
        let b = Identity::from_entropy(&mnemonic::decode(&phrase).unwrap()).unwrap();
        assert_eq!(a.peer_id, b.peer_id, "phrase must be the identity");
        assert_eq!(a.x25519_secret.to_bytes(), b.x25519_secret.to_bytes());
        assert_eq!(a.fingerprint().unwrap(), b.fingerprint().unwrap());
    }

    #[test]
    fn different_phrases_give_different_identities() {
        let a =
            Identity::from_entropy(&mnemonic::decode(&mnemonic::generate(12).unwrap()).unwrap())
                .unwrap();
        let b =
            Identity::from_entropy(&mnemonic::decode(&mnemonic::generate(12).unwrap()).unwrap())
                .unwrap();
        assert_ne!(a.peer_id, b.peer_id);
    }

    #[test]
    fn derived_identity_survives_marshal_round_trip() {
        let e = mnemonic::decode(&mnemonic::generate(24).unwrap()).unwrap();
        let id = Identity::from_entropy(&e).unwrap();
        let back = Identity::unmarshal(&id.marshal().unwrap()).unwrap();
        assert_eq!(back.peer_id, id.peer_id);
    }

    #[test]
    fn rejects_short_entropy() {
        assert!(derive_keys(&[0u8; 8]).is_err());
    }
}
