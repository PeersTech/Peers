pub mod behaviour;
pub mod blobs;
pub mod bootstrap;

use crate::crypto::card::PeerCard;
use crate::crypto::identity::Identity;
use crate::error::{PeersError, Result};
use behaviour::Behaviour;
use blobs::{BlobHash, BlobStore};
use futures::StreamExt;
use libp2p::gossipsub::Sha256Topic;
use libp2p::multiaddr::Protocol;
use libp2p::dial_opts::DialOpts;
use libp2p::request_response::{
    Event as RequestResponseEvent, Message as RequestResponseMessage, OutboundRequestId,
};
use libp2p::swarm::SwarmEvent;
use sha2::{Digest, Sha256};
use libp2p::{
    autonat, gossipsub, identify, kad, ping, relay, Multiaddr, PeerId, Swarm, SwarmBuilder,
};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

/// How often the node re-checks that its relay reservations are still up.
const TICK: Duration = Duration::from_secs(10);

/// Ticks between DHT re-bootstraps (5 minutes). Kademlia refreshes buckets on
/// its own, but a laptop that suspends overnight comes back with a routing
/// table full of peers that have long since gone.
const REBOOTSTRAP_TICKS: u64 = 30;

/// Backoff ceiling, in ticks (5 minutes).
const MAX_BACKOFF_TICKS: u32 = 30;

/// How many *distinct* peers must independently report the same address for
/// us before we believe it and start advertising it.
///
/// identify's `observed_addr` is a claim, not a measurement: a single peer can
/// report whatever it likes, and `add_external_address` takes it at face
/// value. One peer should not be able to make us advertise a bogus address to
/// the DHT — or make us report "direct" reachability we do not have.
const OBSERVED_CONFIRMATIONS: usize = 3;

/// Cap on distinct claimed addresses tracked at once, so a peer inventing a
/// new address on every identify exchange cannot grow the map without bound.
const MAX_OBSERVED_TRACKED: usize = 32;

fn is_public_observed_address(addr: &Multiaddr) -> bool {
    let mut has_ip = false;
    for protocol in addr.iter() {
        match protocol {
            Protocol::Ip4(ip) => {
                has_ip = true;
                if ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_multicast() {
                    return false;
                }
            }
            Protocol::Ip6(ip) => {
                has_ip = true;
                if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
                    return false;
                }
                if let Some(ipv4) = ip.to_ipv4_mapped() {
                    if ipv4.is_private() || ipv4.is_link_local() {
                        return false;
                    }
                }
            }
            _ => {}
        }
    }
    has_ip
}

/// A public relay must not let arbitrary peers turn it into an unbounded
/// topic relay. Only the application namespace is eligible.
const MAX_RELAY_TOPICS: usize = 256;
const MAX_RELAY_TOPIC_LEN: usize = 256;
const MAX_RELAY_TOPICS_PER_PEER: usize = 16;
/// Per-peer relayed bytes allowed per rolling window.
const RELAY_BYTE_BUDGET: u64 = 64 * 1024 * 1024;
const RELAY_BYTE_WINDOW_MS: u128 = 60_000;
/// How many peers we track relay budgets for before pruning idle entries.
const MAX_RELAY_BUDGET_TRACKED: usize = 4_096;
const RELAY_TOPIC_TTL: Duration = Duration::from_secs(600);

/// Gossip topic shared by relay nodes and clients. Clients publish tiny
/// "please mesh topic X for me" notices on it so always-on relay nodes
/// know which server/channel/DM topics they must subscribe to (and thus
/// relay) for clients that only meet through them.
pub const RELAY_CONTROL_TOPIC: &str = "peers/v1/relay";

/// Per-peer topic for incoming friend requests. When Alice adds Bob, she
/// publishes a signed request to `peers/v1/fr/<bob>`. Bob subscribes to
/// his own request topic at startup, receives the request, and can accept
/// or decline. Accepting subscribes both sides to each other's DM topics.
pub const FRIEND_REQUEST_TOPIC_PREFIX: &str = "peers/v1/fr/";
const MAX_FRIEND_NAME_BYTES: usize = 64;
const MAX_AVATAR_HASH_BYTES: usize = 128;

/// A relay-control notice: `{ "op": "subscribe", "topic": "<name>" }`.
#[derive(serde::Deserialize)]
struct RelayControl {
    op: String,
    topic: String,
}

/// A friend request or acceptance published to `peers/v1/fr/<peer_id>`.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct FriendRequestEnvelope {
    pub(crate) kind: String,
    pub(crate) display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) avatar_hash: Option<String>,
    pub(crate) card: PeerCard,
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
    /// Dial a peer through addresses already learned by identify/Kademlia.
    DialPeer(PeerId),
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
    /// An incoming friend request from a peer who scanned our code.
    FriendRequest {
        from_peer: String,
        from_name: String,
        from_avatar: Option<String>,
        from_card: PeerCard,
        accepted: bool,
    },
    /// AutoNAT reached (or revised) a verdict on whether peers can dial us.
    /// `"public"`, `"private"` or `"unknown"`.
    NatStatus {
        status: String,
    },
    Error {
        message: String,
    },
}

/// What AutoNAT has determined about our reachability, if anything.
///
/// This is a measurement, not a guess: AutoNAT asks other peers to dial us
/// back on the addresses we believe are ours and reports whether they
/// actually got through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nat {
    /// AutoNAT has not reached a verdict yet — the normal state at startup,
    /// and the permanent state if too few peers are around to probe with.
    Unknown,
    /// Peers dialed us successfully. We are directly reachable.
    Public,
    /// Peers tried and failed. We are behind a NAT and need a relay.
    Private,
}

/// Reachability, preferring AutoNAT's measurement over inference.
///
/// `external_addrs` and `relay_reservations` remain the fallback for the
/// window before AutoNAT reports (and for peers with too few AutoNAT servers
/// around to get an answer). They are weaker evidence: an external address is
/// only an address some peer *claimed* to see, which is not the same as one
/// that anybody can actually reach.
///
/// The disagreement case is the interesting one. When AutoNAT says `Private`
/// but we hold external addresses, AutoNAT wins — it tried to dial and
/// failed, which is dispositive; the address was observed through a NAT
/// mapping that does not accept unsolicited inbound. Reporting "direct" there
/// is how a user ends up told that cross-NAT chat should work while it
/// silently does not.
pub fn reachability(external_addrs: usize, relay_reservations: usize, nat: Nat) -> &'static str {
    match nat {
        Nat::Public => "direct",
        Nat::Private => {
            if relay_reservations > 0 {
                "relayed"
            } else {
                // Confirmed unreachable and holding no relay: peers cannot
                // get to us at all. Not "unknown" — we know, and it is bad.
                "unreachable"
            }
        }
        Nat::Unknown => {
            if external_addrs > 0 {
                "direct"
            } else if relay_reservations > 0 {
                "relayed"
            } else {
                "unknown"
            }
        }
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

fn valid_relay_topic(topic: &str) -> bool {
    topic.len() <= MAX_RELAY_TOPIC_LEN
        && (topic.starts_with("peers/v1/srv/")
            || topic.starts_with("peers/v1/ch/")
            || topic.starts_with("peers/v1/fr/")
            || topic == crate::crypto::server::PLAZA_TOPIC)
}

impl Node {
    /// Charges `bytes` against a peer's rolling relay budget. Returns true when
    /// the peer is over budget and the message must be dropped.
    ///
    /// The over-budget state is kept rather than cleared so a peer cannot
    /// reset by reconnecting: only the window expiry clears it. Entries for
    /// idle peers are pruned so the map cannot grow without bound.
    fn charge_relay_bytes(&mut self, peer: PeerId, bytes: u64) -> bool {
        let now = Instant::now();
        let window = Duration::from_millis(RELAY_BYTE_WINDOW_MS);
        if self.relay_bytes.len() > MAX_RELAY_BUDGET_TRACKED {
            self.relay_bytes
                .retain(|_, (since, _)| now.duration_since(*since) <= window);
        }
        let entry = self.relay_bytes.entry(peer).or_insert((now, 0));
        if now.duration_since(entry.0) > window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(bytes);
        entry.1 > RELAY_BYTE_BUDGET
    }
}

/// Hex-encodes a blob hash.
pub fn hex_hash(h: &BlobHash) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}

/// Parses a 64-char hex blob hash.
pub fn parse_hex_hash(s: &str) -> Option<BlobHash> {
    if s.len() != 64 || !s.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
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
    /// Topics requested through the public relay-control topic.
    relay_topics: HashSet<String>,
    /// Requester and expiry for each relay topic, preventing one peer from
    /// filling the global relay table and allowing stale requests to expire.
    relay_topic_owners: HashMap<String, HashMap<PeerId, Instant>>,
    /// Rolling per-peer budget of bytes pushed into relay topics. Topic-count
    /// limits alone do not bound bandwidth: one peer owning a topic could
    /// still flood it with large messages.
    relay_bytes: HashMap<PeerId, (Instant, u64)>,
    /// Addresses learned from DHT routing updates + identify.
    peer_addresses: HashMap<PeerId, Vec<Multiaddr>>,
    /// Relays we currently hold a circuit reservation with. A set, not a
    /// counter, so a repeated accept cannot inflate it and a disconnect
    /// removes exactly one entry.
    relay_reservations: HashSet<PeerId>,
    /// Addresses libp2p has confirmed as externally observed.
    external_addrs: HashSet<Multiaddr>,
    /// Distinct peers who have claimed each address as ours, via identify.
    /// An address is only believed once [`OBSERVED_CONFIRMATIONS`] separate
    /// peers agree — see that constant for why one is not enough.
    observed_by: HashMap<Multiaddr, HashSet<PeerId>>,
    /// Relay nodes we were told to hold a reservation with, and the state of
    /// our attempts to get one. Kept for the lifetime of the process: a node
    /// that is down now is exactly the one we must keep retrying.
    relay_targets: HashMap<Multiaddr, Retry>,
    /// AutoNAT's verdict on whether peers can dial us.
    nat: Nat,
    /// Ticks elapsed, for scheduling the periodic DHT re-bootstrap.
    ticks: u64,
    /// Whether this node relays gossip for topics it's told about.
    relay: bool,
    events: broadcast::Sender<NodeEvent>,
}

/// Checks whether the device has enough power to relay for others.
/// Returns `true` when on AC power, fully charged, or battery is above 20%.
/// On desktops (no battery), always returns `true`. This is a best-effort
/// heuristic — the caller should re-check periodically.
pub fn battery_relay_ok() -> bool {
    match battery::Manager::new() {
        Ok(mgr) => match mgr.batteries() {
            Ok(mut bats) => {
                if let Some(Ok(bat)) = bats.next() {
                    let on_ac = bat.state() == battery::State::Charging
                        || bat.state() == battery::State::Full;
                    let enough = bat.energy_remaining()
                        .map(|r| r.get::<battery::units::energy::watt_hour>() > 2.0)
                        .unwrap_or(true);
                    on_ac || enough
                } else {
                    true // No battery = desktop
                }
            }
            Err(_) => true,
        },
        Err(_) => true,
    }
}

/// Retry bookkeeping for one relay target.
struct Retry {
    /// The relay's peer id, learned once we have connected to it. Until then
    /// we only know an address, which is not enough to tell whether the
    /// reservation we are holding is with *this* target.
    peer: Option<PeerId>,
    /// Ticks remaining before the next attempt.
    wait: u32,
    /// Current backoff, doubling on each failure.
    backoff: u32,
}

impl Retry {
    fn new() -> Self {
        // First attempt fires on the next tick rather than immediately: the
        // initial dial has already been issued by the caller.
        Self {
            peer: None,
            wait: 1,
            backoff: 1,
        }
    }

    /// Called when an attempt failed or the reservation was lost. Doubles the
    /// wait, capped, so a node that is down for an hour is not hammered every
    /// ten seconds by every client that has it configured.
    fn failed(&mut self) {
        self.backoff = (self.backoff * 2).min(MAX_BACKOFF_TICKS);
        self.wait = self.backoff;
    }

    /// Called when a reservation is confirmed. Resets the backoff so the
    /// *next* outage retries promptly instead of inheriting the delay earned
    /// by the previous one.
    fn succeeded(&mut self, peer: PeerId) {
        self.peer = Some(peer);
        self.backoff = 1;
        self.wait = 0;
    }
}

impl Node {
    async fn run(
        swarm: Swarm<Behaviour>,
        mut cmds: mpsc::Receiver<NodeCommand>,
        events: broadcast::Sender<NodeEvent>,
    ) {
        let blobs = BlobStore::new();
        let announced = blobs.hashes().into_iter().collect();
        let mut node = Node {
            swarm,
            blobs,
            topics: HashMap::new(),
            pending_fetches: HashMap::new(),
            pending_codes: HashMap::new(),
            fetch_requests: HashMap::new(),
            in_flight: HashSet::new(),
            announced,
            relay_topics: HashSet::new(),
            relay_topic_owners: HashMap::new(),
            relay_bytes: HashMap::new(),
            peer_addresses: HashMap::new(),
            relay_reservations: HashSet::new(),
            external_addrs: HashSet::new(),
            observed_by: HashMap::new(),
            relay_targets: HashMap::new(),
            nat: Nat::Unknown,
            ticks: 0,
            relay: false,
            events,
        };

        // A steady tick rather than a timer per target: the work is a handful
        // of counter decrements, and one timer keeps the select arm simple.
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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
                _ = tick.tick() => node.on_tick(),
            }
        }
    }

    /// Periodic upkeep: re-establish lost relay reservations, and refresh the
    /// DHT routing table.
    ///
    /// Without this, `Dial` is fire-and-forget — if a relay node restarts, the
    /// reservation is gone and nothing ever asks for another one. The client
    /// stays silently unreachable until the user restarts the app, which is
    /// indistinguishable from the network being broken.
    fn on_tick(&mut self) {
        self.ticks = self.ticks.wrapping_add(1);

        // Collect first: `retry_relay` borrows the swarm mutably.
        let mut due: Vec<Multiaddr> = Vec::new();
        for (addr, retry) in self.relay_targets.iter_mut() {
            // Already holding a reservation with this relay — nothing to do.
            if retry.peer.is_some_and(|p| self.relay_reservations.contains(&p)) {
                retry.wait = 0;
                continue;
            }
            if retry.wait > 0 {
                retry.wait -= 1;
                continue;
            }
            due.push(addr.clone());
        }

        for addr in due {
            self.retry_relay(&addr);
            if let Some(retry) = self.relay_targets.get_mut(&addr) {
                retry.failed();
            }
        }

        if self.ticks % REBOOTSTRAP_TICKS == 0 {
            // Fails harmlessly when the routing table is empty, which is the
            // case we would most like it to succeed in — but there is nobody
            // to ask, so there is nothing to do about it.
            let _ = self.swarm.behaviour_mut().kademlia.bootstrap();
        }
    }

    /// Re-dial a relay and ask for a circuit slot again.
    fn retry_relay(&mut self, addr: &Multiaddr) {
        let _ = self.swarm.dial(addr.clone());
        let mut circuit = addr.clone();
        circuit.push(Protocol::P2pCircuit);
        // An error here is expected while the relay is down; reporting it every
        // ten seconds would bury real errors in the log, and the backoff
        // already communicates the state.
        let _ = self.swarm.listen_on(circuit);
    }

    fn emit(&self, ev: NodeEvent) {
        let _ = self.events.send(ev);
    }

    /// Records that `peer` claims `addr` is ours, and adopts the address once
    /// enough distinct peers independently agree.
    ///
    /// `add_external_address` is what makes us advertise an address over
    /// identify and the DHT, and what drives the "direct" reachability
    /// reading. Calling it on a single peer's say-so lets that one peer
    /// choose what we advertise about ourselves — so we require a quorum.
    fn note_observed(&mut self, peer: PeerId, addr: Multiaddr) {
        if !is_public_observed_address(&addr) {
            return;
        }
        // Already adopted; nothing further to count.
        if self.external_addrs.contains(&addr) {
            return;
        }
        // Bound the map so a peer inventing a fresh address on every identify
        // exchange cannot grow it without limit. Dropping new candidates is
        // the safe direction: worst case we take longer to learn a real
        // address, which the AutoNAT probe covers anyway.
        if !self.observed_by.contains_key(&addr) && self.observed_by.len() >= MAX_OBSERVED_TRACKED {
            return;
        }
        let voters = self.observed_by.entry(addr.clone()).or_default();
        voters.insert(peer);
        if voters.len() >= OBSERVED_CONFIRMATIONS {
            self.observed_by.remove(&addr);
            self.swarm.add_external_address(addr);
        }
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
            NodeCommand::DialPeer(peer) => {
                let _ = self.swarm.dial(DialOpts::peer_id(peer).build());
            }
            NodeCommand::Dial(addr) => {
                let _ = self.swarm.dial(addr);
            }
            NodeCommand::ListenOnRelay(addr) => {
                // Remembered so the tick loop can re-establish the reservation
                // if the relay restarts. Without this the slot is lost for the
                // lifetime of the process.
                self.relay_targets.entry(addr.clone()).or_insert_with(Retry::new);

                // A relay is a known-good AutoNAT server: it is reachable by
                // definition, and it has already seen us dial in.
                if let Some(Protocol::P2p(peer)) = addr.iter().last() {
                    let mut base = addr.clone();
                    base.pop();
                    self.swarm
                        .behaviour_mut()
                        .autonat
                        .add_server(peer, Some(base));
                }

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
                self.relay_topics.remove(&topic_name);
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
                    // A persisted blob may have lost its provider record while
                    // the process was offline; refresh the DHT announcement.
                    let _ = self
                        .swarm
                        .behaviour_mut()
                        .kademlia
                        .start_providing(kad::RecordKey::new(&hash));
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
                // A peer can have several established connections. Only the
                // last one closing means it is actually offline; otherwise
                // the UI would flicker offline whenever a redundant socket
                // closes.
                if num_established == 0 {
                    if self.relay_reservations.remove(&peer_id) {
                        self.emit(NodeEvent::RelayReservation {
                            relay_peer: peer_id.to_string(),
                            active: false,
                        });
                    }
                    self.emit(NodeEvent::PeerDisconnected {
                        peer_id: peer_id.to_string(),
                    });
                }
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
                    // candidate. It is only a *claim*, though, so we wait for
                    // several independent peers to say the same thing before
                    // acting on it. See OBSERVED_CONFIRMATIONS.
                    if let Some(observed) = info.observed_addr.clone() {
                        self.note_observed(peer, observed);
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
                    // Bind the target to its peer id and clear the backoff, so
                    // a future outage retries promptly rather than inheriting
                    // the delay this one earned.
                    for (addr, retry) in self.relay_targets.iter_mut() {
                        if matches!(addr.iter().last(), Some(Protocol::P2p(p)) if p == relay_peer_id)
                        {
                            retry.succeeded(relay_peer_id);
                        }
                    }
                }
            }
            behaviour::Event::Autonat(ev) => {
                if let autonat::Event::StatusChanged { new, .. } = ev {
                    let (nat, label) = match new {
                        autonat::NatStatus::Public(_) => (Nat::Public, "public"),
                        autonat::NatStatus::Private => (Nat::Private, "private"),
                        autonat::NatStatus::Unknown => (Nat::Unknown, "unknown"),
                    };
                    self.nat = nat;
                    self.emit(NodeEvent::NatStatus {
                        status: label.to_string(),
                    });
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
                    if self.relay {
                        if let Some(source) = message.source {
                            if self.charge_relay_bytes(source, message.data.len() as u64) {
                                self.emit(NodeEvent::Error {
                                    message: "relay bandwidth limit reached".into(),
                                });
                                return;
                            }
                        }
                    }
                    if self.relay && message.topic == control_hash {
                        if let Ok(ctrl) = serde_json::from_slice::<RelayControl>(&message.data) {
                            if ctrl.op == "subscribe" && valid_relay_topic(&ctrl.topic) {
                                let Some(requester) = message.source else { return };
                                let now = Instant::now();
                                let expired: Vec<String> = self
                                    .relay_topic_owners
                                    .iter()
                                    .filter_map(|(topic, owners)| {
                                        owners.retain(|_, expires| *expires > now);
                                        (owners.is_empty()).then_some(topic.clone())
                                    })
                                    .collect();
                                for topic in expired {
                                    self.relay_topics.remove(&topic);
                                    self.relay_topic_owners.remove(&topic);
                                    self.topics.remove(&topic);
                                    let _ = self.swarm.behaviour_mut().gossipsub.unsubscribe(&Sha256Topic::new(topic));
                                }
                                let allowed = {
                                    let owners = self.relay_topic_owners.entry(ctrl.topic.clone()).or_default();
                                    if !owners.contains_key(&requester) && owners.len() >= MAX_RELAY_TOPICS_PER_PEER {
                                        false
                                    } else if self.relay_topics.len() >= MAX_RELAY_TOPICS
                                        && !self.relay_topics.contains(&ctrl.topic)
                                    {
                                        false
                                    } else {
                                        owners.insert(requester, now + RELAY_TOPIC_TTL);
                                        true
                                    }
                                };
                                if !allowed {
                                    self.emit(NodeEvent::Error {
                                        message: "relay topic limit reached".into(),
                                    });
                                } else {
                                    let topic = Sha256Topic::new(ctrl.topic.clone());
                                    match self.swarm.behaviour_mut().gossipsub.subscribe(&topic) {
                                        Ok(_) => {
                                            self.relay_topics.insert(ctrl.topic.clone());
                                            self.topics.insert(ctrl.topic.clone(), topic);
                                        }
                                        Err(e) => self.emit(NodeEvent::Error {
                                            message: format!("relay subscribe {}: {e}", ctrl.topic),
                                        }),
                                    }
                                }
                            }
                        }
                    }
                    // Relay control traffic is internal; never surface it as
                    // a user message.
                    if message.topic == control_hash {
                        return;
                    }
                    // Gossipsub exposes only the SHA-256 topic hash on the
                    // wire. Recover the application topic from the local
                    // subscription map before dispatching protocol events;
                    // `TopicHash::to_string()` is the base64 hash, not the
                    // original `peers/v1/...` name.
                    let topic_str = self
                        .topics
                        .iter()
                        .find_map(|(name, topic)| (topic.hash() == message.topic).then(|| name.clone()));
                    let Some(topic_str) = topic_str else {
                        return;
                    };
                    // Friend requests are parsed and surfaced as a dedicated
                    // event so the app layer doesn't need to re-parse them.
                    if let Some(_target) = topic_str.strip_prefix(FRIEND_REQUEST_TOPIC_PREFIX) {
                        if let Some(from) = message.source {
                            if let Ok(req) =
                                serde_json::from_slice::<FriendRequestEnvelope>(&message.data)
                            {
                                let from_string = from.to_string();
                                if req.card.verify_for_peer(&from_string).is_err()
                                    || !matches!(req.kind.as_str(), "request" | "accept")
                                    || req.display_name.len() > MAX_FRIEND_NAME_BYTES
                                    || req
                                        .avatar_hash
                                        .as_ref()
                                        .is_some_and(|hash| hash.len() > MAX_AVATAR_HASH_BYTES)
                                {
                                    return;
                                }
                                self.emit(NodeEvent::FriendRequest {
                                    from_peer: from_string,
                                    from_name: req.display_name,
                                    from_avatar: req.avatar_hash,
                                    from_card: req.card,
                                    accepted: req.kind == "accept",
                                });
                            }
                        }
                        return;
                    }
                    if let Some(from) = message.source {
                        self.emit(NodeEvent::Message {
                            topic: topic_str,
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
                            let actual: BlobHash = Sha256::digest(&response).into();
                            if actual != hash {
                                self.emit(NodeEvent::BlobFetchFailed {
                                    hash: hex_hash(&hash),
                                    reason: "hash mismatch (corrupt or tampered)".into(),
                                });
                            } else {
                                self.blobs.put(&response);
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
                                // The provider record identifies the peer, and the
                                // routing table supplies addresses learned through
                                // identify/Kademlia. Dial it now so the UI can
                                // establish a direct connection after verification.
                                let _ = self.swarm.dial(DialOpts::peer_id(peer).build());
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
        assert_eq!(reachability(1, 0, Nat::Unknown), "direct");
        assert_eq!(reachability(1, 3, Nat::Unknown), "direct");
    }

    #[test]
    fn reachability_is_relayed_when_only_reservations() {
        assert_eq!(reachability(0, 1, Nat::Unknown), "relayed");
    }

    /// "unknown" is not "offline" — it means nothing has been confirmed
    /// yet, which is the normal state right after startup.
    #[test]
    fn reachability_unknown_when_nothing_known() {
        assert_eq!(reachability(0, 0, Nat::Unknown), "unknown");
    }

    #[test]
    fn relay_only_accepts_application_topics() {
        assert!(valid_relay_topic("peers/v1/ch/server/general"));
        assert!(valid_relay_topic(crate::crypto::server::PLAZA_TOPIC));
        assert!(!valid_relay_topic("peers/v1/relay"));
        assert!(!valid_relay_topic("other/v1/ch/server/general"));
    }

    /// AutoNAT actually dialed us and got through, so this is not a guess.
    #[test]
    fn autonat_public_reports_direct() {
        assert_eq!(reachability(0, 0, Nat::Public), "direct");
        assert_eq!(reachability(0, 5, Nat::Public), "direct");
    }

    /// The case the old heuristic got wrong. An observed address means some
    /// peer saw a NAT mapping, not that anyone can dial it. When AutoNAT has
    /// tried and failed, the measurement wins — otherwise the UI promises
    /// direct connectivity that does not exist.
    #[test]
    fn autonat_private_overrides_observed_addresses() {
        assert_eq!(reachability(3, 1, Nat::Private), "relayed");
    }

    /// Private with no relay is a known-bad state, distinct from "we have not
    /// worked it out yet". Collapsing the two hides the one case the user has
    /// to act on.
    #[test]
    fn private_without_a_relay_is_unreachable_not_unknown() {
        assert_eq!(reachability(0, 0, Nat::Private), "unreachable");
        assert_eq!(reachability(2, 0, Nat::Private), "unreachable");
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;

    #[test]
    fn backoff_doubles_then_saturates() {
        let mut r = Retry::new();
        assert_eq!(r.wait, 1, "first retry should be prompt");

        let mut seen = Vec::new();
        for _ in 0..12 {
            r.failed();
            seen.push(r.wait);
        }
        assert_eq!(&seen[..4], &[2, 4, 8, 16]);
        assert!(
            seen.iter().all(|w| *w <= MAX_BACKOFF_TICKS),
            "backoff must be capped, got {seen:?}"
        );
        assert_eq!(*seen.last().unwrap(), MAX_BACKOFF_TICKS);
    }

    /// A relay that flaps must not accumulate an ever-longer delay. Without
    /// this reset, a client that has been up for a day takes five minutes to
    /// notice its relay came back.
    #[test]
    fn success_clears_the_backoff_earned_by_the_last_outage() {
        let mut r = Retry::new();
        for _ in 0..10 {
            r.failed();
        }
        assert_eq!(r.wait, MAX_BACKOFF_TICKS);

        r.succeeded(PeerId::random());
        assert_eq!(r.wait, 0);
        assert!(r.peer.is_some());

        // The next outage retries promptly again.
        r.failed();
        assert_eq!(r.wait, 2);
    }

    /// The whole point of the tick loop: worst-case time to notice a relay is
    /// back has to stay in minutes, not hours.
    #[test]
    fn worst_case_retry_interval_is_bounded() {
        let worst = TICK * MAX_BACKOFF_TICKS;
        assert!(
            worst <= Duration::from_secs(600),
            "a returning relay must be picked up within minutes, not {worst:?}"
        );
    }
}
