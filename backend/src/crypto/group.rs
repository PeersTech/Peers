use crate::crypto::identity::Identity;
use crate::error::{PeersError, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use libp2p::identity::ed25519;
use serde::{Deserialize, Serialize};

const GROUP_DOMAIN: &[u8] = b"peers/v1/group";
const MAX_GROUP_NAME: usize = 64;
const MAX_GROUP_MEMBERS: usize = 64;
pub const GROUP_TOPIC_PREFIX: &str = "peers/v1/group/";

pub fn group_topic(group_id: &str) -> String {
    format!("{GROUP_TOPIC_PREFIX}{group_id}")
}

/// A member of a group DM. The X25519 key is enough for multi-recipient
/// sealing; the owner authenticates the membership set with `owner_pub`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub peer_id: String,
    pub x25519_pub: [u8; 32],
}

/// Signed, membership-revisioned descriptor for a serverless group DM.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDescriptor {
    pub version: u8,
    pub group_id: String,
    pub name: String,
    pub owner_peer: String,
    pub owner_pub: [u8; 32],
    pub members: Vec<GroupMember>,
    pub revision: u64,
    pub created_at: u64,
    pub sig: String,
}

impl GroupDescriptor {
    pub fn sign(
        identity: &Identity,
        group_id: &str,
        name: &str,
        mut members: Vec<GroupMember>,
    ) -> Result<Self> {
        let owner_peer = identity.peer_id.to_string();
        let owner_member = GroupMember {
            peer_id: owner_peer.clone(),
            x25519_pub: identity.x25519_public(),
        };
        if !members.iter().any(|member| member.peer_id == owner_peer) {
            members.push(owner_member);
        }
        members.sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
        members.dedup_by(|a, b| a.peer_id == b.peer_id);
        let mut descriptor = Self {
            version: 1,
            group_id: group_id.to_string(),
            name: name.trim().to_string(),
            owner_peer,
            owner_pub: identity.ed25519_public()?,
            members,
            revision: 1,
            created_at: now_secs(),
            sig: String::new(),
        };
        descriptor.validate_shape()?;
        let bytes = serde_json::to_vec(&descriptor).map_err(PeersError::Serde)?;
        let message = signed_bytes(&bytes);
        let sig = identity
            .keypair
            .sign(&message)
            .map_err(|e| PeersError::Crypto(format!("group descriptor sign: {e}")))?;
        descriptor.sig = B64.encode(sig);
        Ok(descriptor)
    }

    pub fn verify(&self) -> Result<()> {
        self.validate_shape()?;
        let owner = ed25519::PublicKey::try_from_bytes(&self.owner_pub)
            .map_err(|_| PeersError::Crypto("invalid group owner key".into()))?;
        let sig = B64
            .decode(&self.sig)
            .map_err(|_| PeersError::Crypto("group signature is not base64".into()))?;
        let mut copy = self.clone();
        copy.sig.clear();
        let bytes = serde_json::to_vec(&copy).map_err(PeersError::Serde)?;
        if !owner.verify(&signed_bytes(&bytes), &sig) {
            return Err(PeersError::Crypto("invalid group descriptor signature".into()));
        }
        let derived = libp2p::PeerId::from_public_key(&owner.into()).to_string();
        if derived != self.owner_peer {
            return Err(PeersError::Crypto("group owner peer id mismatch".into()));
        }
        Ok(())
    }

    fn validate_shape(&self) -> Result<()> {
        if self.version != 1
            || self.group_id.is_empty()
            || self.group_id.len() > 64
            || !self.group_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || self.name.is_empty()
            || self.name.len() > MAX_GROUP_NAME
            || self.members.is_empty()
            || self.members.len() > MAX_GROUP_MEMBERS
            || self.revision == 0
        {
            return Err(PeersError::Other("invalid group descriptor".into()));
        }
        let mut previous = "";
        let mut owner_present = false;
        for member in &self.members {
            if member.peer_id.is_empty()
                || member.peer_id.len() > 128
                || member.peer_id.as_str() <= previous
            {
                return Err(PeersError::Other("group members must be sorted and unique".into()));
            }
            previous = &member.peer_id;
            owner_present |= member.peer_id == self.owner_peer;
        }
        if !owner_present {
            return Err(PeersError::Other("group owner is not a member".into()));
        }
        Ok(())
    }
}

/// Private group invitation. The descriptor is public; delivery is private
/// because callers send this object inside a sealed DM envelope.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInvite {
    pub kind: String,
    pub descriptor: GroupDescriptor,
}

impl GroupInvite {
    pub const KIND: &'static str = "group-invite";

    pub fn new(descriptor: GroupDescriptor) -> Self {
        Self { kind: Self::KIND.to_string(), descriptor }
    }

    pub fn verify(&self) -> Result<()> {
        if self.kind != Self::KIND {
            return Err(PeersError::Other("not a group invitation".into()));
        }
        self.descriptor.verify()
    }
}

fn signed_bytes(payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(GROUP_DOMAIN.len() + payload.len());
    bytes.extend_from_slice(GROUP_DOMAIN);
    bytes.extend_from_slice(payload);
    bytes
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(identity: &Identity) -> GroupMember {
        GroupMember { peer_id: identity.peer_id.to_string(), x25519_pub: identity.x25519_public() }
    }

    #[test]
    fn descriptor_round_trip_and_tamper_detection() {
        let owner = Identity::new().unwrap();
        let guest = Identity::new().unwrap();
        let descriptor = GroupDescriptor::sign(
            &owner,
            "group-test",
            "Friends",
            vec![member(&guest)],
        )
        .unwrap();
        descriptor.verify().unwrap();
        let mut tampered = descriptor;
        tampered.name = "Hijacked".into();
        assert!(tampered.verify().is_err());
    }

    #[test]
    fn invite_requires_valid_kind_and_descriptor() {
        let owner = Identity::new().unwrap();
        let descriptor = GroupDescriptor::sign(&owner, "group-test", "Friends", vec![]).unwrap();
        let invite = GroupInvite::new(descriptor);
        invite.verify().unwrap();
        let mut bad = invite;
        bad.kind = "other".into();
        assert!(bad.verify().is_err());
    }
}
