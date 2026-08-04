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
use libp2p::{gossipsub, identify, kad, ping, Multiaddr, PeerId, Swarm, SwarmBuilder};
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
    /// Listen for connections on all interfaces.
    Listen,
    /// Dial bootstrap multiaddrs, seed the DHT routing table, bootstrap.
    Bootstrap(Vec<Multiaddr>),
    /// Dial a single peer directly (e.g. the owner behind an invite).
    Dial(Multiaddr),
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
    Error {
        message: String,
    },
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
pub fn spawn(identity: Identity) -> Result<NodeHandle> {
    let swarm = SwarmBuilder::with_existing_identity(identity.keypair.clone())
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default(),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .map_err(|e| PeersError::P2p(format!("tcp transport: {e}")))?
        .with_quic()
        .with_behaviour(|key| {
            behaviour::Behaviour::new(key)
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
    /// Blob hash per in-flight request-response request.
    fetch_requests: HashMap<OutboundRequestId, BlobHash>,
    /// Hashes with an active (or completed) blob request, to avoid dupes.
    in_flight: HashSet<BlobHash>,
    /// Hashes we already announced as providers.
    announced: HashSet<BlobHash>,
    /// Addresses learned from DHT routing updates + identify.
    peer_addresses: HashMap<PeerId, Vec<Multiaddr>>,
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
            fetch_requests: HashMap::new(),
            in_flight: HashSet::new(),
            announced: HashSet::new(),
            peer_addresses: HashMap::new(),
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
            NodeCommand::Listen => {
                for addr in ["/ip4/0.0.0.0/tcp/0", "/ip4/0.0.0.0/udp/0/quic-v1"] {
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
            SwarmEvent::ConnectionClosed { peer_id, .. } => {
                self.emit(NodeEvent::PeerDisconnected {
                    peer_id: peer_id.to_string(),
                });
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
                }
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
