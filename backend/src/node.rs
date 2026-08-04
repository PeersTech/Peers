//! Headless `--node` mode: run the libp2p swarm as an always-on routing and
//! relay node with no GUI. This is what you deploy on a VPS to act as a
//! stable backbone for the rest of the network.

use crate::crypto::Identity;
use crate::error::Result;
use crate::p2p::{self, NodeCommand, NodeEvent};
use std::path::PathBuf;

fn identity_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("peers").join("node_identity.json")
}

/// Loads or creates the node's routing identity. A headless node has no
/// user secrets (it never decrypts anything), so the identity is stored
/// plaintext with 0600 perms, unlike the GUI keystore.
fn load_or_create_identity() -> Result<Identity> {
    let path = identity_path();
    if path.exists() {
        let bytes = std::fs::read(&path)?;
        return Identity::unmarshal(&bytes);
    }
    let id = Identity::new()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, id.marshal()?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(id)
}

/// Runs the headless node forever. Callers should `block_on` this; it only
/// returns on unrecoverable setup errors.
pub async fn run_headless() -> Result<()> {
    let identity = load_or_create_identity()?;
    println!("peers node peer id: {}", identity.peer_id);
    println!("peers node identity: {}", identity_path().display());

    let handle = p2p::spawn(identity, true)?;

    // Surface operational events to stdout for the operator.
    let mut rx = handle.subscribe();
    tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            match &ev {
                NodeEvent::Listening { addr } => println!("listening: {addr}"),
                NodeEvent::PeerConnected { peer_id } => println!("peer connected: {peer_id}"),
                NodeEvent::PeerDisconnected { peer_id } => {
                    println!("peer disconnected: {peer_id}")
                }
                NodeEvent::Error { message } => eprintln!("node error: {message}"),
                _ => {}
            }
        }
    });

    // Act as a relay and mesh topics we're asked to, then listen.
    handle.send(NodeCommand::Relay(true)).await?;
    handle.send(NodeCommand::Listen).await?;

    // Dial known peers (VPS backbone) from env/config and reserve relay slots
    // on them, so this node can be used as a rendezvous for hole-punching.
    for ma in p2p::bootstrap::known_nodes() {
        println!("dialing known node: {ma}");
        let _ = handle.send(NodeCommand::Dial(ma.clone())).await;
        let _ = handle.send(NodeCommand::ListenOnRelay(ma)).await;
    }

    // Bootstrap the DHT against the public IPFS testnet.
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let addrs = p2p::bootstrap::resolve_public_bootstrap().await;
        let _ = handle.send(NodeCommand::Bootstrap(addrs)).await;
    });

    println!("peers node is up. copy a `listening:` line into your clients' PEERS_NODES env (with /p2p/<peer-id> appended).");

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}
