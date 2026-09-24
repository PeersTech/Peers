//! Servers: owner-signed member lists, rotating signing keys, invites.
//!
//! A server is an ephemeral group owned by one peer. Every mutation
//! (member add/remove/role change, channel ACL change, key rotation) is
//! applied by the owner and published as a [`SignedList`] on the server
//! topic. Members verify the list against the key they already trust and
//! follow the rotation chain (`signing_pub` signs this list, `next_pub`
//! signs the next one).
//!
//! Invites are self-contained: they embed the chain-head key (the key
//! that will sign the next list), so a joiner can anchor its trust and
//! start verifying lists immediately.

use crate::crypto::card::{PeerCard, SignedProfile};
use crate::error::{PeersError, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use libp2p::identity::{ed25519, Keypair};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub peer_id: String,
    pub name: String,
    pub role: Role,
    pub joined_epoch: u64,
    /// Validated identity card, if the owner has one for this member.
    /// Riding inside the signed list doubles as the DM key exchange.
    #[serde(default)]
    pub card: Option<PeerCard>,
    /// The member's signed display profile (name/about/avatar), if known.
    /// Kept inside the signed list so everyone learns it with the list.
    #[serde(default)]
    pub profile: Option<SignedProfile>,
}

/// A channel plus its ACL (minimum roles to read / write).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Key that signs this invite and the next list; the joiner's trust
    /// anchor (`known_pub`). The invite's signature verifies against it.
    pub next_pub: [u8; 32],
}

/// Self-contained join credential. Anyone holding a valid invite can join.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Invite {
    pub payload: InvitePayload,
    pub sig: String,
    /// The owner's current listen multiaddrs, so the joiner can dial them
    /// directly and form a gossipsub mesh (deterministic connectivity,
    /// instead of relying on DHT discovery luck). Not part of the signed
    /// payload — it's routing metadata only.
    #[serde(default)]
    pub addrs: Vec<String>,
}

impl Invite {
    /// Verifies the invite against the key embedded in its own payload, so
    /// a joiner can authenticate it before trusting `next_pub`.
    pub fn verify(&self) -> Result<()> {
        let bytes = serde_json::to_vec(&self.payload).map_err(PeersError::Serde)?;
        let sig = B64.decode(&self.sig).map_err(|_| PeersError::BadInvite)?;
        let pk = ed25519::PublicKey::try_from_bytes(&self.payload.next_pub)
            .map_err(|_| PeersError::BadInvite)?;
        if !pk.verify(&bytes, &sig) {
            return Err(PeersError::BadInvite);
        }
        Ok(())
    }
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

/// Serializable form of [`ServerKeys`]: the ed25519 keypairs as protobuf
/// bytes (libp2p's own encoding) plus the rotation epoch. Never persisted
/// in plaintext — the whole state envelope is sealed at rest.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PersistedKeys {
    pub current: Vec<u8>,
    pub prev: Option<Vec<u8>>,
    pub epoch: u64,
}

impl ServerKeys {
    /// Encodes the keypair chain for storage.
    pub fn to_persisted(&self) -> PersistedKeys {
        PersistedKeys {
            current: self.current.to_protobuf_encoding().unwrap_or_default(),
            prev: self
                .prev
                .as_ref()
                .and_then(|k| k.to_protobuf_encoding().ok()),
            epoch: self.epoch,
        }
    }

    /// Restores a keypair chain from [`PersistedKeys`].
    pub fn from_persisted(p: &PersistedKeys) -> Result<Self> {
        let current = Keypair::from_protobuf_encoding(&p.current)
            .map_err(|e| PeersError::Crypto(format!("restore server key: {e}")))?;
        let prev = match &p.prev {
            Some(bytes) => Some(
                Keypair::from_protobuf_encoding(bytes)
                    .map_err(|e| PeersError::Crypto(format!("restore server key: {e}")))?,
            ),
            None => None,
        };
        Ok(Self {
            current,
            prev,
            epoch: p.epoch,
        })
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
        let sig = B64.decode(sig).map_err(|_| PeersError::SnapshotCorrupt)?;
        let pk = ed25519::PublicKey::try_from_bytes(pub_bytes)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        if !pk.verify(&bytes, &sig) {
            return Err(PeersError::SnapshotCorrupt);
        }
        Ok(())
    }

    /// Signs the current member list with the chain-linking key.
    pub fn signed_list(&self) -> Result<SignedList> {
        let keys = self.keys.as_ref().ok_or(PeersError::NotOwner)?;
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

    /// Creates an invite anchored on the chain head (the key that will
    /// sign the next list), signed by that same key.
    pub fn invite(&self) -> Result<Invite> {
        let keys = self.keys.as_ref().ok_or(PeersError::NotOwner)?;
        let signing = keys.signing_key();
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        let payload = InvitePayload {
            version: 1,
            server_id: self.id.clone(),
            server_name: self.name.clone(),
            owner_peer: self.owner_peer.clone(),
            nonce,
            next_pub: ed25519_bytes(&signing.public()),
        };
        let bytes = serde_json::to_vec(&payload).map_err(PeersError::Serde)?;
        let sig = signing
            .sign(&bytes)
            .map_err(|e| PeersError::Crypto(format!("invite sign: {e}")))?;
        Ok(Invite {
            payload,
            sig: B64.encode(sig),
            addrs: Vec::new(),
        })
    }

    /// Role of a member, if they are on the list.
    pub fn role_of(&self, peer_id: &str) -> Option<Role> {
        self.members
            .iter()
            .find(|m| m.peer_id == peer_id)
            .map(|m| m.role)
    }

    /// Whether `peer_id` may read messages from the channel.
    pub fn can_read(&self, peer_id: &str, channel: &str) -> bool {
        let Some(cfg) = self.channels.iter().find(|c| c.name == channel) else {
            return false;
        };
        let Some(member) = self.role_of(peer_id) else {
            return false;
        };
        member >= cfg.read_min
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

/// Serializable form of a [`ServerRecord`], stored inside the sealed state
/// envelope so server membership, channels, rotation chain and (for the
/// owner) signing keys survive restarts.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedServer {
    pub id: String,
    pub name: String,
    pub owner_peer: String,
    pub known_pub: Vec<u8>,
    pub members: Vec<Member>,
    pub channels: Vec<ChannelConfig>,
    pub keys: Option<PersistedKeys>,
}

impl ServerRecord {
    /// Flattens the record for storage.
    pub fn to_persisted(&self) -> PersistedServer {
        PersistedServer {
            id: self.id.clone(),
            name: self.name.clone(),
            owner_peer: self.owner_peer.clone(),
            known_pub: self.known_pub.to_vec(),
            members: self.members.clone(),
            channels: self.channels.clone(),
            keys: self.keys.as_ref().map(|k| k.to_persisted()),
        }
    }

    /// Rebuilds a live record from [`PersistedServer`].
    pub fn from_persisted(p: &PersistedServer) -> Result<Self> {
        let known_pub = <[u8; 32]>::try_from(p.known_pub.as_slice())
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        Ok(Self {
            id: p.id.clone(),
            name: p.name.clone(),
            owner_peer: p.owner_peer.clone(),
            known_pub,
            members: p.members.clone(),
            channels: p.channels.clone(),
            keys: match &p.keys {
                Some(k) => Some(ServerKeys::from_persisted(k)?),
                None => None,
            },
        })
    }
}

/// Owner-signed export of a server's full state (members, channels and
/// message history). Anyone holding the server's verified member list can
/// check the signature and import the history; the owner signs with the
/// current chain key.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u8,
    pub server_id: String,
    pub server_name: String,
    pub exported_epoch: u64,
    pub channels: Vec<ChannelConfig>,
    pub members: Vec<Member>,
    pub messages: Vec<SignedMessage>,
    pub sig: String,
}

impl Snapshot {
    /// Builds and signs a snapshot with the server's chain-linking key.
    pub fn sign(rec: &ServerRecord, messages: Vec<SignedMessage>) -> Result<Self> {
        let keys = rec.keys.as_ref().ok_or(PeersError::NotOwner)?;
        let snap = Self {
            version: 1,
            server_id: rec.id.clone(),
            server_name: rec.name.clone(),
            exported_epoch: keys.epoch,
            channels: rec.channels.clone(),
            members: rec.members.clone(),
            messages,
            sig: String::new(),
        };
        let bytes = serde_json::to_vec(&snap).map_err(PeersError::Serde)?;
        let sig = keys.sign(&bytes)?;
        Ok(Self { sig, ..snap })
    }

    /// Verifies the snapshot against the chain key we already trust for
    /// this server, and that it describes the same server id.
    pub fn verify(&self, rec: &ServerRecord) -> Result<()> {
        if self.server_id != rec.id {
            return Err(PeersError::ServerNotFound);
        }
        let mut copy = self.clone();
        let sig = B64
            .decode(&copy.sig)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        copy.sig.clear();
        let bytes = serde_json::to_vec(&copy).map_err(PeersError::Serde)?;
        let pk = ed25519::PublicKey::try_from_bytes(&rec.known_pub)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        if !pk.verify(&bytes, &sig) {
            return Err(PeersError::SnapshotCorrupt);
        }
        Ok(())
    }
}

/// The server-wide gossip topic used for control messages.
pub fn server_topic(server_id: &str) -> String {
    format!("peers/v1/srv/{server_id}")
}

/// The gossip topic for a channel inside a server.
pub fn channel_topic(server_id: &str, channel: &str) -> String {
    format!("peers/v1/ch/{server_id}/{channel}")
}

/// Generates a random server id (hex, 16 chars).
pub fn new_server_id() -> String {
    let mut b = [0u8; 8];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl ServerRecord {
    /// Creates a server owned by `owner_peer` with a fresh signing key.
    pub fn new_owned(id: String, name: String, owner_peer: String, owner_card: PeerCard) -> Self {
        let keys = ServerKeys::new();
        let members = vec![Member {
            peer_id: owner_peer.clone(),
            name: "owner".to_string(),
            role: Role::Owner,
            joined_epoch: 0,
            card: Some(owner_card),
            profile: None,
        }];
        let channels = vec![ChannelConfig {
            name: "general".to_string(),
            topic: "general".to_string(),
            read_min: Role::Member,
            write_min: Role::Member,
        }];
        Self {
            known_pub: keys.signing_pub(),
            keys: Some(keys),
            id,
            name,
            owner_peer,
            members,
            channels,
        }
    }

    /// Creates a joined (non-owner) record anchored on the invite's key.
    /// Members/channels are empty until the first verifiable list arrives.
    pub fn new_joined(invite: &Invite) -> Self {
        Self {
            id: invite.payload.server_id.clone(),
            name: invite.payload.server_name.clone(),
            owner_peer: invite.payload.owner_peer.clone(),
            keys: None,
            known_pub: invite.payload.next_pub,
            members: Vec::new(),
            channels: Vec::new(),
        }
    }
}

/// Registry of servers this node owns or has joined.
#[derive(Default)]
pub struct ServerDir {
    servers: HashMap<String, ServerRecord>,
}

impl ServerDir {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(
        &mut self,
        id: String,
        name: String,
        owner_peer: String,
        owner_card: PeerCard,
    ) -> ServerRecord {
        let rec = ServerRecord::new_owned(id.clone(), name, owner_peer, owner_card);
        self.servers.insert(id, rec.clone());
        rec
    }

    pub fn get(&self, id: &str) -> Option<&ServerRecord> {
        self.servers.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut ServerRecord> {
        self.servers.get_mut(id)
    }

    /// Verifies and applies a joined invite.
    pub fn join(&mut self, invite: &Invite) -> Result<ServerRecord> {
        invite.verify()?;
        if self.servers.contains_key(&invite.payload.server_id) {
            return Err(PeersError::AlreadyMember);
        }
        let rec = ServerRecord::new_joined(invite);
        self.servers.insert(rec.id.clone(), rec.clone());
        Ok(rec)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.servers.remove(id).is_some()
    }

    pub fn views(&self, me: &str) -> Vec<ServerView> {
        self.servers
            .values()
            .map(|s| ServerView::from_record(s, me))
            .collect()
    }

    pub fn view(&self, id: &str, me: &str) -> Option<ServerView> {
        self.servers.get(id).map(|s| ServerView::from_record(s, me))
    }

    /// Clones every record (for persistence / re-subscription).
    pub fn records(&self) -> Vec<ServerRecord> {
        self.servers.values().cloned().collect()
    }

    /// Re-inserts a restored record (persistence reload).
    pub fn restore(&mut self, rec: ServerRecord) {
        self.servers.insert(rec.id.clone(), rec);
    }
}

/// Frontend-friendly snapshot of a server.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    pub id: String,
    pub name: String,
    pub owner_peer: String,
    pub is_owner: bool,
    pub my_role: Option<Role>,
    pub member_count: usize,
    pub epoch: u64,
    /// Joined via invite but not yet on the owner's signed list.
    pub pending: bool,
    pub channels: Vec<ChannelConfig>,
    pub members: Vec<Member>,
}

impl ServerView {
    pub fn from_record(s: &ServerRecord, me: &str) -> Self {
        Self {
            id: s.id.clone(),
            name: s.name.clone(),
            owner_peer: s.owner_peer.clone(),
            is_owner: s.owner_peer == me,
            my_role: s.role_of(me),
            member_count: s.members.len(),
            epoch: s.keys.as_ref().map(|k| k.epoch).unwrap_or(0),
            pending: s.keys.is_none() && s.role_of(me).is_none(),
            channels: s
                .channels
                .iter()
                .filter(|channel| s.can_read(me, &channel.name))
                .cloned()
                .collect(),
            members: s.members.clone(),
        }
    }
}

/// Plaintext notice a joiner publishes on the server topic asking the
/// owner to add them to the signed list. The owner verifies the list
/// membership itself; this is only a request.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinNotice {
    pub kind: String,
    pub server_id: String,
    pub peer_id: String,
    pub name: String,
    pub nonce: [u8; 16],
    /// The joiner's identity card, so the owner can accept and every
    /// member can start an E2E DM with them immediately.
    pub card: PeerCard,
    /// The joiner's signed display profile, so members can show a real
    /// name/avatar right away.
    #[serde(default)]
    pub profile: Option<SignedProfile>,
}

impl JoinNotice {
    pub const KIND: &'static str = "join";

    pub fn new(
        server_id: &str,
        peer_id: &str,
        name: &str,
        nonce: [u8; 16],
        card: PeerCard,
        profile: Option<SignedProfile>,
    ) -> Self {
        Self {
            kind: Self::KIND.to_string(),
            server_id: server_id.to_string(),
            peer_id: peer_id.to_string(),
            name: name.to_string(),
            nonce,
            card,
            profile,
        }
    }
}

/// Plaintext notice a member publishes on the server topic when their
/// profile changes, so the owner (and other members) can cache it; the
/// owner folds it back into the next signed list.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileNotice {
    pub kind: String,
    pub server_id: String,
    pub peer_id: String,
    pub profile: SignedProfile,
}

impl ProfileNotice {
    pub const KIND: &'static str = "profile";

    pub fn new(server_id: &str, peer_id: &str, profile: SignedProfile) -> Self {
        Self {
            kind: Self::KIND.to_string(),
            server_id: server_id.to_string(),
            peer_id: peer_id.to_string(),
            profile,
        }
    }
}

/// The global community topic every peer auto-joins. Self-signed messages
/// only — no owner, no ACL. Membership ("who's here") is derived from the
/// verified profiles seen on it.
pub const PLAZA_TOPIC: &str = "peers/v1/plaza";

/// A self-signed message on the Plaza. `kind = "profile"` carries the
/// sender's [`SignedProfile`] (announcing who they are / that they're here);
/// `kind = "chat"` is a community chat message. Anyone can verify authorship
/// from the embedded pubkey + signature; there is no server membership to
/// check.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlazaMessage {
    pub version: u8,
    pub kind: String,
    pub from: String,
    /// Ed25519 public key of the sender, 32 bytes.
    pub pubkey: [u8; 32],
    pub ts: u64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub profile: Option<SignedProfile>,
    /// The sender's X25519 identity card, so someone who meets them here can
    /// immediately start an encrypted DM — no server membership needed.
    #[serde(default)]
    pub card: Option<PeerCard>,
    pub sig: String,
}

impl PlazaMessage {
    pub const KIND_CHAT: &'static str = "chat";
    pub const KIND_PROFILE: &'static str = "profile";

    pub fn sign(
        keypair: &Keypair,
        kind: &str,
        text: &str,
        profile: Option<SignedProfile>,
        card: Option<PeerCard>,
    ) -> Result<Self> {
        let mut msg = Self {
            version: 1,
            kind: kind.to_string(),
            from: libp2p::PeerId::from(keypair.public()).to_string(),
            pubkey: keypair
                .public()
                .clone()
                .try_into_ed25519()
                .map_err(|_| PeersError::Identity("expected ed25519 key".into()))?
                .to_bytes(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            text: text.to_string(),
            profile,
            card,
            sig: String::new(),
        };
        let bytes = serde_json::to_vec(&msg).map_err(PeersError::Serde)?;
        let sig = keypair
            .sign(&bytes)
            .map_err(|e| PeersError::Crypto(format!("plaza sign: {e}")))?;
        msg.sig = B64.encode(sig);
        Ok(msg)
    }

    /// Verifies the signature and that the embedded key matches `from`'s
    /// peer id. If a profile or a card rides along, those must verify and
    /// be bound to the same sender too.
    pub fn verify(&self) -> Result<()> {
        let pk = ed25519::PublicKey::try_from_bytes(&self.pubkey)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        let mut copy = self.clone();
        let sig = B64
            .decode(&copy.sig)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        copy.sig.clear();
        let bytes = serde_json::to_vec(&copy).map_err(PeersError::Serde)?;
        if !pk.verify(&bytes, &sig) {
            return Err(PeersError::SnapshotCorrupt);
        }
        let from = libp2p::PeerId::from_public_key(&pk.into());
        if from.to_string() != self.from {
            return Err(PeersError::SnapshotCorrupt);
        }
        if let Some(profile) = &self.profile {
            profile.verify()?;
            if profile.peer_id != self.from {
                return Err(PeersError::SnapshotCorrupt);
            }
        }
        if let Some(card) = &self.card {
            card.verify()?;
            if card.ed_pub != self.pubkey {
                return Err(PeersError::SnapshotCorrupt);
            }
        }
        Ok(())
    }
}

/// A channel message: signed by the sender's Ed25519 key, whose public key
/// is embedded so any member can verify authenticity and bind it to the
/// sender's peer ID. Channel messages are broadcast (not encrypted).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedMessage {
    pub version: u8,
    pub server_id: String,
    pub channel: String,
    pub from: String,
    /// Ed25519 public key of the sender, 32 bytes.
    pub pubkey: [u8; 32],
    pub text: String,
    pub ts: u64,
    pub sig: String,
}

impl SignedMessage {
    /// Signs `text` with the caller's identity key. The signature covers
    /// every field except `sig` itself (canonical JSON, declared order).
    pub fn sign(keypair: &Keypair, server_id: &str, channel: &str, text: &str) -> Result<Self> {
        let mut msg = Self {
            version: 1,
            server_id: server_id.to_string(),
            channel: channel.to_string(),
            from: libp2p::PeerId::from(keypair.public()).to_string(),
            pubkey: keypair
                .public()
                .clone()
                .try_into_ed25519()
                .map_err(|_| PeersError::Identity("expected ed25519 key".into()))?
                .to_bytes(),
            text: text.to_string(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            sig: String::new(),
        };
        let bytes = serde_json::to_vec(&msg).map_err(PeersError::Serde)?;
        let sig = keypair
            .sign(&bytes)
            .map_err(|e| PeersError::Crypto(format!("message sign: {e}")))?;
        msg.sig = B64.encode(sig);
        Ok(msg)
    }

    /// Verifies the signature and that the embedded key matches `from`'s
    /// peer ID, the message belongs to this server/channel, and the sender
    /// satisfies the channel write ACL.
    pub fn verify(&self, rec: &ServerRecord) -> Result<()> {
        if self.server_id != rec.id {
            return Err(PeersError::ServerNotFound);
        }
        if rec.role_of(&self.from).is_none() {
            return Err(PeersError::NotInServer);
        }
        if !rec.can_write(&self.from, &self.channel) {
            return Err(PeersError::Forbidden);
        }
        let pk = ed25519::PublicKey::try_from_bytes(&self.pubkey)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        let mut copy = self.clone();
        let sig = B64
            .decode(&copy.sig)
            .map_err(|_| PeersError::SnapshotCorrupt)?;
        copy.sig.clear();
        let bytes = serde_json::to_vec(&copy).map_err(PeersError::Serde)?;
        if !pk.verify(&bytes, &sig) {
            return Err(PeersError::SnapshotCorrupt);
        }
        let from = libp2p::PeerId::from_public_key(&pk.into());
        if from.to_string() != self.from {
            return Err(PeersError::SnapshotCorrupt);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(name: &str) -> ServerRecord {
        let identity = crate::crypto::identity::Identity::new().unwrap();
        ServerRecord::new_owned(
            new_server_id(),
            name.to_string(),
            "alice".to_string(),
            PeerCard::sign(&identity).unwrap(),
        )
    }

    #[test]
    fn invite_verifies() {
        let r = rec("test");
        let invite = r.invite().unwrap();
        assert!(invite.verify().is_ok());
    }

    #[test]
    fn tampered_invite_fails() {
        let r = rec("test");
        let mut invite = r.invite().unwrap();
        invite.payload.next_pub[0] ^= 0xff;
        assert!(matches!(invite.verify(), Err(PeersError::BadInvite)));
    }

    #[test]
    fn list_verifies_and_advances_chain() {
        let owner = rec("chain");
        let list = owner.signed_list().unwrap();
        let mut joiner = ServerRecord::new_joined(&owner.invite().unwrap());
        joiner.verify_list(&list).unwrap();
        assert_eq!(joiner.members.len(), 1);
        assert_eq!(joiner.known_pub, list.payload.next_pub);
    }

    #[test]
    fn rotated_list_links_epochs() {
        let mut owner = rec("rotate");
        owner.keys.as_mut().unwrap().rotate();
        let list = owner.signed_list().unwrap();
        let mut joiner = ServerRecord::new_joined(&owner.invite().unwrap());
        joiner.verify_list(&list).unwrap();
        assert_eq!(joiner.known_pub, list.payload.next_pub);
    }

    #[test]
    fn stale_key_rejected() {
        let mut owner = rec("stale");
        let list0 = owner.signed_list().unwrap();
        let mut joiner = ServerRecord::new_joined(&owner.invite().unwrap());
        joiner.verify_list(&list0).unwrap();
        owner.keys.as_mut().unwrap().rotate();
        let list1 = owner.signed_list().unwrap();
        joiner.verify_list(&list1).unwrap();
        assert!(matches!(
            joiner.verify_list(&list0),
            Err(PeersError::UnknownEpoch)
        ));
    }

    #[test]
    fn role_acls() {
        let mut owner = rec("acl");
        owner.members.push(Member {
            peer_id: "bob".to_string(),
            name: "bob".to_string(),
            role: Role::Member,
            joined_epoch: 1,
            card: None,
            profile: None,
        });
        owner.channels.push(ChannelConfig {
            name: "admin-only".to_string(),
            topic: "admin-only".to_string(),
            read_min: Role::Admin,
            write_min: Role::Admin,
        });
        assert!(owner.can_write("bob", "general"));
        assert!(!owner.can_write("bob", "admin-only"));
        assert!(owner.can_write("alice", "admin-only"));
        assert!(!owner.can_read("bob", "admin-only"));
        assert!(owner.can_read("alice", "admin-only"));
    }

    #[test]
    fn member_ordering() {
        assert!(Role::Member < Role::Admin);
        assert!(Role::Admin < Role::Owner);
    }

    #[test]
    fn signed_message_round_trip() {
        let mut owner = rec("msgs");
        let keypair = Keypair::generate_ed25519();
        let peer_id = libp2p::PeerId::from(keypair.public());
        owner.members.push(Member {
            peer_id: peer_id.to_string(),
            name: "bob".to_string(),
            role: Role::Member,
            joined_epoch: 1,
            card: None,
            profile: None,
        });
        let msg = SignedMessage::sign(&keypair, &owner.id, "general", "hello").unwrap();
        assert!(msg.verify(&owner).is_ok());
        let mut tampered = msg.clone();
        tampered.text = "hacked".to_string();
        assert!(matches!(
            tampered.verify(&owner),
            Err(PeersError::SnapshotCorrupt)
        ));
        let stranger = rec("stranger");
        assert!(matches!(
            msg.verify(&stranger),
            Err(PeersError::NotInServer)
        ));
    }

    #[test]
    fn persisted_record_round_trip() {
        let mut owner = rec("persist");
        owner.keys.as_mut().unwrap().rotate();
        owner.channels.push(ChannelConfig {
            name: "off-topic".to_string(),
            topic: "off-topic".to_string(),
            read_min: Role::Member,
            write_min: Role::Member,
        });
        let p = owner.to_persisted();
        let restored = ServerRecord::from_persisted(&p).unwrap();
        assert_eq!(restored.id, owner.id);
        assert_eq!(restored.name, owner.name);
        assert_eq!(restored.owner_peer, owner.owner_peer);
        assert_eq!(restored.known_pub, owner.known_pub);
        assert_eq!(restored.members, owner.members);
        assert_eq!(restored.channels, owner.channels);
        assert_eq!(restored.keys.as_ref().unwrap().epoch, 1);
        // A restored owner can still sign a verifiable list and invite.
        let list = restored.signed_list().unwrap();
        let mut joiner = ServerRecord::new_joined(&restored.invite().unwrap());
        joiner.verify_list(&list).unwrap();
        assert_eq!(joiner.known_pub, list.payload.next_pub);
    }

    #[test]
    fn snapshot_sign_and_verify() {
        let owner = rec("snap");
        let keypair = Keypair::generate_ed25519();
        let msg = SignedMessage::sign(&keypair, &owner.id, "general", "snapshot this").unwrap();
        let snap = Snapshot::sign(&owner, vec![msg]).unwrap();
        assert!(snap.verify(&owner).is_ok());

        // Signature covers everything: tampered history is rejected.
        let mut tampered = snap.clone();
        tampered.messages[0].text = "rewritten".to_string();
        assert!(matches!(
            tampered.verify(&owner),
            Err(PeersError::SnapshotCorrupt)
        ));

        // A member (non-owner) can verify an owner-made snapshot too.
        let mut member = ServerRecord::new_joined(&owner.invite().unwrap());
        let list = owner.signed_list().unwrap();
        member.verify_list(&list).unwrap();
        assert!(snap.verify(&member).is_ok());
    }
}
