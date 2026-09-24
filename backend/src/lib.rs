mod crypto;
mod error;
mod node;
mod p2p;
mod store;

pub use node::run_headless;

use crate::crypto::card::{PeerCard, SignedProfile};
use crate::crypto::server::{
    channel_topic, new_server_id, server_topic, ChannelConfig, Invite, JoinNotice, Member,
    PLAZA_TOPIC, PlazaMessage, ProfileNotice, Role, ServerDir, ServerRecord, ServerView,
    SignedList, SignedMessage, Snapshot,
};
use crate::crypto::{Identity, Keystore, SessionDir};
use crate::error::PeersError;
use crate::p2p::{NodeCommand, NodeEvent, NodeHandle};
use crate::store::{
    state_apply, state_from, DmMessage, History, PersistedState, Store, StoreHandle,
};
use libp2p::multiaddr::Protocol;
use libp2p::{Multiaddr, PeerId};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, State, WindowEvent};

/// Gossip topic clients use to ask always-on relay nodes to mesh the topics
/// they subscribe to. Mirrors `p2p::RELAY_CONTROL_TOPIC`.
const RELAY_CONTROL_TOPIC: &str = "peers/v1/relay";

/// Friend request topic prefix. Mirrors `p2p::FRIEND_REQUEST_TOPIC_PREFIX`.
const FRIEND_REQUEST_TOPIC_PREFIX: &str = "peers/v1/fr/";

/// How many recent Plaza messages we keep in memory for new views.
const PLAZA_HISTORY_LIMIT: usize = 200;

/// How long a Plaza participant counts as "here" after their last message.
const PLAZA_PRESENCE_WINDOW_SECS: u64 = 600;

/// Subscribes to a topic and asks any connected relay nodes to mesh it too,
/// so our messages reach peers who only connect through them.
async fn subscribe_with_relay(state: &AppState, topic: String) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Subscribe(topic.clone())).await?;
    let notice = serde_json::json!({ "op": "subscribe", "topic": topic });
    let _ = node
        .send(NodeCommand::Publish {
            topic: RELAY_CONTROL_TOPIC.to_string(),
            data: serde_json::to_vec(&notice).map_err(|e| e.to_string())?,
        })
        .await;
    Ok(())
}

/// Shared app state. `node`/`identity`/`dir`/`servers`/`storage`/`history`
/// exist only after a successful unlock; the keystore is always available.
pub struct AppState {
    keystore: Keystore,
    identity: Mutex<Option<Identity>>,
    node: Mutex<Option<NodeHandle>>,
    dir: Mutex<Option<SessionDir>>,
    servers: Mutex<ServerDir>,
    store: Store,
    storage: Mutex<Option<StoreHandle>>,
    history: Mutex<History>,
    /// Peer ids with an open connection right now (presence).
    presence: Mutex<HashSet<String>>,
    /// Our own listen multiaddrs, learned from node `Listening` events.
    /// Shared in invites so other peers can dial us directly.
    addrs: Mutex<Vec<String>>,
    /// Our own signed display profile (name/about/avatar).
    profile: Mutex<Option<SignedProfile>>,
    /// Cached, verified display profiles of peers we've met (peer id → profile).
    profiles: Mutex<HashMap<String, SignedProfile>>,
    /// Recent self-signed messages seen on the global Plaza (deduped by sig).
    plaza: Mutex<VecDeque<PlazaMessage>>,
    /// Last seen timestamp per Plaza participant (peer id → ts), for
    /// "who's here".
    plaza_seen: Mutex<HashMap<String, u64>>,
    /// Addresses libp2p confirmed as externally observed. Non-empty means
    /// peers can dial us without going through a relay.
    external_addrs: Mutex<HashSet<String>>,
    /// Relay nodes we currently hold a circuit reservation with.
    relay_reservations: Mutex<HashSet<String>>,
    /// AutoNAT's measured verdict on whether peers can dial us. Unlike
    /// `external_addrs` this is a dial-back test, not a peer's claim.
    nat: Mutex<crate::p2p::Nat>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            keystore: Keystore::new(Keystore::default_path()),
            identity: Mutex::new(None),
            node: Mutex::new(None),
            dir: Mutex::new(None),
            servers: Mutex::new(ServerDir::new()),
            store: Store::new(Store::default_path()),
            storage: Mutex::new(None),
            history: Mutex::new(History::default()),
            presence: Mutex::new(HashSet::new()),
            addrs: Mutex::new(Vec::new()),
            profile: Mutex::new(None),
            profiles: Mutex::new(HashMap::new()),
            plaza: Mutex::new(VecDeque::new()),
            plaza_seen: Mutex::new(HashMap::new()),
            external_addrs: Mutex::new(HashSet::new()),
            relay_reservations: Mutex::new(HashSet::new()),
            nat: Mutex::new(crate::p2p::Nat::Unknown),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityInfo {
    peer_id: String,
    peer_id_short: String,
    fingerprint: String,
    /// The auto-generated fun display name this identity would get by
    /// default (e.g. "JuicyPear"), so the UI can show it before any profile
    /// is set.
    default_name: String,
}

fn info_for(id: &Identity) -> Result<IdentityInfo, PeersError> {
    Ok(IdentityInfo {
        peer_id: id.peer_id.to_string(),
        peer_id_short: id.peer_id_short(),
        fingerprint: id.fingerprint()?,
        default_name: crate::crypto::card::default_display_name(&id.peer_id),
    })
}

#[tauri::command]
fn has_identity(state: State<AppState>) -> bool {
    state.keystore.exists()
}

#[tauri::command]
fn is_unlocked(state: State<AppState>) -> bool {
    state.identity.lock().unwrap().is_some()
}

/// Generates a fresh recovery phrase for the onboarding screen.
///
/// This is the one place secret material crosses the Tauri boundary: the user
/// has to see the phrase to write it down. It is never logged or persisted in
/// plaintext — `init_from_phrase` seals it immediately.
#[tauri::command]
fn generate_phrase(word_count: usize) -> Result<String, String> {
    Ok(crate::crypto::mnemonic::generate(word_count)?)
}

/// The short 12-digit code for a peer id, plus its display form. A lookup
/// hint for finding someone, never a proof of who they are.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerCode {
    code: String,
    formatted: String,
}

/// Our own short peer code.
#[tauri::command]
fn my_code(state: State<AppState>) -> Result<PeerCode, String> {
    let id = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let code = crate::crypto::code::short_code(&id.peer_id);
    Ok(PeerCode {
        formatted: crate::crypto::code::format_code(&code),
        code,
    })
}

/// Starts a DHT lookup for `code`. Resolution is asynchronous: the answer
/// arrives as a `code://resolved` event carrying the peer id, or `null` when
/// nobody is providing that code.
///
/// A resolved peer id is *not* proof of identity — the code is only a
/// rendezvous key, and 12 digits is grindable. The UI must show the peer's
/// profile and fingerprint and let the user accept before trusting them.
#[tauri::command]
async fn lookup_code(state: State<'_, AppState>, code: String) -> Result<String, String> {
    let normalized = crate::crypto::code::normalize_code(&code)
        .ok_or("a peer code is 12 digits, e.g. 4827 1193 6052")?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::LookupCode(normalized.clone()))
        .await?;
    Ok(normalized)
}

/// Adds a resolved peer as a DM contact: subscribes to their topic so their
/// messages reach us, and dials them so ours reach them.
#[tauri::command]
async fn add_contact(state: State<'_, AppState>, peer_id: String) -> Result<(), String> {
    let peer: PeerId = peer_id
        .parse()
        .map_err(|_| "that is not a valid peer id".to_string())?;
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    if peer == me.peer_id {
        return Err("that is your own peer code".into());
    }
    // Their DM topic is their peer id; subscribing is how we receive from them.
    subscribe_with_relay(&state, format!("peers/v1/ch/{peer}")).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::DialPeer(peer)).await?;
    Ok(())
}

/// Sends a friend request to a peer. The request carries our display name
/// and optional avatar hash so the recipient knows who is asking. We also
/// subscribe to their DM topic so we receive their messages once they accept.
#[tauri::command]
async fn send_friend_request(
    state: State<'_, AppState>,
    peer_id: String,
) -> Result<(), String> {
    let peer: PeerId = peer_id
        .parse()
        .map_err(|_| "that is not a valid peer id".to_string())?;
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    if peer == me.peer_id {
        return Err("cannot send a friend request to yourself".into());
    }
    // Include our profile and identity card in the request so the recipient
    // can verify us and establish a DM key without a prior server encounter.
    let (display_name, avatar_hash) = {
        let profile = state.profile.lock().unwrap();
        (
            profile
                .as_ref()
                .map(|p| p.display_name.clone())
                .unwrap_or_default(),
            profile.as_ref().and_then(|p| p.avatar_hash.clone()),
        )
    };
    let envelope = crate::p2p::FriendRequestEnvelope {
        kind: "request".to_string(),
        display_name,
        avatar_hash,
        card: PeerCard::sign(&me).map_err(|e| e.to_string())?,
    };
    let payload = serde_json::to_vec(&envelope)
        .map_err(|e| format!("failed to serialize friend request: {e}"))?;
    // Publish to the target's friend-request topic and listen on our own
    // topic for the signed acceptance that completes key exchange.
    let topic = format!("{FRIEND_REQUEST_TOPIC_PREFIX}{peer}");
    subscribe_with_relay(&state, format!("{FRIEND_REQUEST_TOPIC_PREFIX}{me.peer_id}")).await?;
    subscribe_with_relay(&state, topic.clone()).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish { topic, data: payload })
        .await?;
    // Also subscribe to their DM topic so we get their reply once they accept.
    subscribe_with_relay(&state, format!("peers/v1/ch/{peer}")).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::DialPeer(peer)).await?;
    Ok(())
}

/// Accepts an incoming friend request: subscribes to the requester's DM topic
/// so we receive their messages, and sends a confirmation back.
#[tauri::command]
async fn accept_friend(state: State<'_, AppState>, peer_id: String) -> Result<(), String> {
    let peer: PeerId = peer_id
        .parse()
        .map_err(|_| "that is not a valid peer id".to_string())?;
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    if peer == me.peer_id {
        return Err("cannot accept a friend request from yourself".into());
    }
    // Subscribe to the requester's DM topic so we receive their messages.
    subscribe_with_relay(&state, format!("peers/v1/ch/{peer}")).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::DialPeer(peer)).await?;
    // Send a confirmation back to the requester's request topic so they know
    // we accepted and should also subscribe to our DM topic (they likely
    // already did when sending the request, but this closes the loop).
    let (display_name, avatar_hash) = {
        let profile = state.profile.lock().unwrap();
        (
            profile
                .as_ref()
                .map(|p| p.display_name.clone())
                .unwrap_or_default(),
            profile.as_ref().and_then(|p| p.avatar_hash.clone()),
        )
    };
    let envelope = crate::p2p::FriendRequestEnvelope {
        kind: "accept".to_string(),
        display_name,
        avatar_hash,
        card: PeerCard::sign(&me).map_err(|e| e.to_string())?,
    };
    let payload = serde_json::to_vec(&envelope)
        .map_err(|e| format!("failed to serialize friend accept: {e}"))?;
    let topic = format!("{FRIEND_REQUEST_TOPIC_PREFIX}{peer}");
    subscribe_with_relay(&state, topic.clone()).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish { topic, data: payload })
        .await?;
    Ok(())
}

/// First run *or* recovery: derives the identity from `phrase`, seals the
/// keystore with it, and starts the node. Passing a phrase that already has
/// a keystore rebuilds the same identity, which is what makes a lost install
/// recoverable.
#[tauri::command]
async fn init_from_phrase(
    state: State<'_, AppState>,
    app: AppHandle,
    phrase: String,
) -> Result<IdentityInfo, String> {
    if state.identity.lock().unwrap().is_some() {
        return Err("already unlocked".into());
    }
    if state.keystore.exists() {
        return Err("an identity already exists; unlock it instead of replacing it".into());
    }
    let id = state.keystore.create_from_phrase(&phrase)?;
    finish_unlock(state, app, id, &phrase).await
}

/// Unlock the keystore and start the node.
#[tauri::command]
async fn unlock(
    state: State<'_, AppState>,
    app: AppHandle,
    password: String,
) -> Result<IdentityInfo, String> {
    let id = state.keystore.load(&password)?;
    if state.identity.lock().unwrap().is_some() {
        return Err("already unlocked".into());
    }
    finish_unlock(state, app, id, &password).await
}

/// Everything that happens once we hold a decrypted identity: open the sealed
/// state store, bring up the swarm, wire the event relay, subscribe to our
/// topics and dial the backbone.
///
/// Shared by `unlock` and `init_from_phrase` so the two paths cannot drift.
/// `secret` unseals the state store and is the phrase (or legacy password).
async fn finish_unlock(
    state: State<'_, AppState>,
    app: AppHandle,
    id: Identity,
    secret: &str,
) -> Result<IdentityInfo, String> {
    // Unlock the sealed state store and restore servers/contacts/history
    // before the node comes up.
    let store_handle = state.store.open(secret)?;
    let persisted = store_handle.load()?;
    let mut history = History::default();
    {
        let mut servers = state.servers.lock().unwrap();
        let mut dir = state.dir.lock().unwrap();
        *dir = Some(SessionDir::new());
        state_apply(
            dir.as_mut().unwrap(),
            &mut servers,
            &mut history,
            &persisted,
        )?;
    }

    let handle = p2p::spawn(id.clone(), false)?;
    *state.identity.lock().unwrap() = Some(id.clone());
    *state.node.lock().unwrap() = Some(handle.clone());
    *state.storage.lock().unwrap() = Some(store_handle);
    *state.history.lock().unwrap() = history;
    *state.profile.lock().unwrap() = persisted.profile.clone();

    // Relay node events to the frontend and track presence.
    let mut rx = handle.subscribe();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            match &ev {
                NodeEvent::Listening { addr } => {
                    let st = app2.state::<AppState>();
                    let mut addrs = st.addrs.lock().unwrap();
                    if !addrs.iter().any(|a| a == addr) {
                        addrs.push(addr.clone());
                    }
                }
                NodeEvent::PeerConnected { peer_id } => {
                    let st = app2.state::<AppState>();
                    st.presence.lock().unwrap().insert(peer_id.clone());
                    let _ = app2.emit("presence://peer-connected", peer_id);
                }
                NodeEvent::PeerDisconnected { peer_id } => {
                    let st = app2.state::<AppState>();
                    st.presence.lock().unwrap().remove(peer_id);
                    let _ = app2.emit("presence://peer-disconnected", peer_id);
                }
                NodeEvent::ExternalAddr { addr, confirmed } => {
                    let st = app2.state::<AppState>();
                    let mut set = st.external_addrs.lock().unwrap();
                    if *confirmed {
                        set.insert(addr.clone());
                    } else {
                        set.remove(addr);
                    }
                }
                NodeEvent::RelayReservation { relay_peer, active } => {
                    let st = app2.state::<AppState>();
                    let mut set = st.relay_reservations.lock().unwrap();
                    if *active {
                        set.insert(relay_peer.clone());
                    } else {
                        set.remove(relay_peer);
                    }
                }
                NodeEvent::NatStatus { status } => {
                    let st = app2.state::<AppState>();
                    *st.nat.lock().unwrap() = match status.as_str() {
                        "public" => crate::p2p::Nat::Public,
                        "private" => crate::p2p::Nat::Private,
                        _ => crate::p2p::Nat::Unknown,
                    };
                }
                NodeEvent::CodeResolved { code, peer_id } => {
                    let _ = app2.emit(
                        "code://resolved",
                        serde_json::json!({ "code": code, "peerId": peer_id }),
                    );
                }
                NodeEvent::HolePunch { peer_id, direct } => {
                    let _ = app2.emit(
                        "net://hole-punch",
                        serde_json::json!({ "peerId": peer_id, "direct": direct }),
                    );
                }
                NodeEvent::FriendRequest {
                    from_peer,
                    from_name,
                    from_avatar,
                    from_card,
                    accepted,
                } => {
                    let st = app2.state::<AppState>();
                    if from_card.verify_for_peer(from_peer).is_ok() {
                        if let Some(dir) = st.dir.lock().unwrap().as_mut() {
                            dir.remember_contact(from_peer, from_card);
                        }
                        if !accepted {
                            let _ = app2.emit(
                                "friend://request",
                                serde_json::json!({
                                    "peerId": from_peer,
                                    "displayName": from_name,
                                    "avatarHash": from_avatar,
                                }),
                            );
                        }
                    }
                }
                _ => {}
            }
            let _ = app2.emit("node://event", &ev);
        }
    });

    // Listen + bootstrap against the public IPFS testnet. Port 0 (ephemeral)
    // is right for a GUI client: peers reach it over a relay circuit, not by
    // address, so there's nothing to keep stable across restarts.
    let _ = handle
        .send(NodeCommand::Listen {
            port: crate::p2p::bootstrap::listen_port(0),
        })
        .await;
    // The relay-control topic is how we register with (and reach) the
    // always-on backbone nodes; we must subscribe to publish on it.
    let _ = handle
        .send(NodeCommand::Subscribe(RELAY_CONTROL_TOPIC.to_string()))
        .await;
    // Receive DMs addressed to us: our own peer id is our DM topic.
    let _ = subscribe_with_relay(&state, format!("peers/v1/ch/{}", id.peer_id)).await;
    // Listen for incoming friend requests on our per-peer request topic.
    let _ = subscribe_with_relay(
        &state,
        format!("{FRIEND_REQUEST_TOPIC_PREFIX}{}", id.peer_id),
    )
    .await;
    // Auto-join the global Plaza (no invites, can't leave).
    let _ = subscribe_with_relay(&state, PLAZA_TOPIC.to_string()).await;
    announce_plaza_profile(&state).await;
    // Announce our friend code on the DHT so people who have it can find us.
    let _ = handle.send(NodeCommand::PublishCode).await;
    // Re-subscribe to every server control topic we know about.
    let records = state.servers.lock().unwrap().records();
    for rec in records {
        let _ = subscribe_with_relay(&state, server_topic(&rec.id)).await;
    }
    // Dial any known always-on nodes so we reach peers we share no mesh with,
    // and reserve a circuit slot on each so NAT'd peers can reach us too.
    for ma in crate::p2p::bootstrap::known_nodes() {
        let _ = handle.send(NodeCommand::Dial(ma.clone())).await;
        let _ = handle.send(NodeCommand::ListenOnRelay(ma)).await;
    }
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let addrs = crate::p2p::bootstrap::resolve_public_bootstrap().await;
        let _ = handle.send(NodeCommand::Bootstrap(addrs)).await;
    });

    Ok(info_for(&id)?)
}

/// Best-effort sealed persistence of everything we know.
fn persist(state: &AppState) {
    let Some(handle) = state.storage.lock().unwrap().clone() else {
        return;
    };
    let persisted = {
        let servers = state.servers.lock().unwrap();
        let dir = state.dir.lock().unwrap();
        let history = state.history.lock().unwrap();
        let profile = state.profile.lock().unwrap();
        let servers: Vec<_> = servers.records().iter().map(|r| r.to_persisted()).collect();
        match dir.as_ref() {
            Some(dir) => state_from(dir, &servers, &history, &profile),
            None => PersistedState {
                servers,
                history: history.clone(),
                profile: profile.clone(),
                ..PersistedState::default()
            },
        }
    };
    let _ = handle.save(&persisted);
}

/// A snapshot of what the node knows about its own connectivity.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    /// Peers with at least one live connection.
    pub peers: usize,
    pub listen_addrs: Vec<String>,
    pub external_addrs: Vec<String>,
    pub relay_reservations: usize,
    /// "direct" | "relayed" | "unreachable" | "unknown". Backed by an AutoNAT
    /// dial-back test once one has completed; a heuristic until then.
    pub reachability: &'static str,
    /// True once AutoNAT has actually measured reachability, so the UI can
    /// stop hedging. False means `reachability` is still inferred.
    pub reachability_measured: bool,
    /// Whether any always-on nodes are configured. When false and
    /// `reachability` is "unknown", cross-NAT chat will not work — see
    /// docs/running-a-node.md.
    pub known_nodes: usize,
}

/// Current connectivity snapshot for the UI.
#[tauri::command]
fn net_status(state: State<AppState>) -> Result<NetStatus, String> {
    let listen_addrs = state.addrs.lock().unwrap().clone();
    let external: Vec<String> = state.external_addrs.lock().unwrap().iter().cloned().collect();
    let relay_reservations = state.relay_reservations.lock().unwrap().len();
    let peers = state.presence.lock().unwrap().len();
    let nat = *state.nat.lock().unwrap();
    Ok(NetStatus {
        peers,
        listen_addrs,
        reachability: crate::p2p::reachability(external.len(), relay_reservations, nat),
        reachability_measured: nat != crate::p2p::Nat::Unknown,
        external_addrs: external,
        relay_reservations,
        known_nodes: crate::p2p::bootstrap::known_nodes().len(),
    })
}

#[tauri::command]
fn lock(state: State<AppState>) -> Result<(), String> {
    persist(&state);
    *state.node.lock().unwrap() = None;
    *state.dir.lock().unwrap() = None;
    *state.servers.lock().unwrap() = ServerDir::new();
    *state.storage.lock().unwrap() = None;
    *state.identity.lock().unwrap() = None;
    *state.history.lock().unwrap() = History::default();
    *state.presence.lock().unwrap() = HashSet::new();
    *state.addrs.lock().unwrap() = Vec::new();
    *state.profile.lock().unwrap() = None;
    *state.profiles.lock().unwrap() = HashMap::new();
    *state.plaza.lock().unwrap() = VecDeque::new();
    *state.plaza_seen.lock().unwrap() = HashMap::new();
    *state.external_addrs.lock().unwrap() = HashSet::new();
    *state.relay_reservations.lock().unwrap() = HashSet::new();
    // The next unlock starts a fresh swarm, so the old verdict says nothing
    // about it — and a stale "unreachable" would be read as a live diagnosis.
    *state.nat.lock().unwrap() = crate::p2p::Nat::Unknown;
    Ok(())
}

/// Re-signs the current member list of `server_id` and publishes it on the
/// server topic.
async fn publish_list(state: &AppState, server_id: &str) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let data = {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(server_id).ok_or(PeersError::ServerNotFound)?;
        let list = rec.signed_list()?;
        serde_json::to_vec(&list).map_err(|e| e.to_string())?
    };
    node.send(NodeCommand::Publish {
        topic: server_topic(server_id),
        data,
    })
    .await?;
    Ok(())
}

/// Applies an owner-only mutation to a server, then re-signs and
/// republishes the list.
async fn mutate_server(
    state: &AppState,
    server_id: &str,
    f: impl FnOnce(&mut ServerRecord) -> Result<(), String>,
) -> Result<ServerView, String> {
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me_str = me.peer_id.to_string();
    {
        let mut servers = state.servers.lock().unwrap();
        let rec = servers
            .get_mut(server_id)
            .ok_or(PeersError::ServerNotFound)?;
        if rec.owner_peer != me_str {
            return Err(PeersError::NotOwner.into());
        }
        f(rec)?;
        rec.revision = rec.revision.saturating_add(1);
    }
    publish_list(state, server_id).await?;
    persist(state);
    state
        .servers
        .lock()
        .unwrap()
        .view(server_id, &me_str)
        .ok_or_else(|| PeersError::ServerNotFound.to_string())
}

#[tauri::command]
async fn create_server(state: State<'_, AppState>, name: String) -> Result<ServerView, String> {
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me_str = me.peer_id.to_string();
    let id = new_server_id();
    let card = PeerCard::sign(&me)?;
    let _ = state
        .servers
        .lock()
        .unwrap()
        .create(id.clone(), name, me_str.clone(), card);
    subscribe_with_relay(&state, server_topic(&id)).await?;
    publish_list(&state, &id).await?;
    persist(&state);
    state
        .servers
        .lock()
        .unwrap()
        .view(&id, &me_str)
        .ok_or_else(|| PeersError::ServerNotFound.to_string())
}

#[tauri::command]
async fn list_servers(state: State<'_, AppState>) -> Result<Vec<ServerView>, String> {
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    Ok(state.servers.lock().unwrap().views(&me.peer_id.to_string()))
}

#[tauri::command]
async fn create_invite(state: State<'_, AppState>, server_id: String) -> Result<String, String> {
    let mut invite = {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        rec.invite()?
    };
    // Attach our current listen addresses so the joiner can dial us
    // directly and get a working gossipsub mesh right away.
    invite.addrs = state.addrs.lock().unwrap().clone();
    serde_json::to_string(&invite).map_err(|e| e.to_string())
}

#[tauri::command]
async fn join_server(
    state: State<'_, AppState>,
    invite_json: String,
    name: String,
) -> Result<ServerView, String> {
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me_str = me.peer_id.to_string();
    let invite: Invite =
        serde_json::from_str(&invite_json).map_err(|e| format!("bad invite: {e}"))?;
    let rec = state.servers.lock().unwrap().join(&invite)?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let topic = server_topic(&invite.payload.server_id);
    subscribe_with_relay(&state, topic.clone()).await?;
    // Dial the owner's advertised addresses so we get a direct connection
    // and the gossipsub mesh forms without waiting on DHT discovery.
    if let Ok(owner) = invite.payload.owner_peer.parse::<PeerId>() {
        for addr in &invite.addrs {
            if let Ok(mut ma) = addr.parse::<Multiaddr>() {
                ma.push(Protocol::P2p(owner));
                let _ = node.send(NodeCommand::Dial(ma)).await;
            }
        }
    }
    // Give the direct connection time to establish before we announce the
    // join, so the owner is guaranteed to receive the notice via gossip.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let card = PeerCard::sign(&me)?;
    let profile = state.profile.lock().unwrap().clone();
    let notice = JoinNotice::new(
        &invite.payload.server_id,
        &me_str,
        &name,
        invite.payload.nonce,
        card,
        profile,
    );
    let data = serde_json::to_vec(&notice).map_err(|e| e.to_string())?;
    node.send(NodeCommand::Publish {
        topic: server_topic(&invite.payload.server_id),
        data,
    })
    .await?;
    persist(&state);
    Ok(ServerView::from_record(&rec, &me_str))
}

#[tauri::command]
async fn add_member(
    state: State<'_, AppState>,
    server_id: String,
    peer_id: String,
    name: String,
    role: String,
    card: Option<PeerCard>,
) -> Result<ServerView, String> {
    let role: Role = serde_json::from_str(&format!("\"{role}\""))
        .map_err(|_| format!("invalid role: {role}"))?;
    let profile = state.profiles.lock().unwrap().get(&peer_id).cloned();
    mutate_server(&state, &server_id, move |rec| {
        if rec.members.iter().any(|m| m.peer_id == peer_id) {
            return Err(PeersError::AlreadyMember.into());
        }
        let epoch = rec.keys.as_ref().map(|k| k.epoch).unwrap_or(0);
        rec.members.push(Member {
            peer_id,
            name,
            role,
            joined_epoch: epoch,
            card,
            profile,
        });
        Ok(())
    })
    .await
}

#[tauri::command]
async fn remove_member(
    state: State<'_, AppState>,
    server_id: String,
    peer_id: String,
) -> Result<ServerView, String> {
    mutate_server(&state, &server_id, move |rec| {
        let before = rec.members.len();
        rec.members.retain(|m| m.peer_id != peer_id);
        if rec.members.len() == before {
            return Err(PeersError::NotInServer.into());
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn set_role(
    state: State<'_, AppState>,
    server_id: String,
    peer_id: String,
    role: String,
) -> Result<ServerView, String> {
    let role: Role = serde_json::from_str(&format!("\"{role}\""))
        .map_err(|_| format!("invalid role: {role}"))?;
    mutate_server(&state, &server_id, move |rec| {
        let Some(member) = rec.members.iter_mut().find(|m| m.peer_id == peer_id) else {
            return Err(PeersError::NotInServer.into());
        };
        if member.role == Role::Owner {
            return Err("cannot change the owner's role".into());
        }
        member.role = role;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn rotate_key(state: State<'_, AppState>, server_id: String) -> Result<ServerView, String> {
    mutate_server(&state, &server_id, |rec| {
        rec.keys.as_mut().ok_or(PeersError::NotOwner)?.rotate();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn set_channel(
    state: State<'_, AppState>,
    server_id: String,
    name: String,
    topic: String,
    read_min: String,
    write_min: String,
) -> Result<ServerView, String> {
    let read_min: Role = serde_json::from_str(&format!("\"{read_min}\""))
        .map_err(|_| format!("invalid role: {read_min}"))?;
    let write_min: Role = serde_json::from_str(&format!("\"{write_min}\""))
        .map_err(|_| format!("invalid role: {write_min}"))?;
    mutate_server(&state, &server_id, move |rec| {
        if name.is_empty() {
            return Err("channel name is required".into());
        }
        let topic = if topic.is_empty() {
            name.clone()
        } else {
            topic
        };
        match rec.channels.iter_mut().find(|c| c.name == name) {
            Some(cfg) => {
                cfg.topic = topic;
                cfg.read_min = read_min;
                cfg.write_min = write_min;
            }
            None => rec.channels.push(ChannelConfig {
                name,
                topic,
                read_min,
                write_min,
            }),
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn leave_server(state: State<'_, AppState>, server_id: String) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let channels = {
        let servers = state.servers.lock().unwrap();
        servers
            .get(&server_id)
            .map(|rec| rec.channels.iter().map(|c| c.name.clone()).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    state.servers.lock().unwrap().remove(&server_id);
    node.send(NodeCommand::Unsubscribe(server_topic(&server_id)))
        .await?;
    for channel in channels {
        node.send(NodeCommand::Unsubscribe(channel_topic(&server_id, &channel)))
            .await?;
    }
    persist(&state);
    Ok(())
}

#[tauri::command]
async fn rename_server(
    state: State<'_, AppState>,
    server_id: String,
    name: String,
) -> Result<ServerView, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("server name is required".into());
    }
    mutate_server(&state, &server_id, move |rec| {
        rec.name = name;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn subscribe_channel(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
) -> Result<(), String> {
    let me = state
        .identity
        .lock()
        .unwrap()
        .as_ref()
        .map(|identity| identity.peer_id.to_string())
        .ok_or("not unlocked")?;
    {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        if !rec.can_read(&me, &channel) {
            return Err(PeersError::Forbidden.into());
        }
    }
    subscribe_with_relay(&state, channel_topic(&server_id, &channel)).await
}

#[tauri::command]
async fn unsubscribe_channel(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Unsubscribe(channel_topic(
        &server_id, &channel,
    )))
    .await?;
    Ok(())
}

/// Publishes a signed (unencrypted) message to a server channel. Writing
/// is gated by the channel ACL from the latest signed list.
#[tauri::command]
async fn publish_channel(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
    text: String,
) -> Result<(), String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        if !rec.can_write(&me, &channel) {
            return Err(PeersError::Forbidden.into());
        }
    }
    let msg = SignedMessage::sign(&identity.keypair, &server_id, &channel, &text)?;
    let data = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish {
        topic: channel_topic(&server_id, &channel),
        data,
    })
    .await?;
    {
        let mut history = state.history.lock().unwrap();
        history.push_server(&format!("{server_id}/{channel}"), msg);
    }
    persist(&state);
    Ok(())
}

#[tauri::command]
fn server_history(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
) -> Result<Vec<SignedMessage>, String> {
    let key = format!("{server_id}/{channel}");
    Ok(state.history.lock().unwrap().server_messages(&key).to_vec())
}

#[tauri::command]
async fn subscribe(state: State<'_, AppState>, channel: String) -> Result<(), String> {
    subscribe_with_relay(&state, format!("peers/v1/ch/{channel}")).await
}

#[tauri::command]
async fn unsubscribe(state: State<'_, AppState>, channel: String) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let topic = format!("peers/v1/ch/{channel}");
    node.send(NodeCommand::Unsubscribe(topic)).await?;
    Ok(())
}

/// Seals `text` for every peer we have a validated card for, then publishes
/// the envelope to the channel's topic. Decryption happens on receipt (the
/// card from the sender travels inside the envelope, so no out-of-band
/// exchange is needed).
#[tauri::command]
async fn publish(state: State<'_, AppState>, channel: String, text: String) -> Result<(), String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    // The DM topic for a peer is `peers/v1/ch/<their peer id>`; that full
    // topic string is also the AEAD binding the recipient uses to open the
    // envelope, so seal and publish must share it.
    let topic = format!("peers/v1/ch/{channel}");
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        let rcpt = dir.recipient_key(&channel).ok_or_else(|| {
            PeersError::Crypto(
                "no encryption key for this peer yet — meet them on a server or the Plaza first"
                    .into(),
            )
        })?;
        // Encrypt only to the intended recipient (not every contact), so the
        // envelope cannot be opened by anyone else subscribed to this topic.
        dir.seal(&identity, &[rcpt], topic.as_bytes(), text.as_bytes())?
    };
    // Subscribe (and ask relay nodes to mesh) first: a DM whose entry was
    // auto-created by an incoming message never had `subscribe()` called for
    // it, and gossipsub refuses to publish to an unsubscribed topic.
    subscribe_with_relay(&state, topic.clone()).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish {
        topic,
        data: payload,
    })
    .await?;
    {
        let mut history = state.history.lock().unwrap();
        history.push_dm(
            &channel,
            DmMessage {
                peer: channel.clone(),
                text: text.clone(),
                ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                mine: true,
            },
        );
    }
    persist(&state);
    Ok(())
}

#[tauri::command]
fn dm_history(state: State<'_, AppState>, peer: String) -> Result<Vec<DmMessage>, String> {
    Ok(state.history.lock().unwrap().dm_messages(&peer).to_vec())
}

/// Peer ids with an open connection right now.
#[tauri::command]
fn online_peers(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.presence.lock().unwrap().iter().cloned().collect())
}

/// Owner exports the server's full history as a signed snapshot JSON.
#[tauri::command]
async fn export_snapshot(state: State<'_, AppState>, server_id: String) -> Result<String, String> {
    let me = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me_str = me.peer_id.to_string();
    let snap = {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        if rec.owner_peer != me_str {
            return Err(PeersError::NotOwner.into());
        }
        let messages = state.history.lock().unwrap().server_snapshot(&server_id);
        Snapshot::sign(rec, messages)?
    };
    serde_json::to_string(&snap).map_err(|e| e.to_string())
}

/// Verifies a signed snapshot against our trusted server key and merges
/// any messages we don't already have into local history.
#[tauri::command]
async fn import_snapshot(
    state: State<'_, AppState>,
    server_id: String,
    snapshot_json: String,
) -> Result<usize, String> {
    let snap: Snapshot =
        serde_json::from_str(&snapshot_json).map_err(|e| format!("bad snapshot: {e}"))?;
    if snap.server_id != server_id {
        return Err("snapshot is for a different server".into());
    }
    let imported = {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        snap.verify(rec)?;
        let messages = snap.messages;
        drop(servers);
        let mut history = state.history.lock().unwrap();
        let mut imported = 0;
        for msg in messages {
            let key = format!("{server_id}/{}", msg.channel);
            let list = history.server.entry(key).or_default();
            if list.iter().any(|m| m.sig == msg.sig) {
                continue;
            }
            list.push(msg);
            list.sort_by_key(|m| m.ts);
            imported += 1;
        }
        imported
    };
    persist(&state);
    Ok(imported)
}

/// Sets (and signs) our display profile: name, about and optional avatar
/// blob hash. The profile is persisted, folded into the signed lists of any
/// servers we own, and announced on every server we belong to so contacts
/// learn it without extra round-trips.
#[tauri::command]
async fn set_profile(
    state: State<'_, AppState>,
    display_name: String,
    about: String,
    avatar_hash: Option<String>,
) -> Result<SignedProfile, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    let profile = SignedProfile::sign(&identity, &display_name, &about, avatar_hash)?;
    *state.profile.lock().unwrap() = Some(profile.clone());

    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    // Fold into signed lists of servers we own (everyone learns it with the
    // next list), and notify owners of servers we merely belong to.
    let records = state.servers.lock().unwrap().records();
    for rec in &records {
        if rec.owner_peer == me {
            {
                let mut servers = state.servers.lock().unwrap();
                if let Some(r) = servers.get_mut(&rec.id) {
                    if let Some(m) = r.members.iter_mut().find(|m| m.peer_id == me) {
                        m.profile = Some(profile.clone());
                    }
                }
            }
            publish_list(&state, &rec.id).await?;
        } else {
            let notice = serde_json::to_vec(&ProfileNotice::new(
                &rec.id,
                &me,
                profile.clone(),
            ))
            .map_err(|e| e.to_string())?;
            let _ = node
                .send(NodeCommand::Publish {
                    topic: server_topic(&rec.id),
                    data: notice,
                })
                .await;
        }
    }
    persist(&state);
    // Let the Plaza (and anyone "here") learn the new name/avatar.
    announce_plaza_profile(&state).await;
    Ok(profile)
}

/// Our own signed profile, if one has been set.
#[tauri::command]
fn get_profile(state: State<'_, AppState>) -> Result<Option<SignedProfile>, String> {
    Ok(state.profile.lock().unwrap().clone())
}

/// Verified display profiles we've learned for other peers (peer id → profile).
#[tauri::command]
fn contact_profiles(state: State<'_, AppState>) -> Result<HashMap<String, SignedProfile>, String> {
    Ok(state.profiles.lock().unwrap().clone())
}

/// A Plaza participant and when they were last seen.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlazaPresence {
    peer_id: String,
    last_ts: u64,
}

/// Appends a verified Plaza message to the in-memory buffer (deduped by
/// signature) and records the sender's last-seen time.
fn push_plaza(state: &AppState, msg: PlazaMessage) {
    let peer = msg.from.clone();
    let ts = msg.ts;
    {
        let mut buf = state.plaza.lock().unwrap();
        if !buf.iter().any(|m| m.sig == msg.sig) {
            buf.push_back(msg);
            if buf.len() > PLAZA_HISTORY_LIMIT {
                buf.pop_front();
            }
        }
    }
    state.plaza_seen.lock().unwrap().insert(peer, ts);
}

/// Publishes our signed display profile on the Plaza so anyone "here"
/// learns who we are. Best-effort; called on unlock and after set_profile.
async fn announce_plaza_profile(state: &AppState) {
    let Some(identity) = state.identity.lock().unwrap().clone() else { return };
    let Some(node) = state.node.lock().unwrap().clone() else { return };
    let Some(profile) = state.profile.lock().unwrap().clone() else { return };
    let Ok(card) = PeerCard::sign(&identity) else { return };
    let Ok(msg) = PlazaMessage::sign(&identity.keypair, PlazaMessage::KIND_PROFILE, "", Some(profile), Some(card)) else { return };
    if let Ok(data) = serde_json::to_vec(&msg) {
        let _ = node
            .send(NodeCommand::Publish {
                topic: PLAZA_TOPIC.to_string(),
                data,
            })
            .await;
    }
}

/// Sends a self-signed chat message to the global Plaza.
#[tauri::command]
async fn publish_plaza(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    let card = PeerCard::sign(&identity)?;
    let msg = PlazaMessage::sign(&identity.keypair, PlazaMessage::KIND_CHAT, &text, None, Some(card))?;
    let data = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish {
        topic: PLAZA_TOPIC.to_string(),
        data,
    })
    .await?;
    push_plaza(&state, msg);
    Ok(())
}

/// Recent verified Plaza messages, oldest first.
#[tauri::command]
fn plaza_history(state: State<'_, AppState>) -> Result<Vec<PlazaMessage>, String> {
    Ok(state.plaza.lock().unwrap().iter().cloned().collect())
}

/// Plaza participants seen in the last few minutes.
#[tauri::command]
fn plaza_who(state: State<'_, AppState>) -> Result<Vec<PlazaPresence>, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let seen = state.plaza_seen.lock().unwrap();
    Ok(seen
        .iter()
        .filter(|(_, ts)| now.saturating_sub(**ts) < PLAZA_PRESENCE_WINDOW_SECS)
        .map(|(peer_id, last_ts)| PlazaPresence {
            peer_id: peer_id.clone(),
            last_ts: *last_ts,
        })
        .collect())
}

/// Parks bytes (sealed envelope or media chunk) and announces them on the
/// DHT so other peers can fetch them while we're offline.
///
/// Caps at 64 KiB to match the wire codec limit. Avatars are 20–30 KB
/// after downscaling; larger attachments will need chunking (not yet
/// implemented).
#[tauri::command]
async fn park_blob(state: State<'_, AppState>, data: Vec<u8>) -> Result<String, String> {
    const MAX_BLOB: usize = 64 * 1024;
    if data.len() > MAX_BLOB {
        return Err(format!(
            "blob too large: {} bytes (max {})",
            data.len(),
            MAX_BLOB
        ));
    }
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::ParkBlob(data)).await?;
    Ok("queued".into())
}

#[tauri::command]
async fn fetch_blob(state: State<'_, AppState>, hash: String) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let hash = p2p::parse_hex_hash(&hash).ok_or("invalid hash")?;
    node.send(NodeCommand::FetchBlob(hash)).await?;
    Ok(())
}

/// Runs the app. Node events arrive on the `node://event` channel and
/// decrypted messages on `node://message`.
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        // Close-to-tray: hiding keeps the libp2p node alive so parked blobs
        // keep seeding from the tray (M3 background seeding).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            has_identity,
            is_unlocked,
            generate_phrase,
            init_from_phrase,
            my_code,
            lookup_code,
            add_contact,
            send_friend_request,
            accept_friend,
            net_status,
            unlock,
            lock,
            subscribe,
            unsubscribe,
            publish,
            park_blob,
            fetch_blob,
            create_server,
            list_servers,
            create_invite,
            join_server,
            add_member,
            remove_member,
            set_role,
            rotate_key,
            set_channel,
            leave_server,
            rename_server,
            subscribe_channel,
            unsubscribe_channel,
            publish_channel,
            server_history,
            dm_history,
            online_peers,
            set_profile,
            get_profile,
            contact_profiles,
            publish_plaza,
            plaza_history,
            plaza_who,
            export_snapshot,
            import_snapshot,
        ])
        .setup(|app| {
            // Tray icon with Show/Quit — the window hides on close, so the
            // app (and its DHT blob seeding) keeps running in the tray.
            let show = MenuItem::with_id(app, "show", "Show Peers", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let tray = TrayIconBuilder::new();
            let tray = if let Some(icon) = app.default_window_icon() {
                tray.icon(icon.clone())
            } else {
                tray
            };
            let _tray = tray
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Peers — E2E encrypted messenger")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Decrypt incoming envelopes as they arrive and forward them as
            // frontend-friendly events.
            let app_handle = app.handle().clone();
            app.listen("node://event", move |event| {
                let state = app_handle.state::<AppState>();
                let payload: NodeEvent = match serde_json::from_str(event.payload()) {
                    Ok(ev) => ev,
                    Err(_) => return,
                };
                if let NodeEvent::Message { topic, from, data } = payload {
                    // Server control plane: member lists and join notices
                    // travel as plaintext JSON on `peers/v1/srv/{id}`.
                    if let Some(server_id) = topic.strip_prefix("peers/v1/srv/") {
                        let server_id = server_id.to_string();
                        if let Ok(list) = serde_json::from_slice::<SignedList>(&data) {
                            let state = app_handle.state::<AppState>();
                            let (cards, profiles, view) = {
                                let me = state.identity.lock().unwrap().clone();
                                let mut servers = state.servers.lock().unwrap();
                                let mut cards = Vec::new();
                                let mut profiles = Vec::new();
                                let view = match servers.get_mut(&server_id) {
                                    Some(rec) => match rec.verify_list(&list) {
                                        Ok(()) => {
                                            // Every member card rides the signed list,
                                            // so a fresh list unlocks DMs with everyone.
                                            cards = list
                                                .payload
                                                .members
                                                .iter()
                                                .filter_map(|m| {
                                                    m.card.clone().filter_map(|c| {
                                                        c.verify_for_peer(&m.peer_id)
                                                            .ok()
                                                            .map(|_| (m.peer_id.clone(), c))
                                                    })
                                                })
                                                .collect();
                                            // ...and every verified profile too.
                                            for m in &list.payload.members {
                                                if let Some(p) = &m.profile {
                                                    if p.verify().is_ok() && p.peer_id == m.peer_id {
                                                        profiles.push((m.peer_id.clone(), p.clone()));
                                                    }
                                                }
                                            }
                                            me.map(|id| {
                                                ServerView::from_record(
                                                    rec,
                                                    &id.peer_id.to_string(),
                                                )
                                            })
                                        }
                                        Err(e) => {
                                            let _ = app_handle.emit(
                                                "server://error",
                                                serde_json::json!({
                                                    "serverId": server_id,
                                                    "error": e.to_string(),
                                                }),
                                            );
                                            None
                                        }
                                    },
                                    None => None,
                                };
                                (cards, profiles, view)
                            };
                            if let Some(dir) = state.dir.lock().unwrap().as_mut() {
                                for (peer, card) in cards {
                                    dir.remember_contact(&peer, &card);
                                }
                            }
                            {
                                let mut cache = state.profiles.lock().unwrap();
                                for (peer, profile) in profiles {
                                    cache.insert(peer, profile);
                                }
                            }
                            if view.is_some() {
                                persist(&state);
                            }
                            if let Some(v) = view {
                                let _ = app_handle.emit("server://list", v);
                            }
                        } else if let Ok(notice) = serde_json::from_slice::<JoinNotice>(&data) {
                            if notice.peer_id != from
                                || notice.card.verify_for_peer(&from).is_err()
                            {
                                return;
                            }
                            let state = app_handle.state::<AppState>();
                            // Cache the joiner's card so anyone with the notice
                            // can DM them; only the owner acts on the request.
                            if let Some(dir) = state.dir.lock().unwrap().as_mut() {
                                dir.remember_contact(&notice.peer_id, &notice.card);
                            }
                            if let Some(profile) = &notice.profile {
                                if profile.verify().is_ok() && profile.peer_id == notice.peer_id {
                                    state
                                        .profiles
                                        .lock()
                                        .unwrap()
                                        .insert(notice.peer_id.clone(), profile.clone());
                                }
                            }
                            persist(&state);
                            let is_owner = {
                                let me = state.identity.lock().unwrap().clone();
                                let servers = state.servers.lock().unwrap();
                                match (me, servers.get(&notice.server_id)) {
                                    (Some(me), Some(rec)) => {
                                        rec.owner_peer == me.peer_id.to_string()
                                    }
                                    _ => false,
                                }
                            };
                            if is_owner {
                                let _ = app_handle.emit("server://join-request", notice);
                            }
                        } else if let Ok(pn) = serde_json::from_slice::<ProfileNotice>(&data) {
                            let state = app_handle.state::<AppState>();
                            if pn.profile.verify().is_ok() && pn.profile.peer_id == pn.peer_id {
                                state
                                    .profiles
                                    .lock()
                                    .unwrap()
                                    .insert(pn.peer_id.clone(), pn.profile.clone());
                                // If we own this server, fold the profile into the
                                // signed list so everyone learns it, and persist.
                                let me = state.identity.lock().unwrap().clone();
                                let owned = {
                                    let servers = state.servers.lock().unwrap();
                                    match (me, servers.get(&pn.server_id)) {
                                        (Some(me), Some(rec)) => {
                                            rec.owner_peer == me.peer_id.to_string()
                                        }
                                        _ => false,
                                    }
                                };
                                if owned {
                                    {
                                        let mut servers = state.servers.lock().unwrap();
                                        if let Some(rec) = servers.get_mut(&pn.server_id) {
                                            if let Some(m) = rec
                                                .members
                                                .iter_mut()
                                                .find(|m| m.peer_id == pn.peer_id)
                                            {
                                                m.profile = Some(pn.profile.clone());
                                            }
                                        }
                                    }
                                    persist(&state);
                                    // Tauri event listeners are synchronous. Run the
                                    // signed-list publish on Tauri's async runtime
                                    // instead of awaiting inside this callback.
                                    let publish_handle = app_handle.clone();
                                    let publish_server_id = pn.server_id.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let state = publish_handle.state::<AppState>();
                                        let _ = publish_list(&state, &publish_server_id).await;
                                    });
                                }
                            }
                        }
                        return;
                    }
                    // Signed channel messages: `peers/v1/ch/{server}/{channel}`.
                    if let Some((server_id, channel)) = topic
                        .strip_prefix("peers/v1/ch/")
                        .and_then(|rest| rest.split_once('/'))
                    {
                        if let Ok(msg) = serde_json::from_slice::<SignedMessage>(&data) {
                            if msg.server_id != server_id || msg.channel != channel {
                                return;
                            }
                            let state = app_handle.state::<AppState>();
                            let ok = {
                                let me = state
                                    .identity
                                    .lock()
                                    .unwrap()
                                    .as_ref()
                                    .map(|identity| identity.peer_id.to_string());
                                let servers = state.servers.lock().unwrap();
                                match (me, servers.get(server_id)) {
                                    (Some(me), Some(rec)) => {
                                        msg.verify(rec).is_ok() && rec.can_read(&me, &msg.channel)
                                    }
                                    _ => false,
                                }
                            };
                            if ok {
                                {
                                    let mut history = state.history.lock().unwrap();
                                    history.push_server(
                                        &format!("{server_id}/{}", msg.channel),
                                        msg.clone(),
                                    );
                                }
                                persist(&app_handle.state::<AppState>());
                                let _ = app_handle.emit(
                                    "server://message",
                                    serde_json::json!({
                                        "serverId": server_id,
                                        "channel": msg.channel,
                                        "from": msg.from,
                                        "text": msg.text,
                                        "ts": msg.ts,
                                    }),
                                );
                            }
                        }
                        return;
                    }
                    // Global Plaza: self-signed chat + profile announcements.
                    if topic == PLAZA_TOPIC {
                        if let Ok(msg) = serde_json::from_slice::<PlazaMessage>(&data) {
                            if msg.verify().is_ok() {
                                let state = app_handle.state::<AppState>();
                                push_plaza(&state, msg.clone());
                                // Any verified plaza post carries the sender's
                                // X25519 card, so meeting someone here is enough
                                // to start an encrypted DM with them.
                                let fresh = {
                                    let mut dir = state.dir.lock().unwrap();
                                    match dir.as_mut() {
                                        Some(dir) => match &msg.card {
                                            Some(card) => {
                                                let known = dir.recipient_key(&msg.from);
                                                dir.remember_contact(&msg.from, card);
                                                known != Some(card.x25519_pub)
                                            }
                                            None => false,
                                        },
                                        None => false,
                                    }
                                };
                                if fresh {
                                    persist(&state);
                                }
                                if msg.kind == PlazaMessage::KIND_PROFILE {
                                    if let Some(profile) = &msg.profile {
                                        state
                                            .profiles
                                            .lock()
                                            .unwrap()
                                            .insert(msg.from.clone(), profile.clone());
                                    }
                                    let _ = app_handle.emit(
                                        "plaza://profile",
                                        serde_json::json!({
                                            "peerId": msg.from,
                                            "profile": msg.profile,
                                        }),
                                    );
                                } else {
                                    let profile = state
                                        .profiles
                                        .lock()
                                        .unwrap()
                                        .get(&msg.from)
                                        .cloned();
                                    let _ = app_handle.emit(
                                        "plaza://message",
                                        serde_json::json!({
                                            "from": msg.from,
                                            "text": msg.text,
                                            "ts": msg.ts,
                                            "profile": profile,
                                        }),
                                    );
                                }
                            }
                        }
                        return;
                    }
                    let identity = state.identity.lock().unwrap().clone();
                    let Some(identity) = identity else { return };
                    // Open against the live dir so contact caching and session
                    // replay-tracking mutations are not lost.
                    let opened = {
                        let mut guard = state.dir.lock().unwrap();
                        guard
                            .as_mut()
                            .map(|dir| dir.open(&identity, topic.as_bytes(), &data))
                    };
                    let Some(result) = opened else { return };
                    match result {
                        Ok(plaintext) => {
                            let text = String::from_utf8_lossy(&plaintext).to_string();
                            // Cache the sender's identity card under their real
                            // peer id (open() internalizes it under a pseudo
                            // key) so a reply can be encrypted to them.
                            if let Ok(card) = crate::crypto::card::card_from_envelope(&data) {
                                let mut dir = state.dir.lock().unwrap();
                                if let Some(dir) = dir.as_mut() {
                                    dir.remember_contact(&from, &card);
                                }
                            }
                            {
                                let mut history = state.history.lock().unwrap();
                                history.push_dm(
                                    &from,
                                    DmMessage {
                                        peer: from.clone(),
                                        text: text.clone(),
                                        ts: std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .map(|d| d.as_secs())
                                            .unwrap_or(0),
                                        mine: false,
                                    },
                                );
                            }
                            persist(&app_handle.state::<AppState>());
                            let _ = app_handle.emit(
                                "node://message",
                                serde_json::json!({
                                    "from": from,
                                    "channel": topic,
                                    "text": text,
                                }),
                            );
                        }
                        Err(e) => {
                            // We subscribe to a contact's DM topic to send
                            // them messages, which also surfaces other people's
                            // envelopes addressed to that same peer. Those are
                            // none of our business, not errors worth showing.
                            if matches!(e, PeersError::NotAddressed) {
                                return;
                            }
                            let _ = app_handle.emit(
                                "node://message",
                                serde_json::json!({
                                    "from": from,
                                    "channel": topic,
                                    "error": e.to_string(),
                                }),
                            );
                        }
                    }
                }
                // Blob transfer events (avatar/media) go straight to the UI.
                if let NodeEvent::BlobFetched { hash, data } = payload {
                    let _ = app_handle.emit(
                        "blob://fetched",
                        serde_json::json!({ "hash": hash, "data": data }),
                    );
                } else if let NodeEvent::BlobFetchFailed { hash, reason } = payload {
                    let _ = app_handle.emit(
                        "blob://failed",
                        serde_json::json!({ "hash": hash, "reason": reason }),
                    );
                } else if let NodeEvent::BlobParked { hash } = payload {
                    let _ = app_handle.emit(
                        "blob://parked",
                        serde_json::json!({ "hash": hash }),
                    );
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Peers");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend reads these fields by camelCase name; a rename here
    /// silently breaks the UI, so pin the wire format.
    #[test]
    fn net_status_serializes_camel_case() {
        let s = NetStatus {
            peers: 3,
            listen_addrs: vec!["/ip4/127.0.0.1/tcp/4001".into()],
            external_addrs: vec![],
            relay_reservations: 1,
            reachability: "relayed",
            reachability_measured: false,
            known_nodes: 0,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"listenAddrs\""), "frontend expects camelCase");
        assert!(json.contains("\"externalAddrs\""));
        assert!(json.contains("\"relayReservations\""));
        assert!(json.contains("\"reachabilityMeasured\""));
        assert!(json.contains("\"knownNodes\""));
    }

    #[test]
    fn peer_code_serializes_camel_case() {
        let c = PeerCode {
            code: "482711936052".into(),
            formatted: "4827 1193 6052".into(),
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"formatted\""));
        assert!(json.contains("\"code\""));
    }

    /// A phrase must round-trip through the same call the UI makes.
    #[test]
    fn generated_phrase_is_usable() {
        let phrase = generate_phrase(12).unwrap();
        assert_eq!(phrase.split_whitespace().count(), 12);
        assert!(crate::crypto::mnemonic::decode(&phrase).is_ok());
        assert!(generate_phrase(13).is_err());
    }
}
