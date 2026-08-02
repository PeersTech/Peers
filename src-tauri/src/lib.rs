mod crypto;
mod error;
mod p2p;

use crate::crypto::{Identity, Keystore, SessionDir};
use crate::error::Result;
use crate::p2p::{NodeCommand, NodeEvent, NodeHandle};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

/// Shared app state. `node`/`identity`/`dir` exist only after a successful
/// unlock; the keystore is always available.
pub struct AppState {
    keystore: Keystore,
    identity: Mutex<Option<Identity>>,
    node: Mutex<Option<NodeHandle>>,
    dir: Mutex<Option<SessionDir>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            keystore: Keystore::new(Keystore::default_path()),
            identity: Mutex::new(None),
            node: Mutex::new(None),
            dir: Mutex::new(None),
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

fn info_for(id: &Identity) -> Result<IdentityInfo> {
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
async fn unlock(state: State<'_, AppState>, app: AppHandle, password: String) -> Result<IdentityInfo, String> {
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
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let _ = app2.emit("node://event", &ev);
                }
                Err(_) => break,
            }
        }
    });

    // Listen + bootstrap against the public IPFS testnet.
    let _ = handle.send(NodeCommand::Listen).await;
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
    *state.identity.lock().unwrap() = None;
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
async fn publish(
    state: State<'_, AppState>,
    channel: String,
    text: String,
) -> Result<(), String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or("not unlocked")?;
    let mut dir = state.dir.lock().unwrap();
    let dir = dir.as_mut().ok_or("not unlocked")?;
    let recipients = dir.recipient_keys();
    let payload = dir.seal(&identity, &recipients, channel.as_bytes(), text.as_bytes())?;
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
        ])
        .setup(|app| {
            // Decrypt incoming envelopes as they arrive and forward them as
            // frontend-friendly events.
            let app_handle = app.handle().clone();
            app.listen("node://event", move |event| {
                let state = app_handle.state::<AppState>();
                let payload: NodeEvent = match event.payload().map(serde_json::from_str) {
                    Some(Ok(ev)) => ev,
                    _ => return,
                };
                if let NodeEvent::Message { topic, from, data } = payload {
                    let (identity, mut dir) = {
                        let id = state.identity.lock().unwrap().clone();
                        let d = state.dir.lock().unwrap().clone();
                        (id, d)
                    };
                    let Some(identity) = identity else { return };
                    let Some(dir) = dir.as_mut() else { return };
                    match dir.open(&identity, topic.as_bytes(), &data) {
                        Ok(open) => {
                            let text = String::from_utf8_lossy(&open.plaintext).to_string();
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
