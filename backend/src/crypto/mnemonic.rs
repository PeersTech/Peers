use crate::error::{PeersError, Result};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const RAW: &str = include_str!("wordlist.txt");

/// The BIP39 English wordlist: 2048 sorted, unique ASCII words. Sorted order
/// is what lets [`decode`] look words up with a binary search.
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

/// Encodes entropy as a BIP39 mnemonic. Accepts 16 bytes (12 words) or 32
/// bytes (24 words). The trailing checksum bits let [`decode`] catch a
/// mistyped or transposed word instead of silently deriving a stranger's
/// identity.
pub fn encode(entropy: &[u8]) -> Result<String> {
    if entropy.len() != 16 && entropy.len() != 32 {
        return Err(PeersError::BadPhrase(format!(
            "entropy must be 16 or 32 bytes, got {}",
            entropy.len()
        )));
    }
    let checksum_bits = entropy.len() * 8 / 32;
    let digest = Sha256::digest(entropy);

    // Bit string: the entropy followed by the top `checksum_bits` of its
    // SHA-256, chunked into 11-bit wordlist indices.
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

/// Decodes a BIP39 mnemonic back to entropy, verifying the checksum. Input is
/// normalized first: case-insensitive, and any run of whitespace separates
/// words, so a phrase pasted out of a text editor still works.
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

/// Generates a fresh mnemonic with `word_count` words (12 or 24) from the OS
/// CSPRNG.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist_is_wellformed() {
        let list = words();
        assert_eq!(list.len(), 2048);
        assert_eq!(list[0], "abandon");
        assert_eq!(list[2047], "zoo");
        for pair in list.windows(2) {
            assert!(pair[0] < pair[1], "wordlist must be sorted: {pair:?}");
        }
        for w in list.iter() {
            assert!(w.len() >= 3, "word too short: {w}");
            assert!(w.is_ascii(), "non-ascii word: {w}");
        }
    }

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
        assert!(matches!(
            decode("abandon abandon"),
            Err(PeersError::BadPhrase(_))
        ));
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
        assert_ne!(generate(12).unwrap(), generate(12).unwrap());
    }

    #[test]
    fn rejects_bad_word_count() {
        assert!(matches!(generate(13), Err(PeersError::BadPhrase(_))));
    }
}
