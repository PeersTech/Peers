use crate::crypto::session::Session;
use crate::error::{PeersError, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

/// Max plaintext size of a single message (64 KiB).
const MAX_MESSAGE_SIZE: usize = 64 * 1024;

/// Encrypts `plaintext` with the session's next key and authenticates
/// `aad` (additional authenticated data, e.g. channel/context metadata).
///
/// Output envelope: `[8-byte big-endian seq][nonce(12) || ct+tag]`.
/// On success the session counter advances by one.
pub fn seal(session: &mut Session, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if plaintext.len() > MAX_MESSAGE_SIZE {
        return Err(PeersError::MessageTooLarge);
    }
    let seq = session.counter;
    let key = session.next_key()?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nf = nonce_for(seq);
    let nonce = Nonce::from_slice(&nf);
    let payload = Payload {
        msg: plaintext,
        aad,
    };
    let ct = cipher
        .encrypt(nonce, payload)
        .map_err(|e| PeersError::Crypto(format!("encrypt: {e}")))?;

    let mut out = Vec::with_capacity(8 + ct.len());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypts a `seal`-produced envelope. `aad` must match exactly. Key
/// derivation is stateless with respect to the sequence, so failed opens
/// never corrupt session state; successful opens are recorded for replay
/// detection.
pub fn open(session: &mut Session, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < 8 + 16 {
        return Err(PeersError::BadCipher);
    }
    let seq = u64::from_be_bytes(sealed[..8].try_into().map_err(|_| PeersError::BadCipher)?);
    let key = session.key_at(seq)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nf = nonce_for(seq);
    let nonce = Nonce::from_slice(&nf);
    let payload = Payload {
        msg: &sealed[8..],
        aad,
    };
    let pt = cipher
        .decrypt(nonce, payload)
        .map_err(|_| PeersError::BadCipher)?;
    if session.check_replay(seq) {
        return Err(PeersError::Replay);
    }
    session.mark_opened(seq);
    Ok(pt)
}

/// Deterministic 12-byte nonce for sequence `n`: 4 zero bytes + seq.
pub fn nonce_for(n: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&n.to_be_bytes());
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use x25519_dalek::{PublicKey as XPublic, StaticSecret};

    fn pair() -> (StaticSecret, StaticSecret, [u8; 32], [u8; 32]) {
        let a = StaticSecret::random_from_rng(OsRng);
        let b = StaticSecret::random_from_rng(OsRng);
        (
            a,
            b,
            XPublic::from(&a).to_bytes(),
            XPublic::from(&b).to_bytes(),
        )
    }

    #[test]
    fn envelope_has_seq_prefix() {
        let (a, _, _, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let env = seal(&mut sa, b"", b"x").unwrap();
        assert_eq!(&env[..8], &0u64.to_be_bytes());
    }

    #[test]
    fn message_too_large() {
        let (a, _, _, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let big = vec![0u8; MAX_MESSAGE_SIZE + 1];
        assert!(matches!(
            seal(&mut sa, b"", &big),
            Err(PeersError::MessageTooLarge)
        ));
    }
}
