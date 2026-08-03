use crate::p2p::blobs::{BlobCodec, BLOB_PROTOCOL};
use libp2p::kad::store::MemoryStore;
use libp2p::request_response;
use libp2p::swarm::NetworkBehaviour;
use libp2p::{gossipsub, identify, kad, ping};
use std::time::Duration;

/// The full set of protocols the Peers node speaks. The `NetworkBehaviour`
/// derive (from the `macros` feature) delegates to the per-field behaviours;
/// the event enum is user-defined (see [`Event`]).
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
    pub kademlia: kad::Behaviour<MemoryStore>,
    /// `/meshsub/1.1.0` — live message fan-out to subscribed topics.
    pub gossipsub: gossipsub::Behaviour,
    /// `/peers/blob/1.0.0` — on-demand blob fetch from providers.
    pub request_response: request_response::Behaviour<BlobCodec>,
}

/// One variant per sub-behaviour; the swarm loop matches on these.
#[derive(Debug)]
pub enum Event {
    Identify(identify::Event),
    Ping(ping::Event),
    Kademlia(kad::Event),
    Gossipsub(gossipsub::Event),
    RequestResponse(request_response::Event<Vec<u8>, Vec<u8>>),
}

impl From<identify::Event> for Event {
    fn from(event: identify::Event) -> Self {
        Self::Identify(event)
    }
}

impl From<ping::Event> for Event {
    fn from(event: ping::Event) -> Self {
        Self::Ping(event)
    }
}

impl From<kad::Event> for Event {
    fn from(event: kad::Event) -> Self {
        Self::Kademlia(event)
    }
}

impl From<gossipsub::Event> for Event {
    fn from(event: gossipsub::Event) -> Self {
        Self::Gossipsub(event)
    }
}

impl From<request_response::Event<Vec<u8>, Vec<u8>>> for Event {
    fn from(event: request_response::Event<Vec<u8>, Vec<u8>>) -> Self {
        Self::RequestResponse(event)
    }
}

impl Behaviour {
    pub fn new(key: &libp2p::identity::Keypair) -> Result<Self, String> {
        let peer_id = libp2p::PeerId::from(key.public());

        let identify = identify::Behaviour::new(
            identify::Config::new("peers/v1/0.1.0".to_string(), key.public())
                .with_agent_version("peers/0.1.0".to_string()),
        );

        let ping = ping::Behaviour::default();

        let mut kad_config = kad::Config::new(kad::PROTOCOL_NAME);
        kad_config.set_query_timeout(Duration::from_secs(45));
        let mut kademlia =
            kad::Behaviour::with_config(peer_id, MemoryStore::new(peer_id), kad_config);
        // Act as a full DHT server even without a confirmed external
        // address, so parked blobs are findable behind NATs too.
        kademlia.set_mode(Some(kad::Mode::Server));

        let mut gossip_config = gossipsub::ConfigBuilder::default();
        gossip_config.validation_mode(gossipsub::ValidationMode::None);
        gossip_config.heartbeat_interval(Duration::from_secs(10));
        let gossip_config = gossip_config
            .build()
            .map_err(|e| format!("gossipsub config: {e}"))?;
        let gossipsub = gossipsub::Behaviour::new(
            gossipsub::MessageAuthenticity::Signed(key.clone()),
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
