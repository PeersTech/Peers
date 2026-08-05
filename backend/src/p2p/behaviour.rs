use crate::p2p::blobs::{BlobCodec, BLOB_PROTOCOL};
use libp2p::kad::store::MemoryStore;
use libp2p::request_response;
use libp2p::swarm::NetworkBehaviour;
use libp2p::{dcutr, gossipsub, identify, kad, ping, relay};
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
    /// Circuit Relay v2 client — lets us dial and reserve slots through
    /// always-on backbone nodes, so NAT'd peers can reach us.
    pub relay_client: relay::client::Behaviour,
    /// Circuit Relay v2 server — forwards connections between NAT'd peers.
    /// Tiered relaying: headless `--node` builds get a full budget, GUI
    /// clients a modest one (harmless when unreachable, useful when not),
    /// and `PEERS_NO_RELAY=1` disables it entirely. See [`RelayCaps`].
    pub relay_server: relay::Behaviour,
    /// DCUtR — after a relayed rendezvous, hole-punches NATs to upgrade to
    /// a direct (faster) connection.
    pub dcutr: dcutr::Behaviour,
}

/// One variant per sub-behaviour; the swarm loop matches on these.
#[derive(Debug)]
pub enum Event {
    Identify(Box<identify::Event>),
    Ping(ping::Event),
    Kademlia(kad::Event),
    Gossipsub(gossipsub::Event),
    RequestResponse(Box<request_response::Event<Vec<u8>, Vec<u8>>>),
    RelayClient(relay::client::Event),
    RelayServer(relay::Event),
    Dcutr(dcutr::Event),
}

impl From<identify::Event> for Event {
    fn from(event: identify::Event) -> Self {
        Self::Identify(Box::new(event))
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
        Self::RequestResponse(Box::new(event))
    }
}

impl From<relay::client::Event> for Event {
    fn from(event: relay::client::Event) -> Self {
        Self::RelayClient(event)
    }
}

impl From<relay::Event> for Event {
    fn from(event: relay::Event) -> Self {
        Self::RelayServer(event)
    }
}

impl From<dcutr::Event> for Event {
    fn from(event: dcutr::Event) -> Self {
        Self::Dcutr(event)
    }
}

/// Relay capacity by tier (M12).
///
/// Every install is a node, so GUI clients are **not** pinned to zero: an
/// unreachable client can advertise slots harmlessly, because nobody can dial
/// it to use them. Reachability decides who actually carries traffic, exactly
/// as open-port peers carry a torrent swarm. Users who turn out to be
/// reachable (public IP, port forwarding, open IPv6) become real backbone
/// without configuring anything; users behind CGNAT are unaffected.
///
/// Set `PEERS_NO_RELAY=1` to opt out and relay nothing.
pub struct RelayCaps {
    pub max_reservations: usize,
    pub max_reservations_per_peer: usize,
    pub max_circuits: usize,
    pub max_circuits_per_peer: usize,
    pub max_circuit_bytes: u64,
}

impl RelayCaps {
    /// A GUI client that happens to be reachable. Modest budget: it is
    /// someone's laptop, and chat traffic is small — but a handful of these
    /// is what keeps the mesh from depending on dedicated nodes.
    pub fn citizen() -> Self {
        Self {
            max_reservations: 8,
            max_reservations_per_peer: 2,
            max_circuits: 16,
            max_circuits_per_peer: 2,
            max_circuit_bytes: 16 * 1024 * 1024,
        }
    }

    /// Opted out: forward nothing.
    pub fn off() -> Self {
        Self {
            max_reservations: 0,
            max_reservations_per_peer: 0,
            max_circuits: 0,
            max_circuits_per_peer: 0,
            max_circuit_bytes: 0,
        }
    }

    /// Always-on `--node` processes. The per-peer caps matter more than the
    /// totals: they stop one busy peer consuming every slot on a shared box.
    pub fn node() -> Self {
        Self {
            max_reservations: 64,
            max_reservations_per_peer: 4,
            max_circuits: 64,
            max_circuits_per_peer: 8,
            max_circuit_bytes: 128 * 1024 * 1024,
        }
    }

    /// Picks the tier for this process. `serve_relay` is true only for
    /// headless `--node`; everything else is a citizen unless opted out.
    pub fn for_role(serve_relay: bool) -> Self {
        if std::env::var("PEERS_NO_RELAY").is_ok() {
            return Self::off();
        }
        if serve_relay {
            Self::node()
        } else {
            Self::citizen()
        }
    }
}

impl Behaviour {
    pub fn new(
        key: &libp2p::identity::Keypair,
        relay_client: relay::client::Behaviour,
        serve_relay: bool,
    ) -> Result<Self, String> {
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

        // Circuit relay v2 server. Every install can forward traffic; whether
        // it actually does is decided by reachability, not by this config.
        let caps = RelayCaps::for_role(serve_relay);
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
        let relay_server = relay::Behaviour::new(peer_id, relay_cfg);

        let dcutr = dcutr::Behaviour::new(peer_id);

        Ok(Self {
            identify,
            ping,
            kademlia,
            gossipsub,
            request_response,
            relay_client,
            relay_server,
            dcutr,
        })
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;

    #[test]
    fn opt_out_forwards_nothing() {
        let c = RelayCaps::off();
        assert_eq!(c.max_reservations, 0);
        assert_eq!(c.max_circuits, 0);
    }

    /// Citizens must advertise slots — that is the whole point of "every
    /// install is a node". Unreachable ones simply never get dialed.
    #[test]
    fn citizen_tier_relays_something() {
        let c = RelayCaps::citizen();
        assert!(c.max_reservations > 0, "clients must be able to relay");
        assert!(c.max_circuits > 0);
    }

    #[test]
    fn citizen_budget_is_smaller_than_a_dedicated_node() {
        let c = RelayCaps::citizen();
        let n = RelayCaps::node();
        assert!(c.max_reservations < n.max_reservations);
        assert!(c.max_circuits < n.max_circuits);
        assert!(c.max_circuit_bytes < n.max_circuit_bytes);
    }

    #[test]
    fn node_tier_is_bounded_for_low_end_hardware() {
        let c = RelayCaps::node();
        assert!(c.max_reservations > 0);
        assert!(
            c.max_reservations <= 128,
            "a Pi must not accept unbounded reservations"
        );
        assert!(c.max_circuits_per_peer <= c.max_circuits);
        assert!(c.max_reservations_per_peer <= c.max_reservations);
        assert!(c.max_circuit_bytes <= 256 * 1024 * 1024);
    }

    /// Per-peer caps are what stop one busy peer eating every slot.
    #[test]
    fn per_peer_caps_are_strictly_smaller_than_totals() {
        for c in [RelayCaps::citizen(), RelayCaps::node()] {
            assert!(c.max_reservations_per_peer < c.max_reservations);
            assert!(c.max_circuits_per_peer < c.max_circuits);
        }
    }
}
