use crate::error::{PeersError, Result};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use x25519_dalek::{PublicKey as XPublic, StaticSecret};

/// Maximum gap between message sequence numbers we are willing to skip
/// forward; guards against a hostile peer forcing unbounded SHA-256 chains.
pub const MAX_SESSION_GAP: u64 = 100_000;

/// Bounds the set of opened sequence numbers kept for replay detection.
const REPLAY_WINDOW: u64 = 4096;

/// Per-contact E2E key derivation state. Both parties derive the same
/// sequence of message keys from the X25519 ECDH shared secret:
///
/// ```text
/// chain_0 = root                    (HKDF of the ECDH secret)
/// chain_n = SHA-256^n(root)
/// key_n   = HKDF(chain_n, salt=n)
/// ```
///
/// Deriving a key is a pure function of n (up to MAX_SESSION_GAP), which
/// makes out-of-order delivery and retries cheap. Replay protection is
/// enforced with a bounded set of opened sequence numbers. Memory-only.
/// Plain-text serializable snapshot of a [`Session`]'s state, used to
/// persist per-contact E2E state between restarts. `opened` is the replay
/// window (kept bounded, like the in-memory set).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SessionState {
    pub root: [u8; 32],
    pub counter: u64,
    pub opened: Vec<u64>,
    pub max_opened: u64,
}

#[derive(Clone)]
pub struct Session {
    root: [u8; 32],
    /// Next outgoing sequence number.
    pub counter: u64,
    opened: HashSet<u64>,
    max_opened: u64,
}

impl Session {
    /// Snapshots the session so it can be sealed to disk and restored.
    pub fn export(&self) -> SessionState {
        let mut opened: Vec<u64> = self.opened.iter().copied().collect();
        opened.sort_unstable();
        SessionState {
            root: self.root,
            counter: self.counter,
            opened,
            max_opened: self.max_opened,
        }
    }

    /// Restores a session from a snapshot (see [`Session::export`]).
    pub fn import(state: &SessionState) -> Self {
        Self {
            root: state.root,
            counter: state.counter,
            opened: state.opened.iter().copied().collect(),
            max_opened: state.max_opened,
        }
    }
}

impl Session {
    /// Derives a shared session from our X25519 secret and the other
    /// party's X25519 public key. Both parties must pass the same two
    /// public keys (canonical order) to obtain identical state.
    pub fn new(our_secret: &StaticSecret, their_pub: [u8; 32]) -> Result<Self> {
        let their_pk = XPublic::from(their_pub);
        let shared = our_secret.diffie_hellman(&their_pk);

        let our_pub = XPublic::from(our_secret).to_bytes();
        let (canon_a, canon_b) = if their_pub < our_pub {
            (their_pub, our_pub)
        } else {
            (our_pub, their_pub)
        };
        let mut salt_hasher = Sha256::new();
        salt_hasher.update(canon_a);
        salt_hasher.update(canon_b);
        let salt = salt_hasher.finalize();

        let (_, root_hkdf) = Hkdf::<Sha256>::extract(Some(&salt), shared.as_bytes());
        let mut root = [0u8; 32];
        root_hkdf
            .expand(b"peers/v1/root", &mut root)
            .map_err(|e| PeersError::Crypto(format!("hkdf root: {e}")))?;

        Ok(Self {
            root,
            counter: 0,
            opened: HashSet::new(),
            max_opened: 0,
        })
    }

    /// Key for the next outgoing message, then advances the counter.
    pub fn next_key(&mut self) -> Result<[u8; 32]> {
        let key = self.key_at(self.counter)?;
        self.counter += 1;
        Ok(key)
    }

    /// Key for message `n`. Pure with respect to `n` — does not mutate
    /// state, so failed opens and out-of-order deliveries are harmless.
    pub fn key_at(&self, n: u64) -> Result<[u8; 32]> {
        if n > MAX_SESSION_GAP {
            return Err(PeersError::GapTooLarge);
        }
        let chain = self.chain_at(n);
        let (_, hk) = Hkdf::<Sha256>::extract(Some(&n.to_be_bytes()), &chain);
        let mut key = [0u8; 32];
        hk.expand(b"peers/v1/msg", &mut key)
            .map_err(|e| PeersError::Crypto(format!("hkdf message key: {e}")))?;
        Ok(key)
    }

    /// chain_n = SHA-256^n(root).
    fn chain_at(&self, n: u64) -> [u8; 32] {
        let mut chain = self.root;
        for _ in 0..n {
            chain = Sha256::digest(chain).into();
        }
        chain
    }

    /// Whether sequence `n` is a replay: already opened, or too old to be
    /// a plausible network reorder.
    pub fn check_replay(&self, n: u64) -> bool {
        if self.max_opened > REPLAY_WINDOW && n < self.max_opened - REPLAY_WINDOW {
            return true;
        }
        self.opened.contains(&n)
    }

    /// Records a successfully opened sequence number, evicting entries
    /// outside the replay window.
    pub fn mark_opened(&mut self, n: u64) {
        self.opened.insert(n);
        self.max_opened = self.max_opened.max(n);
        self.opened
            .retain(|&k| k + REPLAY_WINDOW >= self.max_opened);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::cipher::{open, seal};

    fn pair() -> (StaticSecret, StaticSecret, [u8; 32], [u8; 32]) {
        let a = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let b = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let a_pub = XPublic::from(&a).to_bytes();
        let b_pub = XPublic::from(&b).to_bytes();
        (a, b, a_pub, b_pub)
    }

    #[test]
    fn both_sides_match() {
        let (a, b, a_pub, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let sb = Session::new(&b, a_pub).unwrap();
        for i in 0..25u64 {
            let ka = sa.next_key().unwrap();
            let kb = sb.key_at(i).unwrap();
            assert_eq!(ka, kb, "key mismatch at seq {i}");
        }
    }

    #[test]
    fn mirror_order() {
        let (a, b, a_pub, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let mut sb = Session::new(&b, a_pub).unwrap();
        for i in 0..5u64 {
            let env = seal(&mut sa, b"ctx", format!("hello {i}").as_bytes()).unwrap();
            let pt = open(&mut sb, b"ctx", &env).unwrap();
            assert_eq!(pt, format!("hello {i}").as_bytes());
        }
    }

    #[test]
    fn aad_mismatch_then_correct() {
        let (a, b, a_pub, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let mut sb = Session::new(&b, a_pub).unwrap();
        let env = seal(&mut sa, b"channel/general", b"secret").unwrap();
        assert!(matches!(
            open(&mut sb, b"channel/other", &env),
            Err(PeersError::BadCipher)
        ));
        let pt = open(&mut sb, b"channel/general", &env).unwrap();
        assert_eq!(pt, b"secret");
    }

    #[test]
    fn tamper_detected_and_rolled_back() {
        let (a, b, a_pub, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let mut sb = Session::new(&b, a_pub).unwrap();
        let mut env = seal(&mut sa, b"", b"do not touch").unwrap();
        let last = env.len() - 1;
        env[last] ^= 0xff;
        assert!(matches!(
            open(&mut sb, b"", &env),
            Err(PeersError::BadCipher)
        ));
        let env_ok = seal(&mut sa, b"", b"do not touch").unwrap();
        let pt = open(&mut sb, b"", &env_ok).unwrap();
        assert_eq!(pt, b"do not touch");
    }

    #[test]
    fn replay_rejected() {
        let (a, b, a_pub, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let mut sb = Session::new(&b, a_pub).unwrap();
        let env = seal(&mut sa, b"", b"first").unwrap();
        open(&mut sb, b"", &env).unwrap();
        assert!(matches!(open(&mut sb, b"", &env), Err(PeersError::Replay)));
    }

    #[test]
    fn out_of_order_within_gap() {
        let (a, b, a_pub, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let mut sb = Session::new(&b, a_pub).unwrap();
        let mut envs = Vec::new();
        for i in 0..5u64 {
            envs.push(seal(&mut sa, b"", &[i as u8]).unwrap());
        }
        for i in [1usize, 3, 2, 4] {
            let pt = open(&mut sb, b"", &envs[i]).unwrap();
            assert_eq!(pt, [i as u8]);
        }
    }

    #[test]
    fn gap_too_large() {
        let s = Session {
            root: [0u8; 32],
            counter: 0,
            opened: HashSet::new(),
            max_opened: 0,
        };
        assert!(matches!(
            s.key_at(MAX_SESSION_GAP + 5),
            Err(PeersError::GapTooLarge)
        ));
        assert_eq!(s.key_at(10).unwrap().len(), 32);
    }

    #[test]
    fn key_at_is_pure() {
        let (a, b, a_pub, b_pub) = pair();
        let mut sa = Session::new(&a, b_pub).unwrap();
        let mut sb = Session::new(&b, a_pub).unwrap();
        let k1 = sb.key_at(4).unwrap();
        for _ in 0..3 {
            let env = seal(&mut sa, b"", b"payload").unwrap();
            open(&mut sb, b"", &env).unwrap();
        }
        let k2 = sb.key_at(4).unwrap();
        assert_eq!(k1, k2);
    }
}
