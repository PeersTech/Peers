use crate::p2p::blobs::{BlobCodec, BLOB_PROTOCOL};
use libp2p::kademlia::store::MemoryStore;
use libp2p::request_response;
use libp2p::swarm::NetworkBehaviour;
use libp2p::{gossipsub, identify, kademlia, ping};
use std::time::Duration;

/// The full set of protocols the Peers node speaks. The `NetworkBehaviour`
/// derive (from the `macros` feature) generates the `Event` enum (one
/// variant per field) which the swarm loop matches on.
#[derive(NetworkBehaviour)]
#[behaviour(to_swarm = "Event")]
pub struct Behaviour {
    /// `/ipfs/id/1.0.0` — lets peers announce listen addresses so the DHT
    /// routing table can be populated (kad does NOT hook into identify
    /// automatically; we do it in the event loop).
    pub identify: identify::Behaviour,
    /// `/ipfs/ping/1.0.0` — liveness.
    pub ping: ping::Behaviour,
    /// `/ipfs/kad/1.0.0` — the public IPFS DHT: peer discovery, and
    /// provider records so blobs survive when the sender is offline.
    pub kademlia: kademlia::Behaviour<MemoryStore>,
    /// `/meshsub/1.1.0` — live message fan-out to subscribed topics.
    pub gossipsub: gossipsub::Behaviour,
    /// `/peers/blob/1.0.0` — on-demand blob fetch from providers.
    pub request_response: request_response::Behaviour<BlobCodec>,
}

impl Behaviour {
    pub fn new(key: &libp2p::identity::Keypair) -> Result<Self, String> {
        let peer_id = libp2p::PeerId::from(key.public());

        let identify = identify::Behaviour::new(
            identify::Config::new("peers/v1/0.1.0".to_string(), key.public())
                .with_agent_version("peers/0.1.0".to_string()),
        );

        let ping = ping::Behaviour::default();

        let mut kad_config = kademlia::Config::new(kademlia::PROTOCOL_NAME);
        kad_config.set_query_timeout(Duration::from_secs(45));
        let mut kademlia = kademlia::Behaviour::with_config(
            peer_id,
            MemoryStore::new(peer_id),
            kad_config,
        );
        // Act as a full DHT server even without a confirmed external
        // address, so parked blobs are findable behind NATs too.
        kademlia.set_mode(Some(kademlia::Mode::Server));

        let gossip_config = gossipsub::Config::default()
            .with_validation_mode(gossipsub::ValidationMode::None)
            .with_heartbeat_interval(Duration::from_secs(10));
        let gossipsub = gossipsub::Behaviour::new(
            gossipsub::MessageAuthenticity::Signed(key.public()),
            gossip_config,
        )
        .map_err(|e| format!("gossipsub init: {e}"))?;

        let request_response = request_response::Behaviour::with_codec(
            BlobCodec,
            [(BLOB_PROTOCOL, request_response::ProtocolSupport::Full)],
            request_response::Config::default(),
        );

        Ok(Self {
            identify,
            ping,
            kademlia,
            gossipsub,
            request_response,
        })
    }
}
