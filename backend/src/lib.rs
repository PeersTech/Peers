mod crypto;
mod error;
mod p2p;

use crate::crypto::card::PeerCard;
use crate::crypto::server::{
    channel_topic, new_server_id, server_topic, ChannelConfig, Invite, JoinNotice, Member, Role,
    ServerDir, ServerRecord, ServerView, SignedList, SignedMessage,
};
use crate::crypto::{Identity, Keystore, SessionDir};
use crate::error::PeersError;
use crate::p2p::{NodeCommand, NodeEvent, NodeHandle};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

/// Shared app state. `node`/`identity`/`dir`/`servers` exist only after a
/// successful unlock; the keystore is always available.
pub struct AppState {
    keystore: Keystore,
    identity: Mutex<Option<Identity>>,
    node: Mutex<Option<NodeHandle>>,
    dir: Mutex<Option<SessionDir>>,
    servers: Mutex<ServerDir>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            keystore: Keystore::new(Keystore::default_path()),
            identity: Mutex::new(None),
            node: Mutex::new(None),
            dir: Mutex::new(None),
            servers: Mutex::new(ServerDir::new()),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityInfo {
    peer_id: String,
    peer_id_short: String,
    fingerprint: String,
}

fn info_for(id: &Identity) -> Result<IdentityInfo, PeersError> {
    Ok(IdentityInfo {
        peer_id: id.peer_id.to_string(),
        peer_id_short: id.peer_id_short(),
        fingerprint: id.fingerprint()?,
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
    let handle = p2p::spawn(id.clone())?;
    *state.identity.lock().unwrap() = Some(id.clone());
    *state.dir.lock().unwrap() = Some(SessionDir::new());
    *state.node.lock().unwrap() = Some(handle.clone());

    // Relay node events to the frontend.
    let mut rx = handle.subscribe();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let _ = app2.emit("node://event", &ev);
        }
    });

    // Listen + bootstrap against the public IPFS testnet.
    let _ = handle.send(NodeCommand::Listen).await;
    // Receive DMs addressed to us: our own peer id is our DM topic.
    let _ = handle
        .send(NodeCommand::Subscribe(format!("peers/v1/ch/{}", id.peer_id)))
        .await;
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let addrs = crate::p2p::bootstrap::resolve_public_bootstrap().await;
        let _ = handle.send(NodeCommand::Bootstrap(addrs)).await;
    });

    Ok(info_for(&id)?)
}

#[tauri::command]
fn lock(state: State<AppState>) -> Result<(), String> {
    *state.node.lock().unwrap() = None;
    *state.dir.lock().unwrap() = None;
    *state.servers.lock().unwrap() = ServerDir::new();
    *state.identity.lock().unwrap() = None;
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
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Subscribe(server_topic(&id))).await?;
    publish_list(&state, &id).await?;
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
    let servers = state.servers.lock().unwrap();
    let rec = servers.get(&server_id).ok_or(PeersError::ServerNotFound)?;
    let invite = rec.invite()?;
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
    node.send(NodeCommand::Subscribe(topic)).await?;
    let card = PeerCard::sign(&me)?;
    let notice = JoinNotice::new(
        &invite.payload.server_id,
        &me_str,
        &name,
        invite.payload.nonce,
        card,
    );
    let data = serde_json::to_vec(&notice).map_err(|e| e.to_string())?;
    node.send(NodeCommand::Publish {
        topic: server_topic(&invite.payload.server_id),
        data,
    })
    .await?;
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
    Ok(())
}

#[tauri::command]
async fn subscribe_channel(
    state: State<'_, AppState>,
    server_id: String,
    channel: String,
) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    node.send(NodeCommand::Subscribe(channel_topic(&server_id, &channel)))
        .await?;
    Ok(())
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
    Ok(())
}

#[tauri::command]
async fn subscribe(state: State<'_, AppState>, channel: String) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("not unlocked")?;
    let topic = format!("peers/v1/ch/{channel}");
    node.send(NodeCommand::Subscribe(topic)).await?;
    Ok(())
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
    Ok(())
}

/// Parks bytes (sealed envelope or media chunk) and announces them on the
/// DHT so other peers can fetch them while we're offline.
#[tauri::command]
async fn park_blob(state: State<'_, AppState>, data: Vec<u8>) -> Result<String, String> {
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
            subscribe_channel,
            unsubscribe_channel,
            publish_channel,
        ])
        .setup(|app| {
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
                            let view = {
                                let me = state.identity.lock().unwrap().clone();
                                let mut servers = state.servers.lock().unwrap();
                                match servers.get_mut(&server_id) {
                                    Some(rec) => match rec.verify_list(&list) {
                                        Ok(()) => {
                                            // Every member card rides the signed list,
                                            // so a fresh list unlocks DMs with everyone.
                                            let cards: Vec<(String, PeerCard)> = list
                                                .payload
                                                .members
                                                .iter()
                                                .filter_map(|m| {
                                                    m.card.clone().map(|c| (m.peer_id.clone(), c))
                                                })
                                                .collect();
                                            if let Some(mut dir) = state.dir.lock().unwrap().clone()
                                            {
                                                for (peer, card) in cards {
                                                    dir.remember_contact(&peer, &card);
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
                                }
                            };
                            if let Some(v) = view {
                                let _ = app_handle.emit("server://list", v);
                            }
                        } else if let Ok(notice) = serde_json::from_slice::<JoinNotice>(&data) {
                            let state = app_handle.state::<AppState>();
                            // Cache the joiner's card so anyone with the notice
                            // can DM them; only the owner acts on the request.
                            if let Some(mut dir) = state.dir.lock().unwrap().clone() {
                                dir.remember_contact(&notice.peer_id, &notice.card);
                            }
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
                    let (identity, mut dir) = {
                        let id = state.identity.lock().unwrap().clone();
                        let d = state.dir.lock().unwrap().clone();
                        (id, d)
                    };
                    let Some(identity) = identity else { return };
                    let Some(dir) = dir.as_mut() else { return };
                    match dir.open(&identity, topic.as_bytes(), &data) {
                        Ok(plaintext) => {
                            let text = String::from_utf8_lossy(&plaintext).to_string();
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
