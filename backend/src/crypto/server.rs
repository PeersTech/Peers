//! Servers: owner-signed member lists, rotating signing keys, invites.
//!
//! A server is an ephemeral group owned by one peer. Every mutation
//! (member add/remove/role change, channel ACL change, key rotation) is
//! applied by the owner and published as a [`SignedList`] on the server
//! topic. Members verify the list against the key they already trust and
//! follow the rotation chain (`signing_pub` signs this list, `next_pub`
//! signs the next one).
//!
//! Invites are self-contained: they embed the current server key so a new
//! joiner can anchor its trust and start verifying lists immediately.

use crate::error::{PeersError, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use libp2p::identity::{ed25519, Keypair};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// Minimum role required for a channel operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Member = 1,
    Admin = 2,
    Owner = 3,
}

/// A member entry in the signed list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub peer_id: String,
    pub name: String,
    pub role: Role,
    pub joined_epoch: u64,
}

/// A channel plus its ACL (minimum roles to read / write).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelConfig {
    pub name: String,
    pub topic: String,
    pub read_min: Role,
    pub write_min: Role,
}

/// The part of a [`SignedList`] that is signed. Field order is fixed so
/// the serialized bytes are canonical for signature verification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListPayload {
    pub version: u8,
    pub server_id: String,
    pub epoch: u64,
    /// Key that produced `sig`; must equal the `next_pub` we knew.
    pub signing_pub: [u8; 32],
    /// Key that will sign the next list (after the next rotation).
    pub next_pub: [u8; 32],
    pub members: Vec<Member>,
    pub channels: Vec<ChannelConfig>,
}

/// Owner-signed member list. Members verify with their known key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignedList {
    pub payload: ListPayload,
    /// base64 Ed25519 signature over the canonical JSON of `payload`.
    pub sig: String,
}

/// The part of an [`Invite`] that is signed by the current server key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitePayload {
    pub version: u8,
    pub server_id: String,
    pub server_name: String,
    pub owner_peer: String,
    pub nonce: [u8; 16],
    /// Trust anchor for the joiner: the key that signs the next list.
    pub next_pub: [u8; 32],
}

/// Self-contained join credential. Anyone holding a valid invite can join.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Invite {
    pub payload: InvitePayload,
    pub sig: String,
}

/// Rotating server signing keys. `prev` signs the first list after a
/// rotation so members can follow the chain; `rotate_key` in [`ServerDir`]
/// always re-signs immediately, keeping the invariant list(E+1) signed by
/// key(E).
#[derive(Clone)]
pub struct ServerKeys {
    pub current: Keypair,
    prev: Option<Keypair>,
    pub epoch: u64,
}

impl ServerKeys {
    pub fn new() -> Self {
        Self {
            current: Keypair::generate_ed25519(),
            prev: None,
            epoch: 0,
        }
    }

    /// Rotates: the current key becomes the chain-linking previous key.
    pub fn rotate(&mut self) {
        self.prev = Some(self.current.clone());
        self.current = Keypair::generate_ed25519();
        self.epoch += 1;
    }

    /// The key that signs the current list (`prev` right after rotation).
    pub fn signing_key(&self) -> Keypair {
        self.prev.clone().unwrap_or_else(|| self.current.clone())
    }

    pub fn signing_pub(&self) -> [u8; 32] {
        ed25519_bytes(&self.signing_key().public())
    }

    /// The key that will sign the next list.
    pub fn next_pub(&self) -> [u8; 32] {
        ed25519_bytes(&self.current.public())
    }

    pub fn sign(&self, msg: &[u8]) -> Result<String> {
        let sig = self
            .signing_key()
            .sign(msg)
            .map_err(|e| PeersError::Crypto(format!("server key sign: {e}")))?;
        Ok(B64.encode(sig))
    }
}

impl Default for ServerKeys {
    fn default() -> Self {
        Self::new()
    }
}

/// A server known to this node. `keys` is only present for the owner.
#[derive(Clone)]
pub struct ServerRecord {
    pub id: String,
    pub name: String,
    pub owner_peer: String,
    pub keys: Option<ServerKeys>,
    /// The key we last verified; lists must be signed by it.
    pub known_pub: [u8; 32],
    pub members: Vec<Member>,
    pub channels: Vec<ChannelConfig>,
}

impl ServerRecord {
    /// Builds the canonical signing bytes for a payload.
    fn sign_bytes(payload: &ListPayload) -> Result<Vec<u8>> {
        serde_json::to_vec(payload).map_err(PeersError::Serde)
    }

    /// Verifies `sig` (base64) over the payload bytes with `pub_bytes`.
    fn verify_sig(pub_bytes: &[u8; 32], payload: &ListPayload, sig: &str) -> Result<()> {
        let bytes = Self::sign_bytes(payload)?;
        let sig = B64
            .decode(sig)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        let pk = ed25519::PublicKey::try_from_bytes(pub_bytes)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        if !pk.verify(&bytes, &sig) {
            return Err(PeersError::SnapshotCorrupt);
        }
        Ok(())
    }

    /// Signs the current member list with the chain-linking key.
    pub fn signed_list(&self) -> Result<SignedList> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(PeersError::NotOwner)?;
        let payload = ListPayload {
            version: 1,
            server_id: self.id.clone(),
            epoch: keys.epoch,
            signing_pub: keys.signing_pub(),
            next_pub: keys.next_pub(),
            members: self.members.clone(),
            channels: self.channels.clone(),
        };
        let sig = keys.sign(&Self::sign_bytes(&payload)?)?;
        Ok(SignedList { payload, sig })
    }

    /// Verifies a list against our known key and advances the chain.
    pub fn verify_list(&mut self, list: &SignedList) -> Result<()> {
        if list.payload.server_id != self.id {
            return Err(PeersError::ServerNotFound);
        }
        if list.payload.signing_pub != self.known_pub {
            return Err(PeersError::UnknownEpoch);
        }
        Self::verify_sig(&self.known_pub, &list.payload, &list.sig)?;
        self.members = list.payload.members.clone();
        self.channels = list.payload.channels.clone();
        self.known_pub = list.payload.next_pub;
        Ok(())
    }

    /// Creates an invite signed by the current key.
    pub fn invite(&self) -> Result<Invite> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(PeersError::NotOwner)?;
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        let payload = InvitePayload {
            version: 1,
            server_id: self.id.clone(),
            server_name: self.name.clone(),
            owner_peer: self.owner_peer.clone(),
            nonce,
            next_pub: keys.next_pub(),
        };
        let bytes = serde_json::to_vec(&payload).map_err(PeersError::Serde)?;
        let sig = keys
            .current
            .sign(&bytes)
            .map_err(|e| PeersError::Crypto(format!("invite sign: {e}")))?;
        Ok(Invite {
            payload,
            sig: B64.encode(sig),
        })
    }

    /// Role of a member, if they are on the list.
    pub fn role_of(&self, peer_id: &str) -> Option<Role> {
        self.members
            .iter()
            .find(|m| m.peer_id == peer_id)
            .map(|m| m.role)
    }

    /// Whether `peer_id` may read (and by extension write) the channel.
    pub fn can_read(&self, peer_id: &str, channel: &str, role: Role) -> bool {
        let Some(cfg) = self.channels.iter().find(|c| c.name == channel) else {
            return false;
        };
        let Some(member) = self.role_of(peer_id) else {
            return false;
        };
        member >= cfg.read_min && role >= cfg.read_min
    }

    /// Whether `peer_id` may publish to the channel.
    pub fn can_write(&self, peer_id: &str, channel: &str) -> bool {
        let Some(cfg) = self.channels.iter().find(|c| c.name == channel) else {
            return false;
        };
        let Some(member) = self.role_of(peer_id) else {
            return false;
        };
        member >= cfg.write_min
    }
}

fn ed25519_bytes(pk: &libp2p::identity::PublicKey) -> [u8; 32] {
    pk.clone()
        .try_into_ed25519()
        .expect("server keys are always ed25519")
        .to_bytes()
}

/// The server-wide gossip topic used for control messages.
pub fn server_topic(server_id: &str) -> String {
    format!("peers/v1/srv/{server_id}")
}

/// The gossip topic for a channel inside a server.
pub fn channel_topic(server_id: &str, channel: &str) -> String {
    format!("peers/v1/ch/{server_id}/{channel}")
}
