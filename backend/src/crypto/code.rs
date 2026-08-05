use libp2p::PeerId;
use sha2::{Digest, Sha256};

/// Domain separator for code derivation. **Frozen** — changing it changes
/// everyone's code.
const CODE_DOMAIN: &[u8] = b"peers/v1/code";

/// Domain separator for the DHT rendezvous key a code resolves through.
const CODE_KEY_DOMAIN: &[u8] = b"peers/v1/code-key";

/// Number of digits in a short peer code.
pub const CODE_DIGITS: usize = 12;

/// Derives the 12-digit short code for a peer ID.
///
/// The code is a *lookup hint*, never an identity. It is deliberately short
/// enough to read aloud, which also makes it short enough to grind: an
/// attacker can search keypairs until one derives a chosen code in a few
/// GPU-hours. That is fine here and only here, because resolving a code
/// yields a full peer ID that the user verifies (name, avatar, fingerprint)
/// before accepting. Never treat a matching code as proof of identity.
pub fn short_code(peer: &PeerId) -> String {
    let mut h = Sha256::new();
    h.update(CODE_DOMAIN);
    h.update(peer.to_bytes());
    let digest = h.finalize();

    // Take 8 bytes, reduce mod 10^12. 2^64 / 10^12 ≈ 18.4M, so the modulo
    // bias across the digit space is far below anything that matters for a
    // lookup hint.
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&digest[..8]);
    let n = u64::from_be_bytes(buf) % 1_000_000_000_000u64;
    format!("{n:012}")
}

/// Formats a code for display in groups of four: `4827 1193 6052`.
pub fn format_code(code: &str) -> String {
    code.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Strips spaces, dashes and any other separator a user might type, leaving
/// bare digits. Returns `None` unless exactly [`CODE_DIGITS`] digits remain.
pub fn normalize_code(input: &str) -> Option<String> {
    let digits: String = input.chars().filter(char::is_ascii_digit).collect();
    (digits.len() == CODE_DIGITS).then_some(digits)
}

/// The DHT key a code is announced and looked up under. Peers publish
/// themselves as a provider of this key, so resolution reuses the same
/// Kademlia provider machinery as blob parking.
pub fn code_key(code: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(CODE_KEY_DOMAIN);
    h.update(code.as_bytes());
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn peer(seed: u8) -> PeerId {
        let kp = Keypair::ed25519_from_bytes([seed; 32]).unwrap();
        PeerId::from(kp.public())
    }

    #[test]
    fn code_is_twelve_digits() {
        let c = short_code(&peer(1));
        assert_eq!(c.len(), CODE_DIGITS);
        assert!(c.chars().all(|ch| ch.is_ascii_digit()), "code: {c}");
    }

    #[test]
    fn code_is_deterministic() {
        assert_eq!(short_code(&peer(9)), short_code(&peer(9)));
    }

    #[test]
    fn different_peers_get_different_codes() {
        assert_ne!(short_code(&peer(1)), short_code(&peer(2)));
    }

    #[test]
    fn formats_in_groups_of_four() {
        assert_eq!(format_code("482711936052"), "4827 1193 6052");
    }

    #[test]
    fn normalize_accepts_human_spacing() {
        assert_eq!(
            normalize_code("4827 1193 6052").unwrap(),
            "482711936052"
        );
        assert_eq!(
            normalize_code("4827-1193-6052").unwrap(),
            "482711936052"
        );
        assert_eq!(normalize_code(" 482711936052 ").unwrap(), "482711936052");
    }

    #[test]
    fn normalize_rejects_wrong_length() {
        assert!(normalize_code("4827 1193").is_none());
        assert!(normalize_code("4827119360521").is_none());
        assert!(normalize_code("").is_none());
    }

    #[test]
    fn code_key_is_stable_and_distinct() {
        let a = code_key("482711936052");
        assert_eq!(a, code_key("482711936052"));
        assert_ne!(a, code_key("482711936053"));
    }

    /// The key must not be a bare hash of the code with no domain tag, or it
    /// could collide with another namespace using the same DHT.
    #[test]
    fn code_key_is_domain_separated() {
        let bare: [u8; 32] = Sha256::digest(b"482711936052").into();
        assert_ne!(code_key("482711936052"), bare);
    }

    /// A code identifies a lookup bucket, not a person. Pin that the derived
    /// code and the peer id are not recoverable from one another.
    #[test]
    fn code_is_not_the_peer_id() {
        let p = peer(3);
        assert!(!p.to_string().contains(&short_code(&p)));
    }
}
