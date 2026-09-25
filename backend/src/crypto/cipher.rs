use crate::crypto::session::Session;
use crate::error::{PeersError, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

const ENVELOPE_V2: &[u8; 3] = b"PV2";
const ENVELOPE_V2_HEADER: usize = 3 + 16 + 8;

/// Max plaintext size of a single message (64 KiB).
const MAX_MESSAGE_SIZE: usize = 64 * 1024;

/// Encrypts `plaintext` with the session's next key and authenticates
/// `aad` (additional authenticated data, e.g. channel/context metadata).
///
/// Output envelope: `[PV2][session nonce(16)][8-byte seq][ciphertext]`.
/// The random session nonce prevents two devices restored from the same
/// recovery phrase from reusing the same key and nonce pair.
pub fn seal(session: &mut Session, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if plaintext.len() > MAX_MESSAGE_SIZE {
        return Err(PeersError::MessageTooLarge);
    }
    let (key, seq) = session.next_key_with_nonce()?;
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

    let mut out = Vec::with_capacity(ENVELOPE_V2_HEADER + ct.len());
    out.extend_from_slice(ENVELOPE_V2);
    out.extend_from_slice(&session.outbound_nonce_for_envelope());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypts a `seal`-produced envelope. `aad` must match exactly. Key
/// derivation is stateless with respect to the sequence, so failed opens
/// never corrupt session state; successful opens are recorded for replay
/// detection.
pub fn open(session: &mut Session, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    let (seq, key, body) = if sealed.starts_with(ENVELOPE_V2) {
        if sealed.len() < ENVELOPE_V2_HEADER + 16 {
            return Err(PeersError::BadCipher);
        }
        let session_nonce: [u8; 16] = sealed[3..19].try_into().map_err(|_| PeersError::BadCipher)?;
        let seq = u64::from_be_bytes(sealed[19..27].try_into().map_err(|_| PeersError::BadCipher)?);
        let key = session.incoming_key_at_with_nonce(seq, session_nonce)?;
        (seq, key, &sealed[ENVELOPE_V2_HEADER..])
    } else {
        if sealed.len() < 8 + 16 {
            return Err(PeersError::BadCipher);
        }
        let seq = u64::from_be_bytes(sealed[..8].try_into().map_err(|_| PeersError::BadCipher)?);
        let key = session.incoming_key_at(seq)?;
        (seq, key, &sealed[8..])
    };
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nf = nonce_for(seq);
    let nonce = Nonce::from_slice(&nf);
    let payload = Payload {
        msg: body,
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
        let a_pub = XPublic::from(&a).to_bytes();
        let b_pub = XPublic::from(&b).to_bytes();
        (a, b, a_pub, b_pub)
    }

    #[test]
    fn envelope_has_seq_prefix() {
        let (a, _, _, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let env = seal(&mut sa, b"", b"x").unwrap();
        assert_eq!(&env[..3], b"PV2");
        assert_eq!(&env[19..27], &0u64.to_be_bytes());
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
