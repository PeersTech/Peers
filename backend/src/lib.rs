mod crypto;
mod error;
mod node;
mod p2p;
mod store;

pub use node::run_headless;

use crate::crypto::card::{PeerCard, SignedProfile};
use crate::crypto::server::{
    channel_topic, new_server_id, server_topic, ChannelConfig, Invite, JoinNotice, Member,
    ProfileNotice, Role, ServerDir, ServerRecord, ServerView, SignedList, SignedMessage, Snapshot,
};
use crate::crypto::{Identity, Keystore, SessionDir};
use crate::error::PeersError;
use crate::p2p::{NodeCommand, NodeEvent, NodeHandle};
use crate::store::{
    state_apply, state_from, DmMessage, History, PersistedState, Store, StoreHandle,
};
use libp2p::multiaddr::Protocol;
use libp2p::{Multiaddr, PeerId};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, State, WindowEvent};

/// Gossip topic clients use to ask always-on relay nodes to mesh the topics
/// they subscribe to. Mirrors `p2p::RELAY_CONTROL_TOPIC`.
const RELAY_CONTROL_TOPIC: &str = "peers/v1/relay";

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

/// First-run: generate an identity and seal it with the password.
#[tauri::command]
fn init_identity(state: State<AppState>, password: String) -> Result<IdentityInfo, String> {
    if state.keystore.exists() {
        return Err("identity already exists".into());
    }
    if password.len() < 8 {
        return Err("password must be at least 8 characters".into());
    }
    let id = state.keystore.create(&password)?;
    Ok(info_for(&id)?)
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

    // Unlock the sealed state store and restore servers/contacts/history
    // before the node comes up.
    let store_handle = state.store.open(&password)?;
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

    let handle = p2p::spawn(id.clone())?;
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
                _ => {}
            }
            let _ = app2.emit("node://event", &ev);
        }
    });

    // Listen + bootstrap against the public IPFS testnet.
    let _ = handle.send(NodeCommand::Listen).await;
    // The relay-control topic is how we register with (and reach) the
    // always-on backbone nodes; we must subscribe to publish on it.
    let _ = handle
        .send(NodeCommand::Subscribe(RELAY_CONTROL_TOPIC.to_string()))
        .await;
    // Receive DMs addressed to us: our own peer id is our DM topic.
    let _ = subscribe_with_relay(&state, format!("peers/v1/ch/{}", id.peer_id)).await;
    // Re-subscribe to every server control topic we know about.
    let records = state.servers.lock().unwrap().records();
    for rec in records {
        let _ = subscribe_with_relay(&state, server_topic(&rec.id)).await;
    }
    // Dial any known always-on nodes so we reach peers we share no mesh with.
    for ma in crate::p2p::bootstrap::known_nodes() {
        let _ = handle.send(NodeCommand::Dial(ma)).await;
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
    *state.profile.lock().unwrap() = None;
    *state.profiles.lock().unwrap() = HashMap::new();
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
    state.servers.lock().unwrap().remove(&server_id);
    node.send(NodeCommand::Unsubscribe(server_topic(&server_id)))
        .await?;
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
    let payload = {
        let mut dir = state.dir.lock().unwrap();
        let dir = dir.as_mut().ok_or("not unlocked")?;
        let recipients = dir.recipient_keys();
        dir.seal(&identity, &recipients, channel.as_bytes(), text.as_bytes())?
    };
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Publish {
        topic: format!("peers/v1/ch/{channel}"),
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
            if list.iter().any(|m| m.ts == msg.ts && m.from == msg.from) {
                continue;
            }
            list.push(msg);
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

/// Parks bytes (sealed envelope or media chunk) and announces them on the
/// DHT so other peers can fetch them while we're offline.
#[tauri::command]
async fn park_blob(state: State<'_, AppState>, data: Vec<u8>) -> Result<String, String> {    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
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
            init_identity,
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
                                                    m.card.clone().map(|c| (m.peer_id.clone(), c))
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
                                    let _ = publish_list(&state, &pn.server_id).await;
                                }
                            }
                        }
                        return;
                    }
                    // Signed channel messages: `peers/v1/ch/{server}/{channel}`.
                    if let Some((server_id, _channel)) = topic
                        .strip_prefix("peers/v1/ch/")
                        .and_then(|rest| rest.split_once('/'))
                    {
                        if let Ok(msg) = serde_json::from_slice::<SignedMessage>(&data) {
                            let state = app_handle.state::<AppState>();
                            let ok = {
                                let servers = state.servers.lock().unwrap();
                                match servers.get(server_id) {
                                    Some(rec) => msg.verify(rec).is_ok(),
                                    None => false,
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
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Peers");
}
