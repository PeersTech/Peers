pub mod behaviour;
pub mod blobs;
pub mod bootstrap;

use crate::crypto::identity::Identity;
use crate::error::{PeersError, Result};
use behaviour::Behaviour;
use blobs::{BlobHash, BlobStore};
use futures::StreamExt;
use libp2p::gossipsub::Sha256Topic;
use libp2p::multiaddr::Protocol;
use libp2p::request_response::{
    Event as RequestResponseEvent, Message as RequestResponseMessage, OutboundRequestId,
};
use libp2p::swarm::SwarmEvent;
use libp2p::{gossipsub, identify, kad, ping, relay, Multiaddr, PeerId, Swarm, SwarmBuilder};
use std::collections::{HashMap, HashSet};
use tokio::sync::{broadcast, mpsc};

/// Gossip topic shared by relay nodes and clients. Clients publish tiny
/// "please mesh topic X for me" notices on it so always-on relay nodes
/// know which server/channel/DM topics they must subscribe to (and thus
/// relay) for clients that only meet through them.
pub const RELAY_CONTROL_TOPIC: &str = "peers/v1/relay";

/// A relay-control notice: `{ "op": "subscribe", "topic": "<name>" }`.
#[derive(serde::Deserialize)]
struct RelayControl {
    op: String,
    topic: String,
}

/// Commands sent from the app layer into the swarm loop.
#[derive(Debug)]
pub enum NodeCommand {
    /// Turn the node into an always-on relay: subscribes to
    /// [`RELAY_CONTROL_TOPIC`] and meshes any topic it's asked to relay.
    Relay(bool),
    /// Listen for connections on all interfaces, on `port` for both TCP and
    /// QUIC. Port 0 lets the OS pick (fine for GUI clients, which are dialed
    /// over a relay circuit rather than by address); a node needs a fixed port
    /// so the address it hands out stays valid across restarts.
    Listen {
        port: u16,
    },
    /// Declare publicly reachable addresses the swarm can't observe itself —
    /// on a cloud VM the NIC only carries the private address. Each is added
    /// via `add_external_address`, so it's advertised over identify and the
    /// DHT immediately instead of after the first inbound connection.
    Announce(Vec<Multiaddr>),
    /// Dial bootstrap multiaddrs, seed the DHT routing table, bootstrap.
    Bootstrap(Vec<Multiaddr>),
    /// Dial a single peer directly (e.g. the owner behind an invite).
    Dial(Multiaddr),
    /// Reserve a circuit slot on a relay node: `listen_on(addr + /p2p-circuit)`
    /// so we become reachable as `/p2p/<relay>/p2p-circuit/p2p/<us>` and other
    /// NAT'd peers can dial us through it.
    ListenOnRelay(Multiaddr),
    /// Join a gossip topic ("peers/v1/ch/<channel>").
    Subscribe(String),
    Unsubscribe(String),
    /// Publish a sealed envelope to a subscribed topic.
    Publish {
        topic: String,
        data: Vec<u8>,
    },
    /// Store a blob locally and advertise it on the DHT.
    ParkBlob(Vec<u8>),
    /// Look up DHT providers for a hash and request the blob from them.
    FetchBlob(BlobHash),
    /// Publish our peer id under our friend-code's DHT key, so others can find us.
    PublishCode,
    /// Look up a friend code on the DHT, resolve to a peer id.
    LookupCode(String),
}

/// Events emitted by the node, relayed to the frontend as Tauri events.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NodeEvent {
    Listening {
        addr: String,
    },
    PeerConnected {
        peer_id: String,
    },
    PeerDisconnected {
        peer_id: String,
    },
    /// Raw sealed envelope received on a topic (app layer decrypts it).
    Message {
        topic: String,
        from: String,
        data: Vec<u8>,
    },
    BlobParked {
        hash: String,
    },
    BlobFetched {
        hash: String,
        data: Vec<u8>,
    },
    BlobFetchFailed {
        hash: String,
        reason: String,
    },
    /// A circuit reservation with a relay node was accepted (`active: true`)
    /// or lost when the connection closed (`active: false`).
    RelayReservation {
        relay_peer: String,
        active: bool,
    },
    /// libp2p confirmed (or expired) an externally observed address for us.
    /// A confirmed one means peers can dial us without a relay.
    ExternalAddr {
        addr: String,
        confirmed: bool,
    },
    /// A DCUtR hole-punch attempt finished. `direct: false` is not a failure
    /// worth surfacing loudly — the connection stays relayed and still works.
    HolePunch {
        peer_id: String,
        direct: bool,
    },
    /// A peer code resolved (or failed to resolve) to a peer id via the DHT.
    CodeResolved {
        code: String,
        peer_id: Option<String>,
    },
    Error {
        message: String,
    },
}

/// Best-guess reachability from what libp2p has confirmed. A confirmed
/// external address means peers can dial us directly; a relay reservation
/// with no external address means they reach us through a relay.
///
/// This is a heuristic, not a measurement — it can report "direct" for an
/// address that some networks cannot actually reach — and callers must
/// present it as a guess.
pub fn reachability(external_addrs: usize, relay_reservations: usize) -> &'static str {
    if external_addrs > 0 {
        "direct"
    } else if relay_reservations > 0 {
        "relayed"
    } else {
        "unknown"
    }
}

/// Handle to a running node. Cloneable; commands are queued and processed
/// by the swarm task.
#[derive(Clone)]
pub struct NodeHandle {
    tx: mpsc::Sender<NodeCommand>,
    events: broadcast::Sender<NodeEvent>,
}

impl NodeHandle {
    pub async fn send(&self, cmd: NodeCommand) -> Result<()> {
        self.tx
            .send(cmd)
            .await
            .map_err(|_| PeersError::P2p("node is not running".into()))
    }

    /// Subscribe to node events (e.g. from a Tauri event relay task).
    pub fn subscribe(&self) -> broadcast::Receiver<NodeEvent> {
        self.events.subscribe()
    }
}

/// Builds the swarm, opens listeners and spawns the event loop task.
///
/// `serve_relay` turns on the circuit-relay server role (accepting
/// reservations and forwarding connections). Only headless `--node` builds
/// pass `true`; GUI clients relay nothing (tiered relaying).
pub fn spawn(identity: Identity, serve_relay: bool) -> Result<NodeHandle> {
    let swarm = SwarmBuilder::with_existing_identity(identity.keypair.clone())
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default(),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .map_err(|e| PeersError::P2p(format!("tcp transport: {e}")))?
        .with_quic()
        .with_relay_client(libp2p::noise::Config::new, libp2p::yamux::Config::default)
        .map_err(|e| PeersError::P2p(format!("relay client transport: {e}")))?
        .with_behaviour(|key, relay_client| {
            behaviour::Behaviour::new(key, relay_client, serve_relay)
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })
        })
        .map_err(|e| PeersError::P2p(format!("behaviour init: {e}")))?
        .build();

    let (tx, rx) = mpsc::channel::<NodeCommand>(128);
    let (events, _) = broadcast::channel::<NodeEvent>(256);

    tokio::spawn(Node::run(swarm, rx, events.clone()));

    Ok(NodeHandle { tx, events })
}

/// Hex-encodes a blob hash.
pub fn hex_hash(h: &BlobHash) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}

/// Parses a 64-char hex blob hash.
pub fn parse_hex_hash(s: &str) -> Option<BlobHash> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

struct Node {
    swarm: Swarm<Behaviour>,
    blobs: BlobStore,
    topics: HashMap<String, Sha256Topic>,
    /// Blob hash per active DHT provider lookup.
    pending_fetches: HashMap<kad::QueryId, BlobHash>,
    /// Friend code per active DHT code lookup.
    pending_codes: HashMap<kad::QueryId, String>,
    /// Blob hash per in-flight request-response request.
    fetch_requests: HashMap<OutboundRequestId, BlobHash>,
    /// Hashes with an active (or completed) blob request, to avoid dupes.
    in_flight: HashSet<BlobHash>,
    /// Hashes we already announced as providers.
    announced: HashSet<BlobHash>,
    /// Addresses learned from DHT routing updates + identify.
    peer_addresses: HashMap<PeerId, Vec<Multiaddr>>,
    /// Relays we currently hold a circuit reservation with. A set, not a
    /// counter, so a repeated accept cannot inflate it and a disconnect
    /// removes exactly one entry.
    relay_reservations: HashSet<PeerId>,
    /// Addresses libp2p has confirmed as externally observed.
    external_addrs: HashSet<Multiaddr>,
    /// Whether this node relays gossip for topics it's told about.
    relay: bool,
    events: broadcast::Sender<NodeEvent>,
}

impl Node {
    async fn run(
        swarm: Swarm<Behaviour>,
        mut cmds: mpsc::Receiver<NodeCommand>,
        events: broadcast::Sender<NodeEvent>,
    ) {
        let mut node = Node {
            swarm,
            blobs: BlobStore::new(),
            topics: HashMap::new(),
            pending_fetches: HashMap::new(),
            pending_codes: HashMap::new(),
            fetch_requests: HashMap::new(),
            in_flight: HashSet::new(),
            announced: HashSet::new(),
            peer_addresses: HashMap::new(),
            relay_reservations: HashSet::new(),
            external_addrs: HashSet::new(),
            relay: false,
            events,
        };

        loop {
            tokio::select! {
                cmd = cmds.recv() => match cmd {
                    None => break,
                    Some(cmd) => node.handle_command(cmd),
                },
                ev = node.swarm.next() => match ev {
                    None => break,
                    Some(ev) => node.handle_swarm_event(ev),
                },
            }
        }
    }

    fn emit(&self, ev: NodeEvent) {
        let _ = self.events.send(ev);
    }

    fn handle_command(&mut self, cmd: NodeCommand) {
        match cmd {
            NodeCommand::Relay(on) => {
                self.relay = on;
                if on {
                    let topic = Sha256Topic::new(RELAY_CONTROL_TOPIC.to_string());
                    if self
                        .swarm
                        .behaviour_mut()
                        .gossipsub
                        .subscribe(&topic)
                        .is_ok()
                    {
                        self.topics.insert(RELAY_CONTROL_TOPIC.to_string(), topic);
                    }
                }
            }
            NodeCommand::Listen { port } => {
                for addr in [
                    format!("/ip4/0.0.0.0/tcp/{port}"),
                    format!("/ip4/0.0.0.0/udp/{port}/quic-v1"),
                ] {
                    match addr.parse::<Multiaddr>() {
                        Ok(ma) => {
                            let _ = self.swarm.listen_on(ma);
                        }
                        Err(e) => self.emit(NodeEvent::Error {
                            message: format!("bad listen addr {addr}: {e}"),
                        }),
                    }
                }
            }
            NodeCommand::Announce(addrs) => {
                for ma in addrs {
                    self.swarm.add_external_address(ma);
                }
            }
            NodeCommand::Bootstrap(addrs) => {
                for addr in addrs {
                    let mut ma = addr.clone();
                    match ma.pop() {
                        Some(Protocol::P2p(peer)) => {
                            self.swarm
                                .behaviour_mut()
                                .kademlia
                                .add_address(&peer, ma.clone());
                            let _ = self.swarm.dial(ma);
                        }
                        _ => {
                            let _ = self.swarm.dial(ma);
                        }
                    }
                }
                let _ = self.swarm.behaviour_mut().kademlia.bootstrap();
            }
            NodeCommand::Dial(addr) => {
                let _ = self.swarm.dial(addr);
            }
            NodeCommand::ListenOnRelay(addr) => {
                let mut ma = addr.clone();
                ma.push(Protocol::P2pCircuit);
                match self.swarm.listen_on(ma) {
                    Ok(_) => {}
                    Err(e) => self.emit(NodeEvent::Error {
                        message: format!("listen on relay {addr}: {e}"),
                    }),
                }
            }
            NodeCommand::Subscribe(topic_name) => {
                let topic = Sha256Topic::new(topic_name.clone());
                match self.swarm.behaviour_mut().gossipsub.subscribe(&topic) {
                    Ok(_) => {
                        self.topics.insert(topic_name, topic);
                    }
                    Err(e) => self.emit(NodeEvent::Error {
                        message: format!("subscribe {topic_name}: {e}"),
                    }),
                }
            }
            NodeCommand::Unsubscribe(topic_name) => {
                if let Some(topic) = self.topics.remove(&topic_name) {
                    self.swarm.behaviour_mut().gossipsub.unsubscribe(&topic);
                }
            }
            NodeCommand::Publish { topic, data } => {
                let Some(topic) = self.topics.get(&topic) else {
                    self.emit(NodeEvent::Error {
                        message: "publish to unsubscribed topic".into(),
                    });
                    return;
                };
                match self
                    .swarm
                    .behaviour_mut()
                    .gossipsub
                    .publish(topic.hash(), data)
                {
                    Ok(_) => {}
                    Err(e) => self.emit(NodeEvent::Error {
                        message: format!("publish: {e}"),
                    }),
                }
            }
            NodeCommand::ParkBlob(data) => {
                let hash = self.blobs.put(&data);
                if !self.announced.contains(&hash) {
                    match self
                        .swarm
                        .behaviour_mut()
                        .kademlia
                        .start_providing(kad::RecordKey::new(&hash))
                    {
                        Ok(_) => {
                            self.announced.insert(hash);
                            self.emit(NodeEvent::BlobParked {
                                hash: hex_hash(&hash),
                            });
                        }
                        Err(e) => self.emit(NodeEvent::Error {
                            message: format!("provide {hash:?}: {e}"),
                        }),
                    }
                } else {
                    self.emit(NodeEvent::BlobParked {
                        hash: hex_hash(&hash),
                    });
                }
            }
            NodeCommand::FetchBlob(hash) => {
                if self.in_flight.contains(&hash)
                    || self.pending_fetches.values().any(|h| *h == hash)
                {
                    return;
                }
                let qid = self
                    .swarm
                    .behaviour_mut()
                    .kademlia
                    .get_providers(kad::RecordKey::new(&hash));
                self.pending_fetches.insert(qid, hash);
            }
            NodeCommand::PublishCode => {
                // Announce ourselves as the provider of our own code's DHT key.
                // This is the same provider machinery blobs use — a code is
                // just a well-known key that maps to whoever claims it.
                let me = *self.swarm.local_peer_id();
                let code = crate::crypto::code::short_code(&me);
                let key = crate::crypto::code::code_key(&code);
                match self
                    .swarm
                    .behaviour_mut()
                    .kademlia
                    .start_providing(kad::RecordKey::new(&key))
                {
                    Ok(_) => {}
                    Err(e) => self.emit(NodeEvent::Error {
                        message: format!("publish code: {e}"),
                    }),
                }
            }
            NodeCommand::LookupCode(code) => {
                let key = crate::crypto::code::code_key(&code);
                let qid = self
                    .swarm
                    .behaviour_mut()
                    .kademlia
                    .get_providers(kad::RecordKey::new(&key));
                self.pending_codes.insert(qid, code);
            }
        }
    }

    fn handle_swarm_event(&mut self, ev: SwarmEvent<behaviour::Event>) {
        match ev {
            SwarmEvent::NewListenAddr { address, .. } => {
                self.emit(NodeEvent::Listening {
                    addr: address.to_string(),
                });
            }
            SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                self.emit(NodeEvent::PeerConnected {
                    peer_id: peer_id.to_string(),
                });
            }
            SwarmEvent::ConnectionClosed {
                peer_id,
                num_established,
                ..
            } => {
                // Only when the last connection to this peer is gone is any
                // reservation with it actually lost.
                if num_established == 0 && self.relay_reservations.remove(&peer_id) {
                    self.emit(NodeEvent::RelayReservation {
                        relay_peer: peer_id.to_string(),
                        active: false,
                    });
                }
                self.emit(NodeEvent::PeerDisconnected {
                    peer_id: peer_id.to_string(),
                });
            }
            SwarmEvent::ExternalAddrConfirmed { address } => {
                if self.external_addrs.insert(address.clone()) {
                    self.emit(NodeEvent::ExternalAddr {
                        addr: address.to_string(),
                        confirmed: true,
                    });
                }
            }
            SwarmEvent::ExternalAddrExpired { address } => {
                if self.external_addrs.remove(&address) {
                    self.emit(NodeEvent::ExternalAddr {
                        addr: address.to_string(),
                        confirmed: false,
                    });
                }
            }
            SwarmEvent::Behaviour(be) => self.handle_behaviour_event(be),
            _ => {}
        }
    }

    fn handle_behaviour_event(&mut self, ev: behaviour::Event) {
        match ev {
            behaviour::Event::Identify(ev) => {
                if let identify::Event::Received { info, .. } = *ev {
                    let peer = info.public_key.to_peer_id();
                    let addrs: Vec<Multiaddr> = info.listen_addrs.clone();
                    for addr in &addrs {
                        self.swarm
                            .behaviour_mut()
                            .kademlia
                            .add_address(&peer, addr.clone());
                    }
                    self.peer_addresses.insert(peer, addrs);
                    // The address the relay/router observed for us is our best
                    // external (NAT-mapped) address — a DCUtR hole-punch
                    // candidate.
                    if let Some(observed) = info.observed_addr.clone() {
                        self.swarm.add_external_address(observed);
                    }
                }
            }
            behaviour::Event::RelayClient(ev) => {
                if let relay::client::Event::ReservationReqAccepted { relay_peer_id, .. } = ev {
                    // Renewals re-fire this event; the set makes that a no-op.
                    if self.relay_reservations.insert(relay_peer_id) {
                        self.emit(NodeEvent::RelayReservation {
                            relay_peer: relay_peer_id.to_string(),
                            active: true,
                        });
                    }
                }
            }
            behaviour::Event::RelayServer(_) => {}
            behaviour::Event::Dcutr(ev) => {
                // DCUtR upgrades a relayed connection to a direct hole-punched
                // one. Failure is not an error worth alarming the user about —
                // the connection stays relayed and chat keeps working.
                self.emit(NodeEvent::HolePunch {
                    peer_id: ev.remote_peer_id.to_string(),
                    direct: ev.result.is_ok(),
                });
            }
            behaviour::Event::Ping(ping::Event { peer, result, .. }) => {
                if let Err(e) = result {
                    self.emit(NodeEvent::Error {
                        message: format!("ping to {peer} failed: {e}"),
                    });
                }
            }
            behaviour::Event::Kademlia(kev) => match kev {
                kad::Event::OutboundQueryProgressed { id, result, .. } => {
                    self.handle_query_progress(id, result);
                }
                kad::Event::RoutingUpdated {
                    peer, addresses, ..
                } => {
                    self.peer_addresses
                        .insert(peer, addresses.iter().cloned().collect());
                }
                _ => {}
            },
            behaviour::Event::Gossipsub(gev) => {
                if let gossipsub::Event::Message { message, .. } = gev {
                    let control_hash = Sha256Topic::new(RELAY_CONTROL_TOPIC.to_string()).hash();
                    // Relay nodes mesh any topic they're asked to relay, so
                    // peers that only meet through them still gossip.
                    if self.relay && message.topic == control_hash {
                        if let Ok(ctrl) = serde_json::from_slice::<RelayControl>(&message.data) {
                            if ctrl.op == "subscribe" && !ctrl.topic.is_empty() {
                                let topic = Sha256Topic::new(ctrl.topic.clone());
                                match self.swarm.behaviour_mut().gossipsub.subscribe(&topic) {
                                    Ok(_) => {
                                        self.topics.insert(ctrl.topic.clone(), topic);
                                    }
                                    Err(e) => self.emit(NodeEvent::Error {
                                        message: format!("relay subscribe {}: {e}", ctrl.topic),
                                    }),
                                }
                            }
                        }
                    }
                    // Relay control traffic is internal; never surface it as
                    // a user message.
                    if message.topic == control_hash {
                        return;
                    }
                    if let Some(from) = message.source {
                        self.emit(NodeEvent::Message {
                            topic: message.topic.to_string(),
                            from: from.to_string(),
                            data: message.data,
                        });
                    }
                }
            },
            behaviour::Event::RequestResponse(rrev) => match *rrev {
                RequestResponseEvent::Message { message, .. } => match message {
                    RequestResponseMessage::Request {
                        request, channel, ..
                    } => {
                        let mut hash = [0u8; 32];
                        if request.len() == 32 {
                            hash.copy_from_slice(&request);
                        }
                        let resp = self.blobs.get(&hash).unwrap_or_default();
                        let _ = self
                            .swarm
                            .behaviour_mut()
                            .request_response
                            .send_response(channel, resp);
                    }
                    RequestResponseMessage::Response {
                        request_id,
                        response,
                    } => {
                        if let Some(hash) = self.fetch_requests.remove(&request_id) {
                            self.in_flight.remove(&hash);
                            self.pending_fetches.retain(|_, h| *h != hash);
                            let actual = self.blobs.put(&response);
                            if actual != hash {
                                self.emit(NodeEvent::BlobFetchFailed {
                                    hash: hex_hash(&hash),
                                    reason: "hash mismatch (corrupt or tampered)".into(),
                                });
                            } else {
                                self.emit(NodeEvent::BlobFetched {
                                    hash: hex_hash(&hash),
                                    data: response,
                                });
                            }
                        }
                    }
                },
                RequestResponseEvent::OutboundFailure { request_id, .. } => {
                    if let Some(hash) = self.fetch_requests.remove(&request_id) {
                        self.in_flight.remove(&hash);
                    }
                }
                RequestResponseEvent::ResponseSent { .. }
                | RequestResponseEvent::InboundFailure { .. } => {}
            },
        }
    }

    fn handle_query_progress(&mut self, id: kad::QueryId, result: kad::QueryResult) {
        match result {
            kad::QueryResult::GetProviders(res) => {
                // A code lookup and a blob fetch both ride the provider
                // machinery; the query id tells us which this is.
                if let Some(code) = self.pending_codes.get(&id).cloned() {
                    match res {
                        Ok(kad::GetProvidersOk::FoundProviders { providers, .. }) => {
                            if let Some(peer) = providers.into_iter().next() {
                                self.pending_codes.remove(&id);
                                // The code only *locates* a peer. Whoever answers
                                // still has to prove who they are before the user
                                // accepts them — see crypto::code.
                                self.emit(NodeEvent::CodeResolved {
                                    code,
                                    peer_id: Some(peer.to_string()),
                                });
                            }
                        }
                        Ok(kad::GetProvidersOk::FinishedWithNoAdditionalRecord { .. }) => {
                            self.pending_codes.remove(&id);
                            self.emit(NodeEvent::CodeResolved {
                                code,
                                peer_id: None,
                            });
                        }
                        Err(_) => {
                            self.pending_codes.remove(&id);
                            self.emit(NodeEvent::CodeResolved {
                                code,
                                peer_id: None,
                            });
                        }
                    }
                    return;
                }
                let Some(&hash) = self.pending_fetches.get(&id) else {
                    return;
                };
                match res {
                    Ok(kad::GetProvidersOk::FoundProviders { providers, .. }) => {
                        if self.in_flight.contains(&hash) {
                            return;
                        }
                        if let Some(provider) = providers.into_iter().next() {
                            self.in_flight.insert(hash);
                            let addrs = self
                                .peer_addresses
                                .get(&provider)
                                .cloned()
                                .unwrap_or_default();
                            let rid = self
                                .swarm
                                .behaviour_mut()
                                .request_response
                                .send_request_with_addresses(&provider, hash.to_vec(), addrs);
                            self.fetch_requests.insert(rid, hash);
                        }
                    }
                    Ok(kad::GetProvidersOk::FinishedWithNoAdditionalRecord { .. }) => {
                        if !self.in_flight.contains(&hash) {
                            self.pending_fetches.remove(&id);
                            self.emit(NodeEvent::BlobFetchFailed {
                                hash: hex_hash(&hash),
                                reason: "no providers found".into(),
                            });
                        }
                    }
                    Err(e) => {
                        self.pending_fetches.remove(&id);
                        self.in_flight.remove(&hash);
                        self.emit(NodeEvent::BlobFetchFailed {
                            hash: hex_hash(&hash),
                            reason: format!("dht lookup failed: {e}"),
                        });
                    }
                }
            }
            kad::QueryResult::StartProviding(Err(e)) => {
                self.emit(NodeEvent::Error {
                    message: format!("provider announcement failed: {e}"),
                });
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;

    /// A confirmed external address beats a reservation: if peers can dial us
    /// directly, the relay is only a fallback.
    #[test]
    fn reachability_prefers_direct() {
        assert_eq!(reachability(1, 0), "direct");
        assert_eq!(reachability(1, 3), "direct");
    }

    #[test]
    fn reachability_is_relayed_when_only_reservations() {
        assert_eq!(reachability(0, 1), "relayed");
    }

    /// "unknown" is not "offline" — it means libp2p has not confirmed
    /// anything yet, which is the normal state right after startup.
    #[test]
    fn reachability_unknown_when_nothing_known() {
        assert_eq!(reachability(0, 0), "unknown");
    }
}
