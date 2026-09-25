mod atomic;
mod crypto;
mod error;
mod node;
mod p2p;
mod store;

pub use node::run_headless;

use crate::crypto::card::{PeerCard, SignedProfile};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crate::crypto::server::{
    channel_topic, new_server_id, server_topic, ChannelConfig, Invite, JoinNotice, Member,
    PLAZA_TOPIC, PlazaMessage, ProfileNotice, Role, ServerDir, ServerRecord, ServerView,
    SignedList, SignedMessage, Snapshot,
};
use crate::crypto::{group_topic, GroupDescriptor, GroupInvite, Identity, Keystore, SessionDir};
use crate::error::PeersError;
use crate::p2p::{NodeCommand, NodeEvent, NodeHandle};
use crate::store::{
    state_apply, state_from, DmMessage, History, IncomingTransfer, PersistedState, Store,
    StoreHandle,
};
use rand::rngs::OsRng;
use rand::RngCore;
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
const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_DISPLAY_NAME_BYTES: usize = 64;
const MAX_ABOUT_BYTES: usize = 512;
const MAX_CHANNEL_NAME_BYTES: usize = 128;
const MAX_PLAZA_FUTURE_SKEW_SECS: u64 = 300;
const MAX_PLAZA_AGE_SECS: u64 = 7 * 24 * 60 * 60;
const MAX_BLOB_BYTES: usize = 64 * 1024;
const MAX_DM_ATTACHMENT_BYTES: usize = 40 * 1024;
const MAX_DM_ATTACHMENT_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_DM_ATTACHMENT_CHUNK_BYTES: usize = 24 * 1024;
const MAX_DM_ATTACHMENT_CHUNKS: usize = 512;
const MAX_INCOMING_TRANSFERS: usize = 32;
const MAX_DM_ENVELOPE_PLAINTEXT_BYTES: usize = 96 * 1024;

fn validate_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("{label} is too long (max {max} bytes)"));
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupMessagePayload {
    group_id: String,
    revision: u64,
    id: String,
    text: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupAttachmentPayload {
    kind: String,
    group_id: String,
    revision: u64,
    id: String,
    name: String,
    mime: String,
    data: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupAckPayload {
    kind: String,
    group_id: String,
    id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupReadPayload {
    kind: String,
    group_id: String,
    ids: Vec<String>,
}

#[derive(serde::Deserialize)]
struct DmTextPayload {
    kind: String,
    id: String,
    text: String,
}

#[derive(serde::Deserialize)]
struct DmReadPayload {
    kind: String,
    ids: Vec<String>,
}

#[derive(serde::Deserialize)]
struct DmAttachmentPayload {
    kind: String,
    id: String,
    name: String,
    mime: String,
    data: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DmAttachmentChunkPayload {
    kind: String,
    id: String,
    transfer_id: String,
    name: String,
    mime: String,
    total_size: usize,
    chunk_index: usize,
    chunk_count: usize,
    data: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupAttachmentChunkPayload {
    kind: String,
    id: String,
    group_id: String,
    revision: u64,
    transfer_id: String,
    name: String,
    mime: String,
    total_size: usize,
    chunk_index: usize,
    chunk_count: usize,
    data: String,
}

fn validate_profile_fields(profile: &SignedProfile) -> Result<(), String> {
    validate_text(&profile.display_name, MAX_DISPLAY_NAME_BYTES, "display name")?;
    validate_text(&profile.about, MAX_ABOUT_BYTES, "about")?;
    if let Some(hash) = &profile.avatar_hash {
        validate_text(hash, 128, "avatar hash")?;
    }
    Ok(())
}

fn new_message_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

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
    groups: Mutex<HashMap<String, GroupDescriptor>>,
    group_invites: Mutex<Vec<GroupInvite>>,
    store: Store,
    storage: Mutex<Option<StoreHandle>>,
    history: Mutex<History>,
    outbox: Mutex<Vec<crate::store::OutboxEntry>>,
    incoming_transfers: Mutex<HashMap<String, IncomingTransfer>>,
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
            groups: Mutex::new(HashMap::new()),
            group_invites: Mutex::new(Vec::new()),
            store: Store::new(Store::default_path()),
            storage: Mutex::new(None),
            history: Mutex::new(History::default()),
            outbox: Mutex::new(Vec::new()),
            incoming_transfers: Mutex::new(HashMap::new()),
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
            &id,
            &mut servers,
            &mut history,
            &persisted,
        )?;
    }

    *state.outbox.lock().unwrap() = persisted.outbox.clone();
    *state.incoming_transfers.lock().unwrap() = persisted
        .incoming_transfers
        .iter()
        .map(|transfer| (transfer.message_id.clone(), transfer.clone()))
        .collect();
    *state.groups.lock().unwrap() = persisted
        .groups
        .iter()
        .filter(|group| group.members.iter().any(|member| member.peer_id == id.peer_id.to_string()))
        .map(|group| (group.group_id.clone(), group.clone()))
        .collect();
    let handle = p2p::spawn(id.clone(), false)?;
    *state.identity.lock().unwrap() = Some(id.clone());
    *state.node.lock().unwrap() = Some(handle.clone());
    for group in state.groups.lock().unwrap().values() {
        let _ = subscribe_with_relay(&state, group_topic(&group.group_id)).await;
    }
    *state.storage.lock().unwrap() = Some(store_handle);
    retry_outbox(&state).await;
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
        let groups: Vec<_> = state.groups.lock().unwrap().values().cloned().collect();
        let outbox = state.outbox.lock().unwrap().clone();
        let incoming_transfers: Vec<_> = state
            .incoming_transfers
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        let servers: Vec<_> = servers.records().iter().map(|r| r.to_persisted()).collect();
        match dir.as_ref() {
            Some(dir) => {
                let mut persisted = state_from(dir, &servers, &history, &profile, &groups);
                persisted.outbox = outbox;
                persisted.incoming_transfers = incoming_transfers;
                persisted
            }
            None => PersistedState {
                servers,
                history: history.clone(),
                outbox,
                incoming_transfers,
                profile: profile.clone(),
                ..PersistedState::default()
            },
        }
    };
    let _ = handle.save(&persisted);
}

async fn retry_outbox(state: &AppState) {
    let entries = state.outbox.lock().unwrap().clone();
    if entries.is_empty() {
        return;
    }
    let mut subscribed = HashSet::new();
    for entry in entries {
        let identity = state.identity.lock().unwrap().clone();
        let Some(identity) = identity else { continue };
        let (topic, recipients) = if let Some(group_id) = &entry.group_id {
            let Some(descriptor) = state.groups.lock().unwrap().get(group_id).cloned() else { continue };
            let me = identity.peer_id.to_string();
            let topic = if entry.topic.is_empty() { group_topic(group_id) } else { entry.topic.clone() };
            let recipients: Vec<[u8; 32]> = {
                let dir = state.dir.lock().unwrap();
                let Some(dir) = dir.as_ref() else { continue };
                descriptor
                    .members
                    .iter()
                    .filter(|member| member.peer_id != me)
                    .filter_map(|member| dir.recipient_key(&member.peer_id))
                    .collect()
            };
            if recipients.is_empty() { continue; }
            (topic, recipients)
        } else {
            let Some(recipient) = state.dir.lock().unwrap().as_ref().and_then(|dir| dir.recipient_key(&entry.peer)) else { continue };
            (
                if entry.topic.is_empty() { format!("peers/v1/ch/{}", entry.peer) } else { entry.topic.clone() },
                vec![recipient],
            )
        };
        let payload = {
            let mut dir = state.dir.lock().unwrap();
            let Some(dir) = dir.as_mut() else { continue };
            match dir.seal(&identity, &recipients, topic.as_bytes(), entry.payload.as_bytes()) {
                Ok(payload) => payload,
                Err(_) => continue,
            }
        };
        if !subscribed.contains(&topic) {
            if subscribe_with_relay(state, topic.clone()).await.is_err() {
                continue;
            }
            subscribed.insert(topic.clone());
        }
        let node = state.node.lock().unwrap().clone();
        let Some(node) = node else { continue };
        if node.send(NodeCommand::Publish { topic, data: payload }).await.is_ok() {
            let mut outbox = state.outbox.lock().unwrap();
            if let Some(item) = outbox.iter_mut().find(|item| item.id == entry.id) {
                item.attempts = item.attempts.saturating_add(1);
            }
        }
    }
    persist(state);
}


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
    /// Number of locally queued messages still waiting for delivery.
    pub outbox_pending: usize,
}

/// Current connectivity snapshot for the UI.
#[tauri::command]
async fn bootstrap_directory_nodes(
    state: State<'_, AppState>,
    addrs: Vec<String>,
) -> Result<usize, String> {
    if addrs.is_empty() || addrs.len() > 500 {
        return Err("directory node list must contain between 1 and 500 multiaddrs".into());
    }
    let mut unique = HashSet::new();
    let mut parsed = Vec::with_capacity(addrs.len());
    for value in addrs {
        let addr: Multiaddr = value.parse().map_err(|_| "directory returned an invalid multiaddr".to_string())?;
        if !addr.iter().any(|protocol| matches!(protocol, Protocol::P2p(_))) {
            return Err("directory multiaddr must include a peer id".into());
        }
        if unique.insert(addr.to_string()) {
            parsed.push(addr);
        }
    }
    if parsed.is_empty() {
        return Err("directory returned no usable multiaddrs".into());
    }
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let count = parsed.len();
    node.send(NodeCommand::Bootstrap(parsed)).await?;
    Ok(count)
}

#[tauri::command]
async fn retry_outbox_command(state: State<'_, AppState>) -> Result<(), String> {
    retry_outbox(&state).await;
    Ok(())
}

#[tauri::command]
fn net_status(state: State<AppState>) -> Result<NetStatus, String> {
    let listen_addrs = state.addrs.lock().unwrap().clone();
    let external: Vec<String> = state.external_addrs.lock().unwrap().iter().cloned().collect();
    let relay_reservations = state.relay_reservations.lock().unwrap().len();
    let peers = state.presence.lock().unwrap().len();
    let outbox_pending = state.outbox.lock().unwrap().len();
    let nat = *state.nat.lock().unwrap();
    Ok(NetStatus {
        peers,
        listen_addrs,
        reachability: crate::p2p::reachability(external.len(), relay_reservations, nat),
        reachability_measured: nat != crate::p2p::Nat::Unknown,
        external_addrs: external,
        relay_reservations,
        known_nodes: crate::p2p::bootstrap::known_nodes().len(),
        outbox_pending,
    })
}

#[tauri::command]
fn lock(state: State<AppState>) -> Result<(), String> {
    persist(&state);
    *state.node.lock().unwrap() = None;
    *state.dir.lock().unwrap() = None;
    *state.servers.lock().unwrap() = ServerDir::new();
    *state.groups.lock().unwrap() = HashMap::new();
    *state.group_invites.lock().unwrap() = Vec::new();
    *state.storage.lock().unwrap() = None;
    *state.identity.lock().unwrap() = None;
    *state.history.lock().unwrap() = History::default();
    *state.outbox.lock().unwrap() = Vec::new();
    *state.incoming_transfers.lock().unwrap() = HashMap::new();
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
        if let Some(keys) = rec.keys.as_ref() {
            // The owner is also a verifier after restart; keep its trusted
            // chain head aligned with the keys it just mutated.
            rec.known_pub = keys.signing_pub();
        }
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
async fn create_group_descriptor(
    state: State<'_, AppState>,
    name: String,
    peer_ids: Vec<String>,
) -> Result<GroupDescriptor, String> {
    if peer_ids.len() > 64 {
        return Err("group members cannot exceed 64".into());
    }
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let dir = state.dir.lock().unwrap();
    let dir = dir.as_ref().ok_or("not unlocked")?;
    let mut members = Vec::with_capacity(peer_ids.len());
    for peer_id in peer_ids {
        let key = dir
            .recipient_key(&peer_id)
            .ok_or_else(|| format!("no validated encryption key for {peer_id}"))?;
        members.push(crate::crypto::group::GroupMember {peer_id, x25519_pub: key});
    }
    let descriptor = GroupDescriptor::sign(&identity, &new_server_id(), &name, members)
        .map_err(|e| e.to_string())?;
    let group_id = descriptor.group_id.clone();
    state.groups.lock().unwrap().insert(group_id.clone(), descriptor.clone());
    subscribe_with_relay(&state, group_topic(&group_id)).await?;
    Ok(descriptor)
}

#[tauri::command]
fn verify_group_invite(invite_json: String) -> Result<GroupInvite, String> {
    let invite: GroupInvite = serde_json::from_str(&invite_json).map_err(|e| e.to_string())?;
    invite.verify().map_err(|e| e.to_string())?;
    Ok(invite)
}

#[tauri::command]
fn list_groups(state: State<'_, AppState>) -> Result<Vec<GroupDescriptor>, String> {
    let me = state.identity.lock().unwrap().clone().ok_or("not unlocked")?.peer_id.to_string();
    Ok(state
        .groups
        .lock()
        .unwrap()
        .values()
        .filter(|group| group.members.iter().any(|member| member.peer_id == me))
        .cloned()
        .collect())
}

async fn deliver_group_invite(
    state: &AppState,
    group_id: &str,
    peer_id: &str,
) -> Result<(), String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let descriptor = state
        .groups
        .lock()
        .unwrap()
        .get(&group_id)
        .cloned()
        .ok_or("group not found")?;
    if !descriptor.members.iter().any(|member| member.peer_id == peer_id) {
        return Err("peer is not a group member".into());
    }
    let topic = format!("peers/v1/ch/{peer_id}");
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        let recipient = dir.recipient_key(&peer_id).ok_or("no encryption key for this peer")?;
        let invite = serde_json::to_vec(&GroupInvite::new(descriptor)).map_err(|e| e.to_string())?;
        dir.seal(&identity, &[recipient], topic.as_bytes(), &invite)?
    };
    subscribe_with_relay(state, topic.clone()).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish { topic, data: payload }).await?;
    Ok(())
}

#[tauri::command]
async fn send_group_invite(
    state: State<'_, AppState>,
    group_id: String,
    peer_id: String,
) -> Result<(), String> {
    deliver_group_invite(&state, &group_id, &peer_id).await
}

#[tauri::command]
async fn accept_group(state: State<'_, AppState>, invite_json: String) -> Result<GroupDescriptor, String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let invite: GroupInvite = serde_json::from_str(&invite_json).map_err(|e| e.to_string())?;
    invite.verify().map_err(|e| e.to_string())?;
    let me = identity.peer_id.to_string();
    if !invite.descriptor.members.iter().any(|member| member.peer_id == me) {
        return Err("this group invitation does not include you".into());
    }
    let group_id = invite.descriptor.group_id.clone();
    {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        for member in &invite.descriptor.members {
            dir.remember_recipient_key(&member.peer_id, member.x25519_pub);
        }
    }
    state.groups.lock().unwrap().insert(group_id.clone(), invite.descriptor.clone());
    subscribe_with_relay(&state, group_topic(&group_id)).await?;
    Ok(invite.descriptor)
}

#[tauri::command]
async fn send_group(state: State<'_, AppState>, group_id: String, text: String) -> Result<String, String> {
    validate_text(&text, MAX_TEXT_BYTES, "group message")?;
    let id = new_message_id();
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    let descriptor = state
        .groups
        .lock()
        .unwrap()
        .get(&group_id)
        .cloned()
        .ok_or("group not found")?;
    if !descriptor.members.iter().any(|member| member.peer_id == me) {
        return Err("you are not a member of this group".into());
    }
    let topic = group_topic(&group_id);
    let outbox_payload = serde_json::to_string(&serde_json::json!({
        "groupId": group_id,
        "revision": descriptor.revision,
        "id": id.clone(),
        "text": text.clone(),
    }))
    .map_err(|e| e.to_string())?;
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        let recipients: Vec<[u8; 32]> = descriptor
            .members
            .iter()
            .filter(|member| member.peer_id != me)
            .filter_map(|member| dir.recipient_key(&member.peer_id))
            .collect();
        if recipients.is_empty() {
            return Err("no group members have validated encryption keys".into());
        }
        dir.seal(&identity, &recipients, topic.as_bytes(), outbox_payload.as_bytes())?
    };
    state.outbox.lock().unwrap().push(crate::store::OutboxEntry {
        id: id.clone(),
        peer: format!("group:{group_id}"),
        payload: outbox_payload,
        topic: topic.clone(),
        group_id: Some(group_id.clone()),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        attempts: 0,
    });
    persist(&state);
    let _ = subscribe_with_relay(&state, topic.clone()).await;
    if let Some(node) = state.node.lock().unwrap().clone() {
        let _ = node.send(NodeCommand::Publish { topic, data: payload }).await;
    }
    state.history.lock().unwrap().push_dm(
        &format!("group:{group_id}"),
        DmMessage {
            peer: format!("group:{group_id}"),
            text,
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            mine: true,
            sender: Some(me.clone()),
            id: id.clone(),
            read: false,
            delivered: false,
            attachment_name: None,
            attachment_mime: None,
            attachment_data: None,
        },
    );
    persist(&state);
    Ok(id)
}

async fn send_group_attachment_chunked(
    state: &AppState,
    group_id: String,
    name: String,
    mime: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.is_empty() || data.len() > MAX_DM_ATTACHMENT_TOTAL_BYTES {
        return Err(format!(
            "Group attachments must be between 1 and {MAX_DM_ATTACHMENT_TOTAL_BYTES} bytes"
        ));
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    let descriptor = state
        .groups
        .lock()
        .unwrap()
        .get(&group_id)
        .cloned()
        .ok_or("group not found")?;
    if !descriptor.members.iter().any(|member| member.peer_id == me) {
        return Err("you are not a member of this group".into());
    }
    {
        let dir = state.dir.lock().unwrap();
        let Some(dir) = dir.as_ref() else { return Err("not unlocked".into()) };
        if !descriptor
            .members
            .iter()
            .filter(|member| member.peer_id != me)
            .any(|member| dir.recipient_key(&member.peer_id).is_some())
        {
            return Err("no group members have validated encryption keys".into());
        }
    }
    let message_id = new_message_id();
    let topic = group_topic(&group_id);
    let chunk_count = data.len().div_ceil(MAX_DM_ATTACHMENT_CHUNK_BYTES);
    if chunk_count > MAX_DM_ATTACHMENT_CHUNKS {
        return Err("attachment has too many chunks".into());
    }
    for (chunk_index, chunk) in data.chunks(MAX_DM_ATTACHMENT_CHUNK_BYTES).enumerate() {
        let chunk_id = format!("{message_id}:{chunk_index}");
        let payload = serde_json::to_string(&serde_json::json!({
            "kind": "group-attachment-chunk",
            "id": chunk_id.clone(),
            "groupId": group_id.clone(),
            "revision": descriptor.revision,
            "transferId": message_id.clone(),
            "name": name.clone(),
            "mime": mime.clone(),
            "totalSize": data.len(),
            "chunkIndex": chunk_index,
            "chunkCount": chunk_count,
            "data": B64.encode(chunk),
        }))
        .map_err(|e| e.to_string())?;
        state.outbox.lock().unwrap().push(crate::store::OutboxEntry {
            id: chunk_id,
            peer: format!("group:{group_id}"),
            payload,
            topic: topic.clone(),
            group_id: Some(group_id.clone()),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            attempts: 0,
        });
    }
    persist(state);
    let _ = subscribe_with_relay(state, topic).await;
    retry_outbox(state).await;
    state.history.lock().unwrap().push_dm(
        &format!("group:{group_id}"),
        DmMessage {
            peer: format!("group:{group_id}"),
            text: String::new(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            mine: true,
            sender: Some(me),
            id: message_id.clone(),
            read: false,
            delivered: false,
            attachment_name: Some(name),
            attachment_mime: Some(mime),
            attachment_data: Some(data),
        },
    );
    persist(state);
    Ok(message_id)
}

#[tauri::command]
async fn send_group_attachment(
    state: State<'_, AppState>,
    group_id: String,
    name: String,
    mime: String,
    data: Vec<u8>,
) -> Result<String, String> {
    validate_text(&name, 255, "attachment name")?;
    validate_text(&mime, 127, "attachment type")?;
    if data.len() > MAX_DM_ATTACHMENT_BYTES {
        return send_group_attachment_chunked(&state, group_id, name, mime, data).await;
    }
    if data.is_empty() {
        return Err("Group attachments must be at least 1 byte".into());
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    let descriptor = state
        .groups
        .lock()
        .unwrap()
        .get(&group_id)
        .cloned()
        .ok_or("group not found")?;
    if !descriptor.members.iter().any(|member| member.peer_id == me) {
        return Err("you are not a member of this group".into());
    }
    let id = new_message_id();
    let topic = group_topic(&group_id);
    let body = serde_json::json!({
        "kind": "group-attachment",
        "groupId": group_id.clone(),
        "revision": descriptor.revision,
        "id": id.clone(),
        "name": name.clone(),
        "mime": mime.clone(),
        "data": B64.encode(&data),
    });
    let outbox_payload = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        let recipients: Vec<[u8; 32]> = descriptor
            .members
            .iter()
            .filter(|member| member.peer_id != me)
            .filter_map(|member| dir.recipient_key(&member.peer_id))
            .collect();
        if recipients.is_empty() {
            return Err("no group members have validated encryption keys".into());
        }
        dir.seal(&identity, &recipients, topic.as_bytes(), outbox_payload.as_bytes())?
    };
    state.outbox.lock().unwrap().push(crate::store::OutboxEntry {
        id: id.clone(),
        peer: format!("group:{group_id}"),
        payload: outbox_payload,
        topic: topic.clone(),
        group_id: Some(group_id.clone()),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        attempts: 0,
    });
    persist(&state);
    let _ = subscribe_with_relay(&state, topic.clone()).await;
    if let Some(node) = state.node.lock().unwrap().clone() {
        let _ = node.send(NodeCommand::Publish { topic, data: payload }).await;
    }
    state.history.lock().unwrap().push_dm(
        &format!("group:{group_id}"),
        DmMessage {
            peer: format!("group:{group_id}"),
            text: String::new(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            mine: true,
            sender: Some(me),
            id: id.clone(),
            read: false,
            delivered: false,
            attachment_name: Some(name),
            attachment_mime: Some(mime),
            attachment_data: Some(data),
        },
    );
    persist(&state);
    Ok(id)
}

#[tauri::command]
async fn update_group_members(
    state: State<'_, AppState>,
    group_id: String,
    peer_ids: Vec<String>,
) -> Result<GroupDescriptor, String> {
    if peer_ids.len() > 64 {
        return Err("group members cannot exceed 64".into());
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let descriptor = state
        .groups
        .lock()
        .unwrap()
        .get(&group_id)
        .cloned()
        .ok_or("group not found")?;
    if descriptor.owner_peer != identity.peer_id.to_string() {
        return Err("only the group owner can update membership".into());
    }
    let members = {
        let dir = state.dir.lock().unwrap();
        let dir = dir.as_ref().ok_or("not unlocked")?;
        peer_ids
            .iter()
            .map(|peer_id| {
                dir.recipient_key(peer_id)
                    .map(|x25519_pub| crate::crypto::group::GroupMember {
                        peer_id: peer_id.clone(),
                        x25519_pub,
                    })
                    .ok_or_else(|| format!("no validated encryption key for {peer_id}"))
            })
            .collect::<std::result::Result<Vec<_>, String>>()?
    };
    let next = descriptor.revise(&identity, members).map_err(|e| e.to_string())?;
    state.groups.lock().unwrap().insert(group_id.clone(), next.clone());
    subscribe_with_relay(&state, group_topic(&group_id)).await?;
    for member in &next.members {
        if member.peer_id != identity.peer_id.to_string() {
            let _ = deliver_group_invite(&state, &group_id, &member.peer_id).await;
        }
    }
    persist(&state);
    Ok(next)
}

#[tauri::command]
async fn leave_group(state: State<'_, AppState>, group_id: String) -> Result<(), String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let descriptor = state
        .groups
        .lock()
        .unwrap()
        .get(&group_id)
        .cloned()
        .ok_or("group not found")?;
    if descriptor.owner_peer == identity.peer_id.to_string() {
        return Err("the group owner must transfer ownership before leaving".into());
    }
    state.groups.lock().unwrap().remove(&group_id);
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Unsubscribe(group_topic(&group_id))).await?;
    persist(&state);
    Ok(())
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
async fn publish_server_message(
    state: &AppState,
    msg: SignedMessage,
) -> Result<SignedMessage, String> {
    let data = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish {
        topic: channel_topic(&msg.server_id, &msg.channel),
        data,
    })
    .await?;
    {
        let mut history = state.history.lock().unwrap();
        history.push_server(&format!("{}/{}", msg.server_id, msg.channel), msg.clone());
    }
    persist(state);
    Ok(msg)
}

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
    validate_text(&text, MAX_TEXT_BYTES, "message")?;
    validate_text(&channel, MAX_CHANNEL_NAME_BYTES, "channel")?;
    let me = identity.peer_id.to_string();
    {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        if !rec.can_write(&me, &channel) {
            return Err(PeersError::Forbidden.into());
        }
    }
    let msg = SignedMessage::sign(&identity.keypair, &server_id, &channel, &text)?;
    publish_server_message(&state, msg).await.map(|_| ())
}

#[tauri::command]
async fn publish_channel_action(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
    kind: String,
    target_sig: String,
    text: String,
    reaction: String,
) -> Result<SignedMessage, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    validate_text(&channel, MAX_CHANNEL_NAME_BYTES, "channel")?;
    if target_sig.is_empty() || target_sig.len() > 256 {
        return Err("a valid target message is required".into());
    }
    if reaction.len() > 16 {
        return Err("reaction is too long".into());
    }
    if matches!(kind.as_str(), "reply" | "edit") {
        validate_text(&text, MAX_TEXT_BYTES, "message")?;
    } else if !text.is_empty() {
        return Err("this action does not accept message text".into());
    }
    if !matches!(
        kind.as_str(),
        "reply" | "edit" | "delete" | "reaction" | "pin" | "unpin"
    ) {
        return Err("unsupported message action".into());
    }

    let me = identity.peer_id.to_string();
    {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        if !rec.can_write(&me, &channel) {
            return Err(PeersError::Forbidden.into());
        }
        let can_moderate = rec.role_of(&me).is_some_and(|role| role >= Role::Admin);
        let history = state.history.lock().unwrap();
        let target = history
            .server_messages(&format!("{server_id}/{channel}"))
            .iter()
            .find(|message| message.sig == target_sig)
            .ok_or("target message not found")?;
        if matches!(kind.as_str(), "edit" | "delete" | "pin" | "unpin")
            && target.from != me
            && !can_moderate
        {
            return Err("only the author or an admin can change this message".into());
        }
    }
    let msg = SignedMessage::sign_action(
        &identity.keypair,
        &server_id,
        &channel,
        &kind,
        &target_sig,
        &text,
        &reaction,
    )?;
    publish_server_message(&state, msg).await
}

#[tauri::command]
async fn publish_channel_attachment(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
    text: String,
    hash: String,
    name: String,
    mime: String,
    size: u64,
) -> Result<SignedMessage, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    validate_text(&channel, MAX_CHANNEL_NAME_BYTES, "channel")?;
    validate_text(&text, MAX_TEXT_BYTES, "attachment caption")?;
    validate_text(&name, 255, "attachment name")?;
    validate_text(&mime, 127, "attachment type")?;
    if p2p::parse_hex_hash(&hash).is_none() {
        return Err("invalid attachment hash".into());
    }
    if size == 0 || size > MAX_BLOB_BYTES as u64 {
        return Err(format!("attachment must be between 1 and {MAX_BLOB_BYTES} bytes"));
    }
    let me = identity.peer_id.to_string();
    {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        if !rec.can_write(&me, &channel) {
            return Err(PeersError::Forbidden.into());
        }
    }
    let msg = SignedMessage::sign_attachment(
        &identity.keypair,
        &server_id,
        &channel,
        &text,
        &hash,
        &name,
        &mime,
        size,
    )?;
    publish_server_message(&state, msg).await
}

#[tauri::command]
async fn publish_channel_attachment_chunked(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
    text: String,
    hashes: Vec<String>,
    name: String,
    mime: String,
    size: u64,
) -> Result<SignedMessage, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    validate_text(&channel, MAX_CHANNEL_NAME_BYTES, "channel")?;
    validate_text(&text, MAX_TEXT_BYTES, "attachment caption")?;
    validate_text(&name, 255, "attachment name")?;
    validate_text(&mime, 127, "attachment type")?;
    if hashes.is_empty() || hashes.len() > 512 {
        return Err("channel attachment must contain between 1 and 512 chunks".into());
    }
    if size == 0 || size > 8 * 1024 * 1024 {
        return Err("channel attachment must be between 1 and 8 MiB".into());
    }
    for hash in &hashes {
        if p2p::parse_hex_hash(hash).is_none() {
            return Err("invalid channel attachment chunk hash".into());
        }
    }
    let me = identity.peer_id.to_string();
    {
        let servers = state.servers.lock().unwrap();
        let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
        if !rec.can_write(&me, &channel) {
            return Err(PeersError::Forbidden.into());
        }
    }
    let msg = SignedMessage::sign_attachment_chunked(
        &identity.keypair,
        &server_id,
        &channel,
        &text,
        &hashes,
        &name,
        &mime,
        size,
    )?;
    publish_server_message(&state, msg).await
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
async fn publish(state: State<'_, AppState>, channel: String, text: String) -> Result<String, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    let id = new_message_id();
    validate_text(&text, MAX_TEXT_BYTES, "message")?;
    let outbox_payload = serde_json::to_string(&serde_json::json!({
        "kind": "text",
        "id": id.clone(),
        "text": text.clone(),
    }))
    .map_err(|e| e.to_string())?;
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
        let body = serde_json::to_vec(&serde_json::json!({
            "kind": "text",
            "id": id.clone(),
            "text": text.clone(),
        }))
        .map_err(|e| e.to_string())?;
        // Encrypt only to the intended recipient (not every contact), so the
        // envelope cannot be opened by anyone else subscribed to this topic.
        dir.seal(&identity, &[rcpt], topic.as_bytes(), &body)?
    };
    state.outbox.lock().unwrap().push(crate::store::OutboxEntry {
        id: id.clone(),
        peer: channel.clone(),
        payload: outbox_payload,
        topic: topic.clone(),
        group_id: None,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        attempts: 0,
    });
    persist(&state);
    // Subscribe (and ask relay nodes to mesh) first: a DM whose entry was
    // auto-created by an incoming message never had `subscribe()` called for
    // it, and gossipsub refuses to publish to an unsubscribed topic.
    let _ = subscribe_with_relay(&state, topic.clone()).await;
    if let Some(node) = state.node.lock().unwrap().clone() {
        let _ = node.send(NodeCommand::Publish { topic, data: payload }).await;
    }
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
                sender: Some(me.clone()),
                id: id.clone(),
                read: false,
            delivered: false,
                attachment_name: None,
                attachment_mime: None,
                attachment_data: None,
            },
        );
    }
    persist(&state);
    Ok(id)
}

async fn publish_attachment_chunked(
    state: &AppState,
    peer: String,
    name: String,
    mime: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.is_empty() || data.len() > MAX_DM_ATTACHMENT_TOTAL_BYTES {
        return Err(format!(
            "DM attachments must be between 1 and {MAX_DM_ATTACHMENT_TOTAL_BYTES} bytes"
        ));
    }
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    {
        let dir = state.dir.lock().unwrap();
        let Some(dir) = dir.as_ref() else {
            return Err("not unlocked".into());
        };
        if dir.recipient_key(&peer).is_none() {
            return Err("no encryption key for this peer yet — meet them on a server or the Plaza first".into());
        }
    }
    let message_id = new_message_id();
    let topic = format!("peers/v1/ch/{peer}");
    let chunk_count = data.len().div_ceil(MAX_DM_ATTACHMENT_CHUNK_BYTES);
    if chunk_count > MAX_DM_ATTACHMENT_CHUNKS {
        return Err("attachment has too many chunks".into());
    }
    for (chunk_index, chunk) in data.chunks(MAX_DM_ATTACHMENT_CHUNK_BYTES).enumerate() {
        let chunk_id = format!("{message_id}:{chunk_index}");
        let payload = serde_json::to_string(&serde_json::json!({
            "kind": "attachment-chunk",
            "id": chunk_id.clone(),
            "transferId": message_id.clone(),
            "name": name.clone(),
            "mime": mime.clone(),
            "totalSize": data.len(),
            "chunkIndex": chunk_index,
            "chunkCount": chunk_count,
            "data": B64.encode(chunk),
        }))
        .map_err(|e| e.to_string())?;
        state.outbox.lock().unwrap().push(crate::store::OutboxEntry {
            id: chunk_id,
            peer: peer.clone(),
            payload,
            topic: topic.clone(),
            group_id: None,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            attempts: 0,
        });
    }
    persist(state);
    let _ = subscribe_with_relay(state, topic).await;
    retry_outbox(state).await;
    state.history.lock().unwrap().push_dm(
        &peer,
        DmMessage {
            peer: peer.clone(),
            text: String::new(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            mine: true,
            sender: Some(me),
            id: message_id.clone(),
            read: false,
            delivered: false,
            attachment_name: Some(name),
            attachment_mime: Some(mime),
            attachment_data: Some(data),
        },
    );
    persist(state);
    Ok(message_id)
}

#[tauri::command]
async fn publish_attachment(
    state: State<'_, AppState>,
    peer: String,
    name: String,
    mime: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    if data.is_empty() || data.len() > MAX_DM_ATTACHMENT_TOTAL_BYTES {
        return Err(format!(
            "DM attachments must be between 1 and {MAX_DM_ATTACHMENT_TOTAL_BYTES} bytes"
        ));
    }
    validate_text(&name, 255, "attachment name")?;
    validate_text(&mime, 127, "attachment type")?;
    if data.len() > MAX_DM_ATTACHMENT_BYTES {
        return publish_attachment_chunked(&state, peer, name, mime, data).await;
    }
    let id = new_message_id();
    let topic = format!("peers/v1/ch/{peer}");
    let body = serde_json::json!({
        "kind": "attachment",
        "id": id.clone(),
        "name": name.clone(),
        "mime": mime.clone(),
        "data": B64.encode(&data),
    });
    let outbox_payload = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        let recipient = dir.recipient_key(&peer).ok_or_else(|| {
            PeersError::Crypto(
                "no encryption key for this peer yet — meet them on a server or the Plaza first"
                    .into(),
            )
        })?;
        let body = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
        dir.seal(&identity, &[recipient], topic.as_bytes(), &body)?
    };
    state.outbox.lock().unwrap().push(crate::store::OutboxEntry {
        id: id.clone(),
        peer: peer.clone(),
        payload: outbox_payload,
        topic: topic.clone(),
        group_id: None,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        attempts: 0,
    });
    persist(&state);
    let _ = subscribe_with_relay(&state, topic.clone()).await;
    if let Some(node) = state.node.lock().unwrap().clone() {
        let _ = node.send(NodeCommand::Publish { topic, data: payload }).await;
    }
    {
        let mut history = state.history.lock().unwrap();
        history.push_dm(
            &peer,
            DmMessage {
                peer: peer.clone(),
                text: String::new(),
                ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                mine: true,
                sender: Some(me.clone()),
                id: id.clone(),
                read: false,
            delivered: false,
                attachment_name: Some(name),
                attachment_mime: Some(mime),
                attachment_data: Some(data),
            },
        );
    }
    persist(&state);
    Ok(id)
}

#[tauri::command]
async fn mark_group_read(
    state: State<'_, AppState>,
    group_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    if ids.is_empty() || ids.len() > 100 {
        return Err("group read receipts must contain between 1 and 100 message ids".into());
    }
    if ids.iter().any(|id| id.is_empty() || id.len() > 64) {
        return Err("invalid group read receipt message id".into());
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let me = identity.peer_id.to_string();
    let descriptor = state
        .groups
        .lock()
        .unwrap()
        .get(&group_id)
        .cloned()
        .ok_or("group not found")?;
    let topic = group_topic(&group_id);
    let recipients: Vec<[u8; 32]> = {
        let dir = state.dir.lock().unwrap();
        let Some(dir) = dir.as_ref() else { return Err("not unlocked".into()) };
        descriptor
            .members
            .iter()
            .filter(|member| member.peer_id != me)
            .filter_map(|member| dir.recipient_key(&member.peer_id))
            .collect()
    };
    if recipients.is_empty() {
        return Err("no group members have validated encryption keys".into());
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "kind": "read",
        "groupId": group_id,
        "ids": ids,
    }))
    .map_err(|e| e.to_string())?;
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        dir.seal(&identity, &recipients, topic.as_bytes(), &body)?
    };
    subscribe_with_relay(&state, topic.clone()).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish { topic, data: payload }).await?;
    Ok(())
}

#[tauri::command]
async fn mark_dm_read(
    state: State<'_, AppState>,
    peer: String,
    ids: Vec<String>,
) -> Result<(), String> {
    if ids.is_empty() || ids.len() > 100 {
        return Err("read receipts must contain between 1 and 100 message ids".into());
    }
    if ids.iter().any(|id| id.is_empty() || id.len() > 64) {
        return Err("invalid read receipt message id".into());
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("not unlocked")?;
    let topic = format!("peers/v1/ch/{peer}");
    let body = serde_json::to_vec(&serde_json::json!({"kind": "read", "ids": ids}))
        .map_err(|e| e.to_string())?;
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        let recipient = dir.recipient_key(&peer).ok_or("no encryption key for this peer")?;
        dir.seal(&identity, &[recipient], topic.as_bytes(), &body)?
    };
    subscribe_with_relay(&state, topic.clone()).await?;
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish { topic, data: payload }).await?;
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
            let before = history.server_messages(&key).len();
            history.push_server(&key, msg);
            if history.server_messages(&key).len() > before {
                imported += 1;
            }
            let list = history.server.entry(key).or_default();
            list.sort_by_key(|m| m.ts);
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
    validate_text(&display_name, MAX_DISPLAY_NAME_BYTES, "display name")?;
    validate_text(&about, MAX_ABOUT_BYTES, "about")?;
    if let Some(hash) = &avatar_hash {
        validate_text(hash, 128, "avatar hash")?;
    }
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
    validate_text(&text, MAX_TEXT_BYTES, "Plaza message")?;
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
        .filter(|(_, ts)| **ts <= now && now.saturating_sub(**ts) < PLAZA_PRESENCE_WINDOW_SECS)
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
async fn park_blob(state: State<'_, AppState>, data: Vec<u8>) -> Result<(), String> {
    if data.len() > MAX_BLOB_BYTES {
        return Err(format!(
            "blob too large: {} bytes (max {})",
            data.len(),
            MAX_BLOB_BYTES
        ));
    }
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::ParkBlob(data)).await?;
    Ok(())
}

#[tauri::command]
async fn fetch_blob(state: State<'_, AppState>, hash: String) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let hash = p2p::parse_hex_hash(&hash).ok_or("invalid hash")?;
    node.send(NodeCommand::FetchBlob(hash)).await?;
    Ok(())
}

async fn receive_attachment_chunk(
    state: &AppState,
    app: &AppHandle,
    identity: &Identity,
    topic: &str,
    from: &str,
    envelope: &[u8],
    chunk: DmAttachmentChunkPayload,
) -> Result<(), String> {
    if chunk.kind != "attachment-chunk"
        || chunk.id.is_empty()
        || chunk.id.len() > 64
        || chunk.transfer_id.is_empty()
        || chunk.transfer_id.len() > 64
        || chunk.name.is_empty()
        || chunk.name.len() > 255
        || chunk.mime.is_empty()
        || chunk.mime.len() > 127
        || chunk.total_size == 0
        || chunk.total_size > MAX_DM_ATTACHMENT_TOTAL_BYTES
        || chunk.chunk_count == 0
        || chunk.chunk_count > MAX_DM_ATTACHMENT_CHUNKS
        || chunk.chunk_index >= chunk.chunk_count
    {
        return Err("invalid attachment chunk metadata".into());
    }
    let expected_chunks = chunk.total_size.div_ceil(MAX_DM_ATTACHMENT_CHUNK_BYTES);
    if expected_chunks != chunk.chunk_count {
        return Err("attachment chunk count does not match size".into());
    }
    let bytes = B64
        .decode(&chunk.data)
        .map_err(|_| "invalid attachment chunk encoding".to_string())?;
    let expected_size = if chunk.chunk_index + 1 == chunk.chunk_count {
        chunk
            .total_size
            .checked_sub(chunk.chunk_index * MAX_DM_ATTACHMENT_CHUNK_BYTES)
            .ok_or("attachment chunk offset overflow")?
    } else {
        MAX_DM_ATTACHMENT_CHUNK_BYTES
    };
    if bytes.len() != expected_size || bytes.is_empty() {
        return Err("attachment chunk has the wrong size".into());
    }

    if let Ok(card) = crate::crypto::card::card_from_envelope(envelope) {
        let mut dir = state.dir.lock().unwrap();
        if let Some(dir) = dir.as_mut() {
            dir.remember_contact(from, &card);
        }
    }

    let already_stored = state
        .history
        .lock()
        .unwrap()
        .dm_messages(from)
        .iter()
        .any(|message| message.id == chunk.transfer_id);
    let mut completed: Option<DmMessage> = None;
    {
        let mut transfers = state.incoming_transfers.lock().unwrap();
        if let Some(existing) = transfers.get(&chunk.transfer_id) {
            if existing.peer != from
                || existing.message_id != chunk.transfer_id
                || existing.name != chunk.name
                || existing.mime != chunk.mime
                || existing.total_size != chunk.total_size
                || existing.chunk_count != chunk.chunk_count
            {
                return Err("attachment transfer metadata changed".into());
            }
        } else {
            if transfers.len() >= MAX_INCOMING_TRANSFERS {
                return Err("too many incomplete attachment transfers".into());
            }
            transfers.insert(
                chunk.transfer_id.clone(),
                IncomingTransfer {
                    peer: from.to_string(),
                    group_id: None,
                    revision: 0,
                    message_id: chunk.transfer_id.clone(),
                    name: chunk.name.clone(),
                    mime: chunk.mime.clone(),
                    total_size: chunk.total_size,
                    chunk_count: chunk.chunk_count,
                    chunks: vec![None; chunk.chunk_count],
                },
            );
        }
        let transfer = transfers
            .get_mut(&chunk.transfer_id)
            .ok_or("attachment transfer disappeared")?;
        transfer.chunks[chunk.chunk_index] = Some(bytes);
        if transfer.chunks.iter().all(|chunk| chunk.is_some()) {
            let transfer = transfers
                .remove(&chunk.transfer_id)
                .ok_or("attachment transfer disappeared")?;
            let mut data = Vec::with_capacity(transfer.total_size);
            for part in transfer.chunks.into_iter().flatten() {
                data.extend_from_slice(&part);
            }
            if data.len() != transfer.total_size {
                return Err("assembled attachment has the wrong size".into());
            }
            if !already_stored {
                completed = Some(DmMessage {
                    peer: transfer.peer.clone(),
                    text: String::new(),
                    ts: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    mine: false,
                    sender: Some(transfer.peer),
                    id: transfer.message_id,
                    read: false,
            delivered: false,
                    attachment_name: Some(transfer.name),
                    attachment_mime: Some(transfer.mime),
                    attachment_data: Some(data),
                });
            }
        }
    }
    persist(state);
    if let Some(message) = completed {
        let peer = message.peer.clone();
        let event = serde_json::json!({
            "from": peer.clone(),
            "channel": topic,
            "text": "",
            "attachmentName": message.attachment_name.clone(),
            "attachmentMime": message.attachment_mime.clone(),
            "attachmentData": message.attachment_data.clone(),
        });
        state.history.lock().unwrap().push_dm(&peer, message);
        persist(state);
        let _ = app.emit("node://message", event);
    }

    let ack_body = serde_json::to_vec(&serde_json::json!({
        "kind": "ack",
        "id": chunk.id,
    }))
    .map_err(|e| e.to_string())?;
    let ack_payload = {
        let mut dir = state.dir.lock().unwrap();
        let Some(dir) = dir.as_mut() else { return Ok(()) };
        let Some(recipient) = dir.recipient_key(from) else { return Ok(()) };
        dir.seal(identity, &[recipient], topic.as_bytes(), &ack_body).ok()
    };
    if let Some(ack_payload) = ack_payload {
        if let Some(node) = state.node.lock().unwrap().clone() {
            let _ = node
                .send(NodeCommand::Publish {
                    topic: topic.to_string(),
                    data: ack_payload,
                })
                .await;
        }
    }
    Ok(())
}

async fn receive_group_attachment_chunk(
    state: &AppState,
    app: &AppHandle,
    identity: &Identity,
    topic: &str,
    group_id: &str,
    from: &str,
    envelope: &[u8],
    chunk: GroupAttachmentChunkPayload,
) -> Result<(), String> {
    if chunk.kind != "group-attachment-chunk"
        || chunk.id.is_empty()
        || chunk.id.len() > 64
        || chunk.group_id != group_id
        || chunk.transfer_id.is_empty()
        || chunk.transfer_id.len() > 64
        || chunk.name.is_empty()
        || chunk.name.len() > 255
        || chunk.mime.is_empty()
        || chunk.mime.len() > 127
        || chunk.total_size == 0
        || chunk.total_size > MAX_DM_ATTACHMENT_TOTAL_BYTES
        || chunk.chunk_count == 0
        || chunk.chunk_count > MAX_DM_ATTACHMENT_CHUNKS
        || chunk.chunk_index >= chunk.chunk_count
    {
        return Err("invalid group attachment chunk metadata".into());
    }
    let current_revision = state
        .groups
        .lock()
        .unwrap()
        .get(group_id)
        .map(|group| group.revision)
        .unwrap_or(0);
    if chunk.revision < current_revision {
        return Err("group attachment revision is stale".into());
    }
    if chunk.total_size.div_ceil(MAX_DM_ATTACHMENT_CHUNK_BYTES) != chunk.chunk_count {
        return Err("group attachment chunk count does not match size".into());
    }
    let bytes = B64
        .decode(&chunk.data)
        .map_err(|_| "invalid group attachment chunk encoding".to_string())?;
    let expected_size = if chunk.chunk_index + 1 == chunk.chunk_count {
        chunk
            .total_size
            .checked_sub(chunk.chunk_index * MAX_DM_ATTACHMENT_CHUNK_BYTES)
            .ok_or("group attachment chunk offset overflow")?
    } else {
        MAX_DM_ATTACHMENT_CHUNK_BYTES
    };
    if bytes.len() != expected_size || bytes.is_empty() {
        return Err("group attachment chunk has the wrong size".into());
    }
    if let Ok(card) = crate::crypto::card::card_from_envelope(envelope) {
        let mut dir = state.dir.lock().unwrap();
        if let Some(dir) = dir.as_mut() {
            dir.remember_contact(from, &card);
        }
    }

    let history_key = format!("group:{group_id}");
    let already_stored = state
        .history
        .lock()
        .unwrap()
        .dm_messages(&history_key)
        .iter()
        .any(|message| message.id == chunk.transfer_id);
    let mut completed: Option<DmMessage> = None;
    {
        let mut transfers = state.incoming_transfers.lock().unwrap();
        if let Some(existing) = transfers.get(&chunk.transfer_id) {
            if existing.peer != from
                || existing.group_id.as_deref() != Some(group_id)
                || existing.revision != chunk.revision
                || existing.message_id != chunk.transfer_id
                || existing.name != chunk.name
                || existing.mime != chunk.mime
                || existing.total_size != chunk.total_size
                || existing.chunk_count != chunk.chunk_count
            {
                return Err("group attachment transfer metadata changed".into());
            }
        } else {
            if transfers.len() >= MAX_INCOMING_TRANSFERS {
                return Err("too many incomplete attachment transfers".into());
            }
            transfers.insert(
                chunk.transfer_id.clone(),
                IncomingTransfer {
                    peer: from.to_string(),
                    group_id: Some(group_id.to_string()),
                    revision: chunk.revision,
                    message_id: chunk.transfer_id.clone(),
                    name: chunk.name.clone(),
                    mime: chunk.mime.clone(),
                    total_size: chunk.total_size,
                    chunk_count: chunk.chunk_count,
                    chunks: vec![None; chunk.chunk_count],
                },
            );
        }
        let transfer = transfers
            .get_mut(&chunk.transfer_id)
            .ok_or("group attachment transfer disappeared")?;
        transfer.chunks[chunk.chunk_index] = Some(bytes);
        if transfer.chunks.iter().all(|chunk| chunk.is_some()) {
            let transfer = transfers
                .remove(&chunk.transfer_id)
                .ok_or("group attachment transfer disappeared")?;
            let mut data = Vec::with_capacity(transfer.total_size);
            for part in transfer.chunks.into_iter().flatten() {
                data.extend_from_slice(&part);
            }
            if data.len() != transfer.total_size {
                return Err("assembled group attachment has the wrong size".into());
            }
            if !already_stored {
                completed = Some(DmMessage {
                    peer: history_key.clone(),
                    text: String::new(),
                    ts: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    mine: false,
                    sender: Some(from.to_string()),
                    id: transfer.message_id,
                    read: false,
                    delivered: false,
                    attachment_name: Some(transfer.name),
                    attachment_mime: Some(transfer.mime),
                    attachment_data: Some(data),
                });
            }
        }
    }
    persist(state);
    if let Some(message) = completed {
        let event = serde_json::json!({
            "from": from,
            "channel": topic,
            "text": "",
            "attachmentName": message.attachment_name.clone(),
            "attachmentMime": message.attachment_mime.clone(),
            "attachmentData": message.attachment_data.clone(),
        });
        state.history.lock().unwrap().push_dm(&history_key, message);
        persist(state);
        let _ = app.emit("node://message", event);
    }

    let ack_body = serde_json::to_vec(&serde_json::json!({
        "kind": "ack",
        "groupId": group_id,
        "id": chunk.id,
    }))
    .map_err(|e| e.to_string())?;
    let ack_payload = {
        let mut dir = state.dir.lock().unwrap();
        let Some(dir) = dir.as_mut() else { return Ok(()) };
        let Some(recipient) = dir.recipient_key(from) else { return Ok(()) };
        dir.seal(identity, &[recipient], topic.as_bytes(), &ack_body).ok()
    };
    if let Some(ack_payload) = ack_payload {
        if let Some(node) = state.node.lock().unwrap().clone() {
            let _ = node
                .send(NodeCommand::Publish {
                    topic: topic.to_string(),
                    data: ack_payload,
                })
                .await;
        }
    }
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
            bootstrap_directory_nodes,
            retry_outbox_command,
            unlock,
            lock,
            subscribe,
            unsubscribe,
            publish,
            publish_attachment,
            mark_group_read,
            mark_dm_read,
            park_blob,
            fetch_blob,
            create_group_descriptor,
            verify_group_invite,
            list_groups,
            send_group_invite,
            update_group_members,
            leave_group,
            accept_group,
            send_group,
            send_group_attachment,
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
            publish_channel_action,
            publish_channel_attachment,
            publish_channel_attachment_chunked,
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
                                                    if p.verify().is_ok()
                                                        && p.peer_id == m.peer_id
                                                        && validate_profile_fields(p).is_ok()
                                                    {
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
                            if notice.kind != JoinNotice::KIND
                                || notice.server_id != server_id
                                || notice.peer_id != from
                                || notice.card.verify_for_peer(&from).is_err()
                                || validate_text(&notice.name, MAX_DISPLAY_NAME_BYTES, "member name")
                                    .is_err()
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
                                if profile.verify().is_ok()
                                    && profile.peer_id == notice.peer_id
                                    && validate_profile_fields(profile).is_ok()
                                {
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
                            let valid_member = {
                                let servers = state.servers.lock().unwrap();
                                servers
                                    .get(&pn.server_id)
                                    .is_some_and(|rec| rec.role_of(&pn.peer_id).is_some())
                            };
                            if pn.kind == ProfileNotice::KIND
                                && pn.server_id == server_id
                                && pn.peer_id == from
                                && valid_member
                                && pn.profile.verify().is_ok()
                                && pn.profile.peer_id == pn.peer_id
                                && validate_profile_fields(&pn.profile).is_ok()
                            {
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
                            if validate_text(&msg.text, MAX_TEXT_BYTES, "message").is_err()
                                || validate_text(&msg.channel, MAX_CHANNEL_NAME_BYTES, "channel")
                                    .is_err()
                            {
                                return;
                            }
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
                                        "sig": msg.sig,
                                        "kind": msg.kind,
                                        "targetSig": msg.target_sig,
                                        "reaction": msg.reaction,
                                        "attachmentHash": msg.attachment_hash,
                                         "attachmentChunkHashes": msg.attachment_chunk_hashes,
                                        "attachmentName": msg.attachment_name,
                                        "attachmentMime": msg.attachment_mime,
                                        "attachmentSize": msg.attachment_size,
                                    }),
                                );
                            }
                        }
                        return;
                    }
                    // Global Plaza: self-signed chat + profile announcements.
                    if topic == PLAZA_TOPIC {
                        if let Ok(msg) = serde_json::from_slice::<PlazaMessage>(&data) {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            let valid = msg.verify().is_ok()
                                && msg.ts <= now.saturating_add(MAX_PLAZA_FUTURE_SKEW_SECS)
                                && msg.ts >= now.saturating_sub(MAX_PLAZA_AGE_SECS)
                                && validate_text(&msg.text, MAX_TEXT_BYTES, "Plaza message")
                                    .is_ok()
                                && msg.card.as_ref().is_some_and(|card| {
                                    card.verify_for_peer(&msg.from).is_ok()
                                })
                                && match msg.kind.as_str() {
                                    PlazaMessage::KIND_CHAT => {
                                        !msg.text.trim().is_empty() && msg.profile.is_none()
                                    }
                                    PlazaMessage::KIND_PROFILE => {
                                        msg.text.is_empty()
                                            && msg.profile.as_ref().is_some_and(|p| {
                                                validate_profile_fields(p).is_ok()
                                            })
                                    }
                                    _ => false,
                                };
                            if valid {
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
                    let group_id = topic
                        .strip_prefix(crate::crypto::GROUP_TOPIC_PREFIX)
                        .map(str::to_string);
                    if let Some(group_id) = &group_id {
                        let member = state
                            .groups
                            .lock()
                            .unwrap()
                            .get(group_id)
                            .is_some_and(|group| {
                                group.members.iter().any(|member| member.peer_id == identity.peer_id.to_string())
                            });
                        if !member {
                            return;
                        }
                    }
                    // Bind the envelope's self-authenticating card to the
                    // authenticated gossipsub source. Otherwise a valid
                    // envelope could be replayed by another peer as if it
                    // came from that card's owner.
                    match crate::crypto::card::card_from_envelope(&data)
                        .and_then(|card| card.verify_for_peer(&from).map(|_| card))
                    {
                        Ok(_) => {}
                        Err(_) => return,
                    }
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
                            if plaintext.len() > MAX_DM_ENVELOPE_PLAINTEXT_BYTES {
                                return;
                            }
                            if group_id.is_none() {
                                if let Ok(chunk) = serde_json::from_slice::<DmAttachmentChunkPayload>(&plaintext) {
                                    if chunk.kind == "attachment-chunk" {
                                        let _ = receive_attachment_chunk(
                                            &state,
                                            &app_handle,
                                            &identity,
                                            &topic,
                                            &from,
                                            &data,
                                            chunk,
                                        )
                                        .await;
                                        return;
                                    }
                                }
                            }
                            let mut incoming_text = None;
                            let mut incoming_id = None;
                            if group_id.is_none() {
                                if let Ok(read) = serde_json::from_slice::<DmReadPayload>(&plaintext) {
                                    if read.kind == "read" && read.ids.len() <= 100 {
                                        {
                                            let mut history = state.history.lock().unwrap();
                                            if let Some(messages) = history.dm.get_mut(&from) {
                                                for message in messages.iter_mut().filter(|message| read.ids.iter().any(|id| id == &message.id)) {
                                                    message.read = true;
                                                }
                                            }
                                        }
                                        persist(&app_handle.state::<AppState>());
                                        let _ = app_handle.emit("node://read", serde_json::json!({"from": from, "ids": read.ids}));
                                        return;
                                    }
                                }
                                if let Ok(control) = serde_json::from_slice::<DmTextPayload>(&plaintext) {
                                    if control.kind == "ack" {
                                        let mut outbox = state.outbox.lock().unwrap();
                                        outbox.retain(|entry| entry.id != control.id);
                                        let delivery_id = control
                                            .id
                                            .split_once(':')
                                            .map(|(id, _)| id.to_string())
                                            .unwrap_or_else(|| control.id.clone());
                                        let transfer_complete = if control.id.contains(':') {
                                            let prefix = format!("{delivery_id}:");
                                            !outbox.iter().any(|entry| entry.id.starts_with(&prefix))
                                        } else {
                                            true
                                        };
                                        drop(outbox);
                                        if transfer_complete {
                                            let mut history = state.history.lock().unwrap();
                                            if let Some(messages) = history.dm.get_mut(&from) {
                                                if let Some(message) = messages.iter_mut().find(|message| message.id == delivery_id) {
                                                    message.delivered = true;
                                                }
                                            }
                                        }
                                        persist(&app_handle.state::<AppState>());
                                        let event_id = if transfer_complete { delivery_id } else { control.id.clone() };
                                        let _ = app_handle.emit("node://ack", serde_json::json!({"id": event_id}));
                                        return;
                                    }
                                    if control.kind == "text" && control.text.len() <= MAX_TEXT_BYTES {
                                        incoming_id = Some(control.id);
                                        incoming_text = Some(control.text);
                                    }
                                }
                            }
                            if let Some(group_id) = &group_id {
                                if let Ok(ack) = serde_json::from_slice::<GroupAckPayload>(&plaintext) {
                                    if ack.kind == "ack" && ack.group_id == *group_id {
                                        let mut outbox = state.outbox.lock().unwrap();
                                        outbox.retain(|entry| entry.id != ack.id);
                                        let delivery_id = ack
                                            .id
                                            .split_once(':')
                                            .map(|(id, _)| id.to_string())
                                            .unwrap_or_else(|| ack.id.clone());
                                        let transfer_complete = if ack.id.contains(':') {
                                            let prefix = format!("{delivery_id}:");
                                            !outbox.iter().any(|entry| entry.id.starts_with(&prefix))
                                        } else {
                                            true
                                        };
                                        drop(outbox);
                                        if transfer_complete {
                                            let mut history = state.history.lock().unwrap();
                                            let key = format!("group:{}", group_id);
                                            if let Some(messages) = history.dm.get_mut(&key) {
                                                if let Some(message) = messages.iter_mut().find(|message| message.id == delivery_id) {
                                                    message.delivered = true;
                                                }
                                            }
                                        }
                                        persist(&app_handle.state::<AppState>());
                                        let event_id = if transfer_complete { delivery_id } else { ack.id.clone() };
                                        let _ = app_handle.emit("node://ack", serde_json::json!({"id": event_id}));
                                        return;
                                    }
                                }
                            }
                            if let Some(group_id) = &group_id {
                                if let Ok(read) = serde_json::from_slice::<GroupReadPayload>(&plaintext) {
                                    if read.kind == "read" && read.group_id == *group_id && read.ids.len() <= 100 {
                                        {
                                            let mut history = state.history.lock().unwrap();
                                            let key = format!("group:{}", group_id);
                                            if let Some(messages) = history.dm.get_mut(&key) {
                                                for message in messages.iter_mut().filter(|message| read.ids.iter().any(|id| id == &message.id)) {
                                                    message.read = true;
                                                }
                                            }
                                        }
                                        persist(&app_handle.state::<AppState>());
                                        let _ = app_handle.emit("node://group-read", serde_json::json!({
                                            "groupId": group_id,
                                            "from": from,
                                            "ids": read.ids,
                                        }));
                                        return;
                                    }
                                }
                            }
                            if let Some(group_id) = &group_id {
                                if let Ok(chunk) = serde_json::from_slice::<GroupAttachmentChunkPayload>(&plaintext) {
                                    if chunk.kind == "group-attachment-chunk" {
                                        let _ = receive_group_attachment_chunk(
                                            &state,
                                            &app_handle,
                                            &identity,
                                            &topic,
                                            group_id,
                                            &from,
                                            &data,
                                            chunk,
                                        )
                                        .await;
                                        return;
                                    }
                                }
                            }
                            let group_attachment = if let Some(group_id) = &group_id {
                                match serde_json::from_slice::<GroupAttachmentPayload>(&plaintext) {
                                    Ok(payload) if payload.kind == "group-attachment" => {
                                        if payload.group_id != *group_id
                                            || payload.name.is_empty()
                                            || payload.name.len() > 255
                                            || payload.mime.is_empty()
                                            || payload.mime.len() > 127
                                        {
                                            return;
                                        }
                                        let current_revision = state
                                            .groups
                                            .lock()
                                            .unwrap()
                                            .get(group_id)
                                            .map(|group| group.revision)
                                            .unwrap_or(0);
                                        if payload.revision < current_revision {
                                            return;
                                        }
                                        let bytes = match B64.decode(&payload.data) {
                                            Ok(bytes) if !bytes.is_empty() && bytes.len() <= MAX_DM_ATTACHMENT_BYTES => bytes,
                                            _ => return,
                                        };
                                        incoming_id = Some(payload.id.clone());
                                        Some((
                                            DmAttachmentPayload {
                                                kind: "attachment".into(),
                                                id: payload.id,
                                                name: payload.name,
                                                mime: payload.mime,
                                                data: payload.data,
                                            },
                                            bytes,
                                        ))
                                    }
                                    _ => None,
                                }
                            } else {
                                None
                            };
                            let group_text = if group_attachment.is_some() {
                                None
                            } else if let Some(group_id) = &group_id {
                                let payload: GroupMessagePayload = match serde_json::from_slice(&plaintext) {
                                    Ok(payload) => payload,
                                    Err(_) => return,
                                };
                                if payload.group_id != *group_id || payload.text.len() > MAX_TEXT_BYTES {
                                    return;
                                }
                                let current_revision = state
                                    .groups
                                    .lock()
                                    .unwrap()
                                    .get(group_id)
                                    .map(|group| group.revision)
                                    .unwrap_or(0);
                                if payload.revision < current_revision {
                                    return;
                                }
                                incoming_id = Some(payload.id);
                                Some(payload.text)
                            } else {
                                None
                            };
                            if let Ok(invite) = serde_json::from_slice::<GroupInvite>(&plaintext) {
                                if invite.verify().is_err() {
                                    return;
                                }
                                let mut invites = state.group_invites.lock().unwrap();
                                if !invites.iter().any(|existing| {
                                    existing.descriptor.group_id == invite.descriptor.group_id
                                }) {
                                    invites.push(invite.clone());
                                }
                                drop(invites);
                                let _ = app_handle.emit("group://invite", invite);
                                return;
                            }
                            let attachment = if let Some(attachment) = group_attachment {
                                Some(attachment)
                            } else {
                                match serde_json::from_slice::<DmAttachmentPayload>(&plaintext) {
                                Ok(payload) if payload.kind == "attachment" => {
                                    if payload.name.is_empty()
                                        || payload.name.len() > 255
                                        || payload.mime.is_empty()
                                        || payload.mime.len() > 127
                                    {
                                        return;
                                    }
                                    let bytes = match B64.decode(&payload.data) {
                                        Ok(bytes) if !bytes.is_empty() && bytes.len() <= MAX_DM_ATTACHMENT_BYTES => bytes,
                                        _ => return,
                                    };
                                    incoming_id = Some(payload.id.clone());
                                    Some((payload, bytes))
                                }
                                _ => None,
                                }
                            };
                            let text = if let Some(text) = incoming_text {
                                text
                            } else if let Some(text) = group_text {
                                text
                            } else if attachment.is_some() {
                                String::new()
                            } else {
                                if plaintext.len() > MAX_TEXT_BYTES {
                                    return;
                                }
                                String::from_utf8_lossy(&plaintext).to_string()
                            };
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
                                let history_key = group_id
                                    .as_ref()
                                    .map(|id| format!("group:{id}"))
                                    .unwrap_or_else(|| from.clone());
                                let history_peer = group_id
                                    .as_ref()
                                    .map(|id| format!("group:{id}"))
                                    .unwrap_or_else(|| from.clone());
                                history.push_dm(
                                    &history_key,
                                    DmMessage {
                                        peer: history_peer,
                                        text: text.clone(),
                                        ts: std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .map(|d| d.as_secs())
                                            .unwrap_or(0),
                                        mine: false,
                                        sender: Some(from.clone()),
                                         id: incoming_id.unwrap_or_default(),
                                         read: false,
            delivered: false,
                                        attachment_name: attachment.as_ref().map(|(payload, _)| payload.name.clone()),
                                        attachment_mime: attachment.as_ref().map(|(payload, _)| payload.mime.clone()),
                                        attachment_data: attachment.as_ref().map(|(_, bytes)| bytes.clone()),
                                    },
                                );
                            }
                            if group_id.is_none() {
                                if let Some(message_id) = incoming_id.clone() {
                                    let ack_topic = format!("peers/v1/ch/{from}");
                                    let ack_payload = {
                                        let mut dir = state.dir.lock().unwrap();
                                        let Some(dir) = dir.as_mut() else { return };
                                        let Some(recipient) = dir.recipient_key(&from) else { return };
                                        let body = serde_json::to_vec(&serde_json::json!({
                                            "kind": "ack",
                                            "id": message_id,
                                        }))
                                        .unwrap_or_default();
                                        dir.seal(&identity, &[recipient], ack_topic.as_bytes(), &body).ok()
                                    };
                                    if let Some(ack_payload) = ack_payload {
                                        let _ = subscribe_with_relay(&state, ack_topic.clone()).await;
                                        let node = state.node.lock().unwrap().clone();
                                        if let Some(node) = node {
                                            let _ = node.send(NodeCommand::Publish { topic: ack_topic, data: ack_payload }).await;
                                        }
                                    }
                                }
                            } else if let (Some(group_id), Some(message_id)) = (&group_id, incoming_id.clone()) {
                                let ack_payload = {
                                    let mut dir = state.dir.lock().unwrap();
                                    let Some(dir) = dir.as_mut() else { return };
                                    let Some(recipient) = dir.recipient_key(&from) else { return };
                                    let body = serde_json::to_vec(&serde_json::json!({
                                        "kind": "ack",
                                        "groupId": group_id,
                                        "id": message_id,
                                    }))
                                    .unwrap_or_default();
                                    dir.seal(&identity, &[recipient], topic.as_bytes(), &body).ok()
                                };
                                if let Some(ack_payload) = ack_payload {
                                    let _ = subscribe_with_relay(&state, topic.clone()).await;
                                    let node = state.node.lock().unwrap().clone();
                                    if let Some(node) = node {
                                        let _ = node.send(NodeCommand::Publish { topic: topic.clone(), data: ack_payload }).await;
                                    }
                                }
                            }
                            persist(&app_handle.state::<AppState>());
                            let _ = app_handle.emit(
                                "node://message",
                                serde_json::json!({
                                    "from": from,
                                    "channel": topic,
                                    "text": text,
                                    "attachmentName": attachment.as_ref().map(|(payload, _)| payload.name.clone()),
                                    "attachmentMime": attachment.as_ref().map(|(payload, _)| payload.mime.clone()),
                                    "attachmentData": attachment.as_ref().map(|(_, bytes)| bytes.clone()),
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
            outbox_pending: 0,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"listenAddrs\""), "frontend expects camelCase");
        assert!(json.contains("\"externalAddrs\""));
        assert!(json.contains("\"relayReservations\""));
        assert!(json.contains("\"reachabilityMeasured\""));
        assert!(json.contains("\"knownNodes\""));
        assert!(json.contains("\"outboxPending\""));
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
