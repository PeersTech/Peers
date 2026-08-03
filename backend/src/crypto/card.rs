use crate::crypto::cipher::{open, seal};
use crate::crypto::identity::Identity;
use crate::crypto::session::Session;
use crate::error::{PeersError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Domain separation string for the identity-card signature.
const CARD_DOMAIN: &[u8] = b"peers/v1/card";
/// Wire format version of the sealed envelope.
const ENVELOPE_VERSION: u8 = 0x01;
/// Cap on recipients per message (defends the header against bloat).
const MAX_RECIPIENTS: usize = 64;

/// Self-authenticating identity card: the sender's Ed25519 public key, the
/// X25519 key used for ECDH, and an Ed25519 signature binding them. The
/// signature is over SHA-256("peers/v1/card" || x25519_pub), so anyone can
/// verify the card and cache (peer id -> x25519 key) for later sends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerCard {
    pub ed_pub: [u8; 32],
    pub x25519_pub: [u8; 32],
    pub sig: Vec<u8>,
}

fn sign_message(x25519_pub: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(CARD_DOMAIN);
    h.update(x25519_pub);
    h.finalize().into()
}

impl PeerCard {
    pub fn sign(identity: &Identity) -> Result<Self> {
        let x25519_pub = identity.x25519_public();
        let msg = sign_message(&x25519_pub);
        let sig = identity
            .keypair
            .sign(&msg)
            .map_err(|e| PeersError::Crypto(format!("card sign: {e}")))?;
        Ok(Self {
            ed_pub: identity.ed25519_public()?,
            x25519_pub,
            sig,
        })
    }

    /// Verifies the card's signature. The X25519 key is trusted after this.
    pub fn verify(&self) -> Result<()> {
        let pk = libp2p::identity::ed25519::PublicKey::try_from_bytes(&self.ed_pub)
            .map_err(|e| PeersError::Crypto(format!("card pubkey: {e}")))?;
        if !pk.verify(&sign_message(&self.x25519_pub), &self.sig) {
            return Err(PeersError::Crypto("card signature invalid".into()));
        }
        Ok(())
    }
}

/// Per-contact E2E state: one session (hash-chain + replay window) per
/// recipient X25519 key, plus the identity cards we have validated so far.
/// Memory-only for now; persisted contacts come with M4.
#[derive(Clone)]
pub struct SessionDir {
    sessions: HashMap<[u8; 32], Session>,
    contacts: HashMap<String, [u8; 32]>,
}

impl Default for SessionDir {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionDir {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            contacts: HashMap::new(),
        }
    }

    fn session_for(&mut self, identity: &Identity, their_pub: [u8; 32]) -> Result<&mut Session> {
        if let std::collections::hash_map::Entry::Vacant(e) = self.sessions.entry(their_pub) {
            e.insert(Session::new(&identity.x25519_secret, their_pub)?);
        }
        Ok(self.sessions.get_mut(&their_pub).expect("just inserted"))
    }

    /// Remembers a validated card so future sends can encrypt to this peer.
    pub fn remember_contact(&mut self, peer_id: &str, card: &PeerCard) {
        self.contacts.insert(peer_id.to_string(), card.x25519_pub);
    }

    /// Snapshots the dir (per-contact sessions + contact x25519 keys) so it
    /// can be sealed to disk and restored after a restart. The secrets ride
    /// inside the state envelope, which is password-encrypted at rest.
    pub fn export(
        &self,
    ) -> (
        Vec<(Vec<u8>, crate::crypto::session::SessionState)>,
        Vec<(String, Vec<u8>)>,
    ) {
        let sessions = self
            .sessions
            .iter()
            .map(|(k, s)| (k.to_vec(), s.export()))
            .collect();
        let contacts = self
            .contacts
            .iter()
            .map(|(k, v)| (k.clone(), v.to_vec()))
            .collect();
        (sessions, contacts)
    }

    /// Restores state written by [`SessionDir::export`] into an empty dir.
    /// Existing contacts/sessions are kept; restored ones take precedence.
    pub fn restore(
        &mut self,
        sessions: &[(Vec<u8>, crate::crypto::session::SessionState)],
        contacts: &[(String, Vec<u8>)],
    ) {
        for (key, state) in sessions {
            if let Ok(key) = <[u8; 32]>::try_from(key.as_slice()) {
                self.sessions.insert(key, Session::import(state));
            }
        }
        for (peer, key) in contacts {
            if let Ok(key) = <[u8; 32]>::try_from(key.as_slice()) {
                self.contacts.insert(peer.clone(), key);
            }
        }
    }

    /// All X25519 keys we can currently encrypt to.
    pub fn recipient_keys(&self) -> Vec<[u8; 32]> {
        self.contacts.values().copied().collect()
    }

    /// Seals `plaintext` for every listed recipient. Payload layout:
    ///
    /// ```text
    /// [ver 1][ed_pub 32][x25519 32][sig 64][n u16 BE]
    ///   n x [rcpt_x25519 32][ct_len u32 BE][seq 8][nonce 12][ct+tag]
    /// ```
    ///
    /// `aad` binds the ciphertext to its context (channel id).
    pub fn seal(
        &mut self,
        identity: &Identity,
        recipients: &[[u8; 32]],
        aad: &[u8],
        plaintext: &[u8],
    ) -> Result<Vec<u8>> {
        if recipients.is_empty() {
            return Err(PeersError::Other(
                "no recipients with validated identity cards yet".into(),
            ));
        }
        if recipients.len() > MAX_RECIPIENTS {
            return Err(PeersError::MessageTooLarge);
        }
        let card = PeerCard::sign(identity)?;

        let mut copies = Vec::with_capacity(recipients.len() * 68 + plaintext.len());
        for rcpt in recipients {
            let session = self.session_for(identity, *rcpt)?;
            let sealed = seal(session, aad, plaintext)?;
            copies.extend_from_slice(rcpt);
            copies.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
            copies.extend_from_slice(&sealed);
        }

        let mut out = Vec::with_capacity(1 + 32 + 32 + 64 + 2 + copies.len());
        out.push(ENVELOPE_VERSION);
        out.extend_from_slice(&card.ed_pub);
        out.extend_from_slice(&card.x25519_pub);
        out.extend_from_slice(&card.sig);
        out.extend_from_slice(&(recipients.len() as u16).to_be_bytes());
        out.extend_from_slice(&copies);
        Ok(out)
    }

    /// Opens a `seal`-produced envelope addressed to us. Verifies the sender
    /// card, picks our copy, and decrypts with replay protection. On success
    /// the sender's card is trusted and cached, and the plaintext returned.
    pub fn open(&mut self, identity: &Identity, aad: &[u8], payload: &[u8]) -> Result<Vec<u8>> {
        let card = parse_card(payload)?;
        card.verify()?;

        if card.x25519_pub == identity.x25519_public() {
            return Err(PeersError::Other("message from ourselves".into()));
        }
        if payload.len() < 131 {
            return Err(PeersError::BadCipher);
        }

        let own = identity.x25519_public();
        let n = u16::from_be_bytes(
            payload[129..131]
                .try_into()
                .map_err(|_| PeersError::BadCipher)?,
        ) as usize;
        let mut rest = &payload[131..];
        for _ in 0..n {
            if rest.len() < 32 + 4 + 8 + 16 {
                return Err(PeersError::BadCipher);
            }
            let rcpt: [u8; 32] = rest[..32].try_into().map_err(|_| PeersError::BadCipher)?;
            let ct_len =
                u32::from_be_bytes(rest[32..36].try_into().map_err(|_| PeersError::BadCipher)?)
                    as usize;
            let copy_len = 32 + 4 + ct_len;
            if rest.len() < copy_len {
                return Err(PeersError::BadCipher);
            }
            let sealed = &rest[36..36 + ct_len];
            if rcpt == own {
                let session = self.session_for(identity, card.x25519_pub)?;
                let plaintext = open(session, aad, sealed)?;
                self.remember_contact(&card_contact_key(&card), &card);
                return Ok(plaintext);
            }
            rest = &rest[copy_len..];
        }
        Err(PeersError::NotAddressed)
    }
}

/// Contact map key for a card: the Ed25519-based peer id string.
fn card_contact_key(card: &PeerCard) -> String {
    // Stable pseudo-peer-id: "k" + base32 of the ed25519 key. The real peer
    // id (multihash) is not derivable from the raw key without extra deps.
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &card.ed_pub)
}

fn parse_card(payload: &[u8]) -> Result<PeerCard> {
    let min = 1 + 32 + 32 + 64 + 2;
    if payload.len() < min {
        return Err(PeersError::BadCipher);
    }
    if payload[0] != ENVELOPE_VERSION {
        return Err(PeersError::BadCipher);
    }
    let ed_pub: [u8; 32] = payload[1..33]
        .try_into()
        .map_err(|_| PeersError::BadCipher)?;
    let x25519_pub: [u8; 32] = payload[33..65]
        .try_into()
        .map_err(|_| PeersError::BadCipher)?;
    let sig: Vec<u8> = payload[65..129].to_vec();
    Ok(PeerCard {
        ed_pub,
        x25519_pub,
        sig,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::identity::Identity;

    fn pair() -> (Identity, Identity) {
        (Identity::new().unwrap(), Identity::new().unwrap())
    }

    #[test]
    fn card_verifies() {
        let (a, _b) = pair();
        let card = PeerCard::sign(&a).unwrap();
        card.verify().unwrap();
    }

    #[test]
    fn tampered_card_rejected() {
        let (a, _b) = pair();
        let mut card = PeerCard::sign(&a).unwrap();
        card.sig[0] ^= 0xff;
        assert!(card.verify().is_err());
    }

    #[test]
    fn a_to_b_round_trip() {
        let (a, b) = pair();
        let b_pub = b.x25519_public();
        let mut da = SessionDir::new();
        let mut db = SessionDir::new();
        let payload = da
            .seal(&a, &[b_pub], b"channel/general", b"hello b")
            .unwrap();
        let got = db.open(&b, b"channel/general", &payload).unwrap();
        assert_eq!(got, b"hello b");
        // b can now reply: a's key is cached under b's contacts.
        let a_pub = a.x25519_public();
        assert!(db.recipient_keys().contains(&a_pub));
    }

    #[test]
    fn third_party_cannot_open() {
        let (a, b) = pair();
        let c = Identity::new().unwrap();
        let b_pub = b.x25519_public();
        let mut da = SessionDir::new();
        let mut dc = SessionDir::new();
        let payload = da.seal(&a, &[b_pub], b"ch", b"secret").unwrap();
        assert!(matches!(
            dc.open(&c, b"ch", &payload),
            Err(PeersError::NotAddressed) | Err(PeersError::Crypto(_))
        ));
    }

    #[test]
    fn wrong_aad_rejected() {
        let (a, b) = pair();
        let b_pub = b.x25519_public();
        let mut da = SessionDir::new();
        let mut db = SessionDir::new();
        let payload = da.seal(&a, &[b_pub], b"channel/one", b"secret").unwrap();
        assert!(db.open(&b, b"channel/other", &payload).is_err());
    }

    #[test]
    fn replay_rejected_across_copies() {
        let (a, b) = pair();
        let b_pub = b.x25519_public();
        let mut da = SessionDir::new();
        let mut db = SessionDir::new();
        let payload = da.seal(&a, &[b_pub], b"ch", b"first").unwrap();
        db.open(&b, b"ch", &payload).unwrap();
        // Same envelope replayed (even after a new message).
        let second = da.seal(&a, &[b_pub], b"ch", b"second").unwrap();
        db.open(&b, b"ch", &second).unwrap();
        assert!(matches!(
            db.open(&b, b"ch", &payload),
            Err(PeersError::Replay)
        ));
    }

    #[test]
    fn multi_recipient() {
        let (a, b) = pair();
        let c = Identity::new().unwrap();
        let mut da = SessionDir::new();
        let mut db = SessionDir::new();
        let mut dc = SessionDir::new();
        let payload = da
            .seal(&a, &[b.x25519_public(), c.x25519_public()], b"ch", b"both")
            .unwrap();
        assert_eq!(db.open(&b, b"ch", &payload).unwrap(), b"both");
        assert_eq!(dc.open(&c, b"ch", &payload).unwrap(), b"both");
    }

    #[test]
    fn tampered_envelope_rejected() {
        let (a, b) = pair();
        let b_pub = b.x25519_public();
        let mut da = SessionDir::new();
        let mut db = SessionDir::new();
        let mut payload = da.seal(&a, &[b_pub], b"ch", b"don't touch").unwrap();
        let last = payload.len() - 1;
        payload[last] ^= 0xff;
        assert!(db.open(&b, b"ch", &payload).is_err());
    }
}
