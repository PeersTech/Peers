# Backend Hardening Implementation Plan — Seed-Phrase Identity, Node Visibility, Capacity Caps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the random-key + password keystore with a deterministic
seed-phrase identity (M16), expose real network state to the UI, and finish M12's
capacity caps and tiered relaying — all verified by `cargo test` in CI.

**Architecture:** A BIP39-style 12/24-word mnemonic is the single source of truth
for identity. Entropy → HKDF-SHA256 with per-algorithm domain separation →
Ed25519 (peer ID) + X25519 (ECDH) keys. The on-disk keystore keeps its existing
Argon2id + XChaCha20-Poly1305 sealing but is demoted to a *cache*: the phrase
re-derives the same identity on any machine, so losing the file is recoverable
and losing the phrase is not. Keystore version bumps 1 → 2; version 1 files are
refused with a clear message (clean break, decided 2026-08-04).

**Tech Stack:** Rust, libp2p 0.56, `sha2`/`hkdf` (already vendored), `argon2`,
`chacha20poly1305`, `x25519-dalek`, Tauri 2. No new crates except a vendored
BIP39 English wordlist as a plain text asset.

## Global Constraints

- **UI work is deferred.** This phase adds only the minimum frontend needed to
  drive the new backend commands. No theme work, no restructure — those move to
  a later phase (user direction, 2026-08-04).
- **No local `cargo test`.** Dev machine is 4 cores / 3.7 GB RAM and swaps when
  linking this tree. All Rust verification happens in GitHub Actions.
  `cargo check` locally is acceptable when a fast signal is needed.
- **CI gates every task:** `cargo fmt --check`, `cargo clippy -D warnings`,
  `cargo test`, frontend build, Windows/macOS `cargo check`.
- **rustfmt `max_width = 100`** — matches commit b921de5.
- **No secret material in logs, events, or `Debug` output.** Mnemonics and secret
  keys must never cross the Tauri boundary except where a task explicitly says so
  (`generate_phrase`, which returns the phrase exactly once for the user to record).
- **Domain-separation strings are frozen once shipped.** `peers/v1/seed`,
  `peers/v1/ed25519`, `peers/v1/x25519` — changing any of them changes every
  derived peer ID.

---

## File Structure

**Create:**
- `backend/src/crypto/mnemonic.rs` — wordlist, entropy ↔ phrase, checksum
- `backend/src/crypto/wordlist.txt` — vendored BIP39 English list (2048 words)
- `backend/src/crypto/seed.rs` — entropy → Ed25519 + X25519 key derivation
- `docs/running-a-node.md` — M13 deployment guide

**Modify:**
- `backend/src/crypto/mod.rs` — register `mnemonic`, `seed`
- `backend/src/crypto/identity.rs` — add `Identity::from_entropy`
- `backend/src/crypto/keystore.rs` — version 2, `create_from_phrase`, reject v1
- `backend/src/error.rs` — add `BadPhrase`, `StaleKeystore`
- `backend/src/p2p/mod.rs` — track relay reservations + external addrs
- `backend/src/p2p/behaviour.rs` — capacity caps by role
- `backend/src/lib.rs` — `generate_phrase`, `init_from_phrase`, `net_status` commands
- `backend/src/node.rs` — headless node uses seed identity
- `frontend/src/lib/api.ts` — bindings for the three new commands
- `frontend/src/App.tsx` — minimal seed onboarding + status line
- `README.md`, `PLAN.md` — mark M12/M13/M16 done

---

### Task 1: Vendor the BIP39 wordlist

**Files:**
- Create: `backend/src/crypto/wordlist.txt`
- Create: `backend/src/crypto/mnemonic.rs`
- Modify: `backend/src/crypto/mod.rs`

**Interfaces:**
- Consumes: nothing
- Produces: `crypto::mnemonic::WORDS: [&str; 2048]`

- [ ] **Step 1: Download the wordlist**

```bash
curl -fsSL -o backend/src/crypto/wordlist.txt \
  https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt
wc -l backend/src/crypto/wordlist.txt   # expect 2048
```

If the network is unavailable, any BIP39 English `english.txt` works — the test
in Step 2 pins the properties that matter.

- [ ] **Step 2: Write the failing test**

Create `backend/src/crypto/mnemonic.rs`:

```rust
/// The BIP39 English wordlist: 2048 words, sorted, unique, each uniquely
/// identified by its first four characters.
pub static WORDS: [&str; 2048] = include_wordlist();

const fn include_wordlist() -> [&'static str; 2048] {
    // Placeholder — replaced in Step 4.
    [""; 2048]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist_is_wellformed() {
        assert_eq!(WORDS.len(), 2048);
        assert_eq!(WORDS[0], "abandon");
        assert_eq!(WORDS[2047], "zoo");
        for pair in WORDS.windows(2) {
            assert!(pair[0] < pair[1], "wordlist must be sorted: {pair:?}");
        }
        for w in WORDS.iter() {
            assert!(w.len() >= 3, "word too short: {w}");
            assert!(w.is_ascii(), "non-ascii word: {w}");
        }
    }
}
```

Register the module in `backend/src/crypto/mod.rs` by adding `pub mod mnemonic;`.

- [ ] **Step 3: Run the test to verify it fails**

Push to a branch and let CI run, or `cargo test -p peers mnemonic` if checking locally.
Expected: FAIL — `assert_eq!(WORDS[0], "abandon")` fails against the `[""; 2048]` placeholder.

- [ ] **Step 4: Implement**

Replace the placeholder with a real parse of the vendored file:

```rust
use std::sync::OnceLock;

const RAW: &str = include_str!("wordlist.txt");

/// The BIP39 English wordlist: 2048 sorted, unique ASCII words.
pub fn words() -> &'static [&'static str; 2048] {
    static WORDS: OnceLock<[&'static str; 2048]> = OnceLock::new();
    WORDS.get_or_init(|| {
        let v: Vec<&str> = RAW.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let boxed: Box<[&str; 2048]> = v
            .into_boxed_slice()
            .try_into()
            .expect("wordlist.txt must contain exactly 2048 words");
        *boxed
    })
}
```

Update the test to call `words()` instead of the `WORDS` constant, keeping every
assertion. A `const fn` cannot parse at compile time, so `OnceLock` is the
simplest correct approach.

- [ ] **Step 5: Run the test to verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/crypto/wordlist.txt backend/src/crypto/mnemonic.rs backend/src/crypto/mod.rs
git commit -m "feat(crypto): vendor BIP39 English wordlist"
```

---

### Task 2: Mnemonic encode/decode with checksum

**Files:**
- Modify: `backend/src/crypto/mnemonic.rs`
- Modify: `backend/src/error.rs`

**Interfaces:**
- Consumes: `words()` from Task 1
- Produces:
  - `pub fn encode(entropy: &[u8]) -> Result<String>` — 16 bytes → 12 words, 32 bytes → 24 words
  - `pub fn decode(phrase: &str) -> Result<Vec<u8>>` — inverse, verifies checksum
  - `pub fn generate(words_count: usize) -> Result<String>` — 12 or 24 words from `OsRng`
  - `PeersError::BadPhrase(String)`

- [ ] **Step 1: Add the error variant**

In `backend/src/error.rs`, add to the `PeersError` enum:

```rust
    #[error("invalid recovery phrase: {0}")]
    BadPhrase(String),
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/src/crypto/mnemonic.rs`:

```rust
#[cfg(test)]
mod encode_tests {
    use super::*;

    /// The canonical BIP39 all-zeros vector — pins our bit packing and
    /// checksum against the reference implementation.
    #[test]
    fn bip39_zero_vector() {
        let phrase = encode(&[0u8; 16]).unwrap();
        assert_eq!(
            phrase,
            "abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon about"
        );
    }

    #[test]
    fn bip39_zero_vector_256() {
        let phrase = encode(&[0u8; 32]).unwrap();
        assert!(phrase.starts_with("abandon abandon"));
        assert_eq!(phrase.split_whitespace().count(), 24);
        assert_eq!(phrase.split_whitespace().last().unwrap(), "art");
    }

    #[test]
    fn round_trip_128_and_256() {
        for len in [16usize, 32] {
            let mut e = vec![0u8; len];
            for (i, b) in e.iter_mut().enumerate() {
                *b = (i as u8).wrapping_mul(37).wrapping_add(11);
            }
            let phrase = encode(&e).unwrap();
            assert_eq!(decode(&phrase).unwrap(), e);
        }
    }

    #[test]
    fn rejects_bad_checksum() {
        // Swap the last word for another valid word — checksum must fail.
        let good = encode(&[0u8; 16]).unwrap();
        let bad = good.replace(" about", " zoo");
        assert!(matches!(decode(&bad), Err(PeersError::BadPhrase(_))));
    }

    #[test]
    fn rejects_unknown_word() {
        let bad = "abandon abandon abandon abandon abandon abandon \
                   abandon abandon abandon abandon abandon notaword";
        assert!(matches!(decode(bad), Err(PeersError::BadPhrase(_))));
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(matches!(decode("abandon abandon"), Err(PeersError::BadPhrase(_))));
        assert!(matches!(encode(&[0u8; 20]), Err(PeersError::BadPhrase(_))));
    }

    #[test]
    fn normalizes_case_and_whitespace() {
        let good = encode(&[0u8; 16]).unwrap();
        let messy = format!("  {}  ", good.to_uppercase().replace(' ', "   "));
        assert_eq!(decode(&messy).unwrap(), vec![0u8; 16]);
    }

    #[test]
    fn generate_produces_decodable_phrases() {
        for n in [12usize, 24] {
            let p = generate(n).unwrap();
            assert_eq!(p.split_whitespace().count(), n);
            assert!(decode(&p).is_ok());
        }
        // Two generated phrases must differ (entropy is random).
        assert_ne!(generate(12).unwrap(), generate(12).unwrap());
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Expected: FAIL — `encode`, `decode`, `generate` are not defined.

- [ ] **Step 4: Implement**

Add to `backend/src/crypto/mnemonic.rs`:

```rust
use crate::error::{PeersError, Result};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Encodes entropy as a BIP39 mnemonic. Accepts 16 bytes (12 words) or
/// 32 bytes (24 words).
pub fn encode(entropy: &[u8]) -> Result<String> {
    if entropy.len() != 16 && entropy.len() != 32 {
        return Err(PeersError::BadPhrase(format!(
            "entropy must be 16 or 32 bytes, got {}",
            entropy.len()
        )));
    }
    let checksum_bits = entropy.len() * 8 / 32;
    let digest = Sha256::digest(entropy);

    // Bit string: entropy followed by the top `checksum_bits` of SHA-256.
    let mut bits: Vec<bool> = Vec::with_capacity(entropy.len() * 8 + checksum_bits);
    for byte in entropy {
        for i in (0..8).rev() {
            bits.push(byte >> i & 1 == 1);
        }
    }
    for i in 0..checksum_bits {
        bits.push(digest[i / 8] >> (7 - i % 8) & 1 == 1);
    }

    let list = words();
    let phrase = bits
        .chunks(11)
        .map(|chunk| {
            let idx = chunk.iter().fold(0usize, |acc, &b| acc << 1 | usize::from(b));
            list[idx]
        })
        .collect::<Vec<_>>()
        .join(" ");
    Ok(phrase)
}

/// Decodes a BIP39 mnemonic back to entropy, verifying the checksum.
/// Input is normalized: case-insensitive, any run of whitespace separates.
pub fn decode(phrase: &str) -> Result<Vec<u8>> {
    let lower = phrase.to_lowercase();
    let given: Vec<&str> = lower.split_whitespace().collect();
    if given.len() != 12 && given.len() != 24 {
        return Err(PeersError::BadPhrase(format!(
            "expected 12 or 24 words, got {}",
            given.len()
        )));
    }

    let list = words();
    let mut bits: Vec<bool> = Vec::with_capacity(given.len() * 11);
    for w in &given {
        let idx = list
            .binary_search(w)
            .map_err(|_| PeersError::BadPhrase(format!("not in wordlist: {w}")))?;
        for i in (0..11).rev() {
            bits.push(idx >> i & 1 == 1);
        }
    }

    let entropy_bits = given.len() * 11 * 32 / 33;
    let checksum_bits = bits.len() - entropy_bits;

    let entropy: Vec<u8> = bits[..entropy_bits]
        .chunks(8)
        .map(|c| c.iter().fold(0u8, |acc, &b| acc << 1 | u8::from(b)))
        .collect();

    let digest = Sha256::digest(&entropy);
    for i in 0..checksum_bits {
        let expected = digest[i / 8] >> (7 - i % 8) & 1 == 1;
        if bits[entropy_bits + i] != expected {
            return Err(PeersError::BadPhrase(
                "checksum mismatch — a word is wrong or out of order".into(),
            ));
        }
    }
    Ok(entropy)
}

/// Generates a fresh mnemonic with `word_count` words (12 or 24).
pub fn generate(word_count: usize) -> Result<String> {
    let bytes = match word_count {
        12 => 16usize,
        24 => 32,
        n => {
            return Err(PeersError::BadPhrase(format!(
                "word count must be 12 or 24, got {n}"
            )))
        }
    };
    let mut entropy = vec![0u8; bytes];
    OsRng.fill_bytes(&mut entropy);
    encode(&entropy)
}
```

Note `list.binary_search(w)` relies on the wordlist being sorted, which Task 1's
test pins.

- [ ] **Step 5: Run tests to verify they pass**

Expected: PASS, all 8 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/crypto/mnemonic.rs backend/src/error.rs
git commit -m "feat(crypto): BIP39 mnemonic encode/decode with checksum"
```

---

### Task 3: Deterministic key derivation from entropy

**Files:**
- Create: `backend/src/crypto/seed.rs`
- Modify: `backend/src/crypto/mod.rs`
- Modify: `backend/src/crypto/identity.rs`

**Interfaces:**
- Consumes: `PeersError` from Task 2
- Produces:
  - `pub fn derive_keys(entropy: &[u8]) -> Result<([u8; 32], [u8; 32])>` — `(ed25519_seed, x25519_secret)`
  - `Identity::from_entropy(entropy: &[u8]) -> Result<Identity>`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/crypto/seed.rs`:

```rust
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
        let a = Identity::from_entropy(&mnemonic::decode(&mnemonic::generate(12).unwrap()).unwrap()).unwrap();
        let b = Identity::from_entropy(&mnemonic::decode(&mnemonic::generate(12).unwrap()).unwrap()).unwrap();
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
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — `derive_keys` and `Identity::from_entropy` are not defined.

- [ ] **Step 3: Implement derivation**

Prepend to `backend/src/crypto/seed.rs`:

```rust
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
/// stretching is applied — HKDF is used for domain separation, not hardening.
/// The two outputs are independent: recovering one does not reveal the other.
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
```

Register the module in `backend/src/crypto/mod.rs` with `pub mod seed;`.

- [ ] **Step 4: Implement `Identity::from_entropy`**

Add to `impl Identity` in `backend/src/crypto/identity.rs`:

```rust
    /// Rebuilds the identity deterministically from mnemonic entropy. The
    /// same phrase always yields the same peer ID, on any machine — this is
    /// what makes the recovery phrase the identity.
    pub fn from_entropy(entropy: &[u8]) -> Result<Self> {
        let (ed_seed, x_secret) = crate::crypto::seed::derive_keys(entropy)?;
        let keypair = Keypair::ed25519_from_bytes(ed_seed)
            .map_err(|e| PeersError::Identity(format!("ed25519 from seed: {e}")))?;
        let peer_id = PeerId::from(keypair.public());
        Ok(Self {
            keypair,
            x25519_secret: StaticSecret::from(x_secret),
            peer_id,
        })
    }
```

`Keypair::ed25519_from_bytes` takes a mutable 32-byte seed and zeroizes it, which
is why `ed_seed` is passed by value.

- [ ] **Step 5: Run tests to verify they pass**

Expected: PASS, all 7 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/crypto/seed.rs backend/src/crypto/identity.rs backend/src/crypto/mod.rs
git commit -m "feat(crypto): deterministic Ed25519+X25519 derivation from seed phrase"
```

---

### Task 4: Keystore v2 — phrase-sealed, v1 refused

**Files:**
- Modify: `backend/src/crypto/keystore.rs`
- Modify: `backend/src/error.rs`

**Interfaces:**
- Consumes: `Identity::from_entropy` (Task 3), `mnemonic::decode` (Task 2)
- Produces:
  - `Keystore::create_from_phrase(&self, phrase: &str) -> Result<Identity>`
  - `Keystore::load(&self, phrase: &str) -> Result<Identity>` — unchanged signature
  - `PeersError::StaleKeystore`

The keystore is now a **cache**, not the source of truth. The phrase seals it
(via the existing Argon2id path) *and* derives the identity inside it. If the
file is lost, the same phrase rebuilds the identity; if the phrase is lost,
nothing does.

- [ ] **Step 1: Add the error variant**

In `backend/src/error.rs`:

```rust
    #[error("this identity was created by an older version of Peers and cannot be recovered with a phrase; create a new identity")]
    StaleKeystore,
```

- [ ] **Step 2: Write the failing tests**

Add to the `tests` module in `backend/src/crypto/keystore.rs`:

```rust
    use crate::crypto::mnemonic;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("peers-ks-{}-{}", tag, std::process::id()))
            .join("identity.json")
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
        ks.create_from_phrase(&mnemonic::generate(12).unwrap()).unwrap();

        let other = mnemonic::generate(12).unwrap();
        assert!(matches!(ks.load(&other), Err(PeersError::BadPassword)));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn identity_is_recoverable_without_the_file() {
        // The whole point of M16: delete the keystore, keep the phrase,
        // and the same peer ID comes back.
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
            assert!(!raw.contains(word), "phrase word leaked into keystore: {word}");
        }

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
```

Delete the existing `create_load_round_trip` test's use of `ks.create(...)` only
if Step 4 removes `create`; otherwise leave it.

- [ ] **Step 3: Run tests to verify they fail**

Expected: FAIL — `create_from_phrase` is not defined; `StaleKeystore` is never returned.

- [ ] **Step 4: Implement**

In `backend/src/crypto/keystore.rs`, bump the version constant and replace
`create`:

```rust
/// Keystore format version. v1 (random key, password-sealed) is refused:
/// its identity cannot be re-derived from a phrase.
const VERSION: u32 = 2;
```

```rust
    /// Derives the identity from `phrase` and seals it with that same phrase.
    /// Idempotent: calling it twice with one phrase yields one identity.
    pub fn create_from_phrase(&self, phrase: &str) -> Result<Identity> {
        let entropy = crate::crypto::mnemonic::decode(phrase)?;
        let id = Identity::from_entropy(&entropy)?;
        let blob = id.marshal()?;
        self.seal(&blob, phrase)?;
        Ok(id)
    }
```

Change the `version` field written in `seal` from the literal `1` to `VERSION`,
and add a version guard at the top of `open`, immediately after parsing:

```rust
        if file.version < VERSION {
            return Err(PeersError::StaleKeystore);
        }
        if file.version > VERSION {
            return Err(PeersError::Keystore(format!(
                "keystore version {} is newer than this build supports",
                file.version
            )));
        }
```

Remove the old `create(&self, password: &str)` method and update the existing
`create_load_round_trip` test to use `create_from_phrase` with a generated
phrase. Any other caller of `create` is updated in Task 6.

- [ ] **Step 5: Run tests to verify they pass**

Expected: PASS. The pre-existing `missing_keystore` test must still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/crypto/keystore.rs backend/src/error.rs
git commit -m "feat(crypto): keystore v2 sealed by recovery phrase, refuse v1"
```

---

### Task 5: Relay reservation + external address tracking

**Files:**
- Modify: `backend/src/p2p/mod.rs`

**Interfaces:**
- Consumes: `Event::RelayClient` (already routed, `behaviour.rs:47`)
- Produces: two new fields readable by Task 7's `net_status`:
  - `relay_reservations: HashSet<PeerId>` — relays we currently hold a reservation with
  - `external_addrs: HashSet<Multiaddr>` — confirmed observed addresses

Reservations are held in a `HashSet` keyed by relay peer, not a counter, so a
duplicate accept cannot inflate the count and a disconnect removes exactly one
entry. This is the mitigation named in the spec's risk section.

- [ ] **Step 1: Write the failing test**

Add to the tests module in `backend/src/p2p/mod.rs` (create one if absent):

```rust
#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn reachability_prefers_direct() {
        assert_eq!(reachability(1, 0), "direct");
        assert_eq!(reachability(1, 3), "direct");
    }

    #[test]
    fn reachability_is_relayed_when_only_reservations() {
        assert_eq!(reachability(0, 1), "relayed");
    }

    #[test]
    fn reachability_unknown_when_nothing_known() {
        assert_eq!(reachability(0, 0), "unknown");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — `reachability` is not defined.

- [ ] **Step 3: Implement the helper**

Add to `backend/src/p2p/mod.rs`:

```rust
/// Best-guess reachability from what libp2p has confirmed. A confirmed
/// external address means peers can dial us directly; a relay reservation
/// with no external address means they reach us through a relay. This is a
/// heuristic — it can say "direct" for an address unreachable from some
/// networks — and callers must present it as such.
pub fn reachability(external_addrs: usize, relay_reservations: usize) -> &'static str {
    if external_addrs > 0 {
        "direct"
    } else if relay_reservations > 0 {
        "relayed"
    } else {
        "unknown"
    }
}
```

- [ ] **Step 4: Track the state in the swarm loop**

Add the fields to the node struct that owns `swarm` (the one handling
`SwarmEvent` around `p2p/mod.rs:363`):

```rust
    /// Relays we currently hold a circuit reservation with.
    relay_reservations: std::collections::HashSet<libp2p::PeerId>,
    /// Addresses libp2p has confirmed as externally observed.
    external_addrs: std::collections::HashSet<libp2p::Multiaddr>,
```

Initialize both to `Default::default()` in the constructor. Then handle the
events in the match:

```rust
            SwarmEvent::Behaviour(Event::RelayClient(
                relay::client::Event::ReservationReqAccepted { relay_peer_id, .. },
            )) => {
                self.relay_reservations.insert(relay_peer_id);
            }
            SwarmEvent::ConnectionClosed { peer_id, num_established: 0, .. } => {
                self.relay_reservations.remove(&peer_id);
            }
            SwarmEvent::ExternalAddrConfirmed { address } => {
                self.external_addrs.insert(address);
            }
            SwarmEvent::ExternalAddrExpired { address } => {
                self.external_addrs.remove(&address);
            }
```

`ConnectionClosed` with `num_established: 0` means the last connection to that
peer went away, so any reservation with it is gone. If a `ConnectionClosed` arm
already exists, add the `relay_reservations.remove` line to it rather than
adding a second arm.

Expose both to the Tauri layer through whatever channel `online_peers` already
uses (`lib.rs:719`) — mirror that mechanism exactly rather than inventing a
second one.

- [ ] **Step 5: Run tests to verify they pass**

Expected: PASS. `cargo clippy -D warnings` must also be clean — the new match
arms must not make an existing arm unreachable.

- [ ] **Step 6: Commit**

```bash
git add backend/src/p2p/mod.rs
git commit -m "feat(p2p): track relay reservations and confirmed external addrs"
```

---

### Task 6: Tauri commands — generate_phrase, init_from_phrase, net_status

**Files:**
- Modify: `backend/src/lib.rs`
- Modify: `backend/src/node.rs`

**Interfaces:**
- Consumes: `mnemonic::generate` (T2), `Keystore::create_from_phrase` (T4),
  `reachability` + tracked state (T5)
- Produces (Tauri commands):
  - `generate_phrase(word_count: usize) -> Result<String, String>`
  - `init_from_phrase(phrase: String) -> Result<IdentityInfo, String>`
  - `net_status() -> Result<NetStatus, String>`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/lib.rs`'s tests module:

```rust
#[cfg(test)]
mod net_status_tests {
    use super::*;

    #[test]
    fn net_status_serializes_camel_case() {
        let s = NetStatus {
            peers: 3,
            listen_addrs: vec!["/ip4/127.0.0.1/tcp/4001".into()],
            external_addrs: vec![],
            relay_reservations: 1,
            serving_relay: false,
            reachability: "relayed",
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"listenAddrs\""), "frontend expects camelCase");
        assert!(json.contains("\"relayReservations\""));
        assert!(json.contains("\"servingRelay\""));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `NetStatus` is not defined.

- [ ] **Step 3: Implement the struct and commands**

In `backend/src/lib.rs`:

```rust
/// A snapshot of what the node knows about its own connectivity.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    /// Peers with at least one live connection.
    pub peers: usize,
    pub listen_addrs: Vec<String>,
    pub external_addrs: Vec<String>,
    pub relay_reservations: usize,
    /// True when this process accepts relay reservations (`--node` mode).
    pub serving_relay: bool,
    /// Heuristic: "direct" | "relayed" | "unknown". Not a guarantee.
    pub reachability: &'static str,
}

/// Generates a fresh recovery phrase. Returned to the UI exactly once so the
/// user can write it down; it is never stored in plaintext or logged.
#[tauri::command]
fn generate_phrase(word_count: usize) -> Result<String, String> {
    crate::crypto::mnemonic::generate(word_count).map_err(|e| e.to_string())
}

/// Creates (or recovers) the identity from a recovery phrase and seals the
/// keystore with it. Safe to call with an existing phrase: it rebuilds the
/// same identity.
#[tauri::command]
async fn init_from_phrase(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    phrase: String,
) -> Result<IdentityInfo, String> {
    let ks = Keystore::new(Keystore::default_path());
    let id = ks.create_from_phrase(&phrase).map_err(|e| e.to_string())?;
    // Reuse the same post-unlock startup path `unlock` uses — do not
    // duplicate swarm bring-up here.
    finish_unlock(state, app, id).await
}

/// Current connectivity snapshot for the UI.
#[tauri::command]
fn net_status(state: State<'_, AppState>) -> Result<NetStatus, String> {
    let listen_addrs = state.listen_addrs.lock().unwrap().clone();
    let external_addrs = state.external_addrs.lock().unwrap().clone();
    let relay_reservations = state.relay_reservations.lock().unwrap().len();
    let peers = state.online.lock().unwrap().len();
    Ok(NetStatus {
        peers,
        listen_addrs,
        reachability: crate::p2p::reachability(external_addrs.len(), relay_reservations),
        external_addrs,
        relay_reservations,
        serving_relay: state.serving_relay,
    })
}
```

Refactor the existing `unlock` command so its post-unlock work (swarm start,
topic subscriptions, profile announce — currently `lib.rs:198–226`) lives in a
`finish_unlock(state, app, id)` helper that both `unlock` and `init_from_phrase`
call. Do not copy that block; duplicating it is how the two paths drift.

Register all three in the `invoke_handler!` list beside `online_peers`
(`lib.rs:997`). Replace the `init_identity` command with `init_from_phrase`,
and update `node.rs` to build its identity via `create_from_phrase` using a
phrase stored alongside `node_identity.json`, generating one on first run.

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS. Also `cargo clippy -D warnings` clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib.rs backend/src/node.rs
git commit -m "feat: seed-phrase identity commands and net_status"
```

---

### Task 7: Capacity caps and tiered relaying (M12)

**Files:**
- Modify: `backend/src/p2p/behaviour.rs:141-157`

**Interfaces:**
- Consumes: the existing `serve_relay: bool` parameter
- Produces: `RelayCaps` with named tiers

Today `serve_relay` picks between one hardcoded generous config and zero. M12
needs caps that suit a Raspberry Pi, so the numbers become explicit and tested.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/p2p/behaviour.rs`:

```rust
#[cfg(test)]
mod cap_tests {
    use super::*;

    #[test]
    fn client_tier_accepts_no_reservations() {
        let c = RelayCaps::client();
        assert_eq!(c.max_reservations, 0);
        assert_eq!(c.max_circuits, 0);
    }

    #[test]
    fn node_tier_is_bounded_for_low_end_hardware() {
        let c = RelayCaps::node();
        assert!(c.max_reservations > 0);
        assert!(c.max_reservations <= 128, "a Pi must not accept unbounded reservations");
        assert!(c.max_circuits_per_peer <= c.max_circuits);
        assert!(c.max_reservations_per_peer <= c.max_reservations);
        assert!(c.max_circuit_bytes <= 256 * 1024 * 1024);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — `RelayCaps` is not defined.

- [ ] **Step 3: Implement**

Replace the inline config block at `behaviour.rs:141-157` with:

```rust
/// Relay capacity by tier. GUI clients are light clients first and relays
/// never; dedicated `--node` processes relay within a budget that a
/// Raspberry Pi or cheap VPS can sustain.
pub struct RelayCaps {
    pub max_reservations: usize,
    pub max_reservations_per_peer: usize,
    pub max_circuits: usize,
    pub max_circuits_per_peer: usize,
    pub max_circuit_bytes: u64,
}

impl RelayCaps {
    /// GUI clients: dial through relays, never serve as one.
    pub fn client() -> Self {
        Self {
            max_reservations: 0,
            max_reservations_per_peer: 0,
            max_circuits: 0,
            max_circuits_per_peer: 0,
            max_circuit_bytes: 0,
        }
    }

    /// Always-on nodes. 64 reservations × 128 MiB caps worst-case relayed
    /// traffic while leaving headroom on a 1 GB Pi.
    pub fn node() -> Self {
        Self {
            max_reservations: 64,
            max_reservations_per_peer: 4,
            max_circuits: 64,
            max_circuits_per_peer: 8,
            max_circuit_bytes: 128 * 1024 * 1024,
        }
    }
}
```

And in `Behaviour::new`:

```rust
        let caps = if serve_relay { RelayCaps::node() } else { RelayCaps::client() };
        let mut relay_cfg = relay::Config {
            max_reservations: caps.max_reservations,
            max_reservations_per_peer: caps.max_reservations_per_peer,
            max_circuits: caps.max_circuits,
            max_circuits_per_peer: caps.max_circuits_per_peer,
            max_circuit_bytes: caps.max_circuit_bytes,
            ..Default::default()
        };
        relay_cfg.reservation_duration = Duration::from_secs(3600);
        relay_cfg.max_circuit_duration = Duration::from_secs(3600);
```

- [ ] **Step 4: Run tests to verify they pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/p2p/behaviour.rs
git commit -m "feat(p2p): explicit relay capacity tiers for low-end nodes (M12)"
```

---

### Task 8: Minimal frontend wiring

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/App.tsx:743-813`

Deliberately plain: reuse the existing auth-form styling, add no components, no
theme work. UI quality is a later phase.

- [ ] **Step 1: Add bindings**

In `frontend/src/lib/api.ts`:

```ts
export interface NetStatus {
    peers: number;
    listenAddrs: string[];
    externalAddrs: string[];
    relayReservations: number;
    servingRelay: boolean;
    reachability: "direct" | "relayed" | "unknown";
}

export const generatePhrase = (wordCount = 12) =>
    invoke<string>("generate_phrase", {wordCount});
export const initFromPhrase = (phrase: string) =>
    invoke<IdentityInfo>("init_from_phrase", {phrase});
export const netStatus = () => invoke<NetStatus>("net_status");
```

Remove the `initIdentity` export and its import in `App.tsx`.

- [ ] **Step 2: Rework the auth screen**

Onboarding becomes two steps. Add state alongside the existing `password` state:

```tsx
const [phrase, setPhrase] = useState('');
const [phraseSaved, setPhraseSaved] = useState(false);
const [recovering, setRecovering] = useState(false);
```

On entering `'onboarding'`, call `generatePhrase()` and show the 12 words in a
read-only block with a copy button, a plain warning that losing it means losing
the identity, and a checkbox gating the Continue button on `phraseSaved`.
Continue calls `initFromPhrase(phrase)`.

Add a "Recover an existing identity" link that flips `recovering` to true and
swaps the generated phrase for a textarea the user types into; submit calls the
same `initFromPhrase`. The unlock screen keeps its password field, now labelled
"Recovery phrase" and posting to the existing `unlock` command.

- [ ] **Step 3: Add a plain status line**

In `ChatScreen`'s header area, poll `netStatus()` every 5s and render one line of
text — `4 peers · relayed` — with `title` carrying the listen addresses. No
badge component, no popover; that arrives with the UI phase.

- [ ] **Step 4: Verify locally**

```bash
cd frontend && npx tsc --noEmit && npm run build
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/App.tsx
git commit -m "feat(ui): seed-phrase onboarding and plain connectivity line"
```

---

### Task 9: Deployment guide and node list (M13)

**Files:**
- Create: `docs/running-a-node.md`
- Modify: `README.md`, `PLAN.md`

- [ ] **Step 1: Write the guide**

`docs/running-a-node.md` covers, with real commands: building the binary
(`cargo build --release`), running `peers --node`, the systemd unit for a VPS or
Pi, the firewall ports to open, `PEERS_NODES` and `<config>/peers/nodes.json`
bootstrap configuration, the capacity caps from Task 7 and what they cost in RAM
and bandwidth, and how to verify the node is reachable using `net_status` output.
State plainly that a node behind a closed NAT cannot serve as backbone.

- [ ] **Step 2: Update roadmaps**

Mark M12, M13 and M16 complete in `README.md`'s roadmap and `PLAN.md`'s
milestones, matching the existing `[x]` / `[~]` convention. Replace M16's
description with what shipped: BIP39 12/24-word phrase, HKDF domain-separated
Ed25519 + X25519 derivation, keystore v2, v1 refused.

- [ ] **Step 3: Commit**

```bash
git add docs/running-a-node.md README.md PLAN.md
git commit -m "docs: node deployment guide, mark M12/M13/M16 done (M13)"
```

---

## Verification

1. CI green on all of: `cargo fmt --check`, `cargo clippy -D warnings`,
   `cargo test`, frontend build, Windows/macOS `cargo check`.
2. `cd frontend && npx tsc --noEmit && npm run build` clean locally.
3. Manual: fresh install → phrase shown → written down → identity created →
   lock → unlock with phrase → delete `identity.json` → recover with the same
   phrase → **same peer ID**.
4. Manual: `peers --node` on a reachable host; a client shows `N peers · direct`
   or `· relayed`.

## Out of scope

- **M17 friend codes** — next plan. 12-digit DHT rendezvous code plus QR, per the
  decision recorded in the spec.
- **UI overhaul** — Ember theme, `App.tsx` restructure, dialog system, Vitest.
  Deferred by user direction; the spec at
  `docs/superpowers/specs/2026-08-04-ui-foundation-design.md` still describes it.

## Self-review notes

- **Spec coverage:** `net_status` (T5–6), capacity caps (T7), M16 (T1–4, T8),
  M13 (T9). The spec's Ember theme, App.tsx restructure, dialog system and
  Vitest tasks are intentionally absent — deferred, and listed above.
- **Type consistency:** `derive_keys` returns `([u8; 32], [u8; 32])` in T3 and is
  consumed with that shape in `Identity::from_entropy`. `reachability(usize,
  usize) -> &'static str` in T5 matches its call in T6's `net_status`. `NetStatus`
  field names match `api.ts`'s interface via `rename_all = "camelCase"`, which
  T6's test pins.
- **Known risk:** T6 refactors `unlock`'s startup block into `finish_unlock`
  without seeing that code in full; the implementer must read `lib.rs:198–226`
  before extracting, and must not duplicate it.
