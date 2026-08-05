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

/// True when a listen address is worth handing to another machine. Loopback
/// and unspecified (`0.0.0.0`) addresses are real listeners but useless in
/// someone else's config, and printing them as if they were shareable is what
/// sends operators chasing connections that can never work.
fn is_shareable(addr: &str) -> bool {
    !(addr.contains("/ip4/127.")
        || addr.contains("/ip6/::1")
        || addr.contains("/ip4/0.0.0.0"))
}

/// Runs the headless node forever. Callers should `block_on` this; it only
/// returns on unrecoverable setup errors.
pub async fn run_headless() -> Result<()> {
    let identity = load_or_create_identity()?;
    let peer = identity.peer_id.to_string();
    println!("peers node peer id: {peer}");
    println!("peers node identity: {}", identity_path().display());

    let handle = p2p::spawn(identity, true)?;

    // Surface operational events to stdout for the operator. Listen addresses
    // are printed with `/p2p/<peer-id>` already appended so they can be pasted
    // straight into a client's PEERS_NODES without hand-editing — getting that
    // suffix wrong is the usual reason a client silently fails to connect.
    let mut rx = handle.subscribe();
    let peer_for_log = peer.clone();
    tokio::spawn(async move {
        let peer = peer_for_log;
        while let Ok(ev) = rx.recv().await {
            match &ev {
                NodeEvent::Listening { addr } => {
                    if is_shareable(addr) {
                        println!("listening: {addr}/p2p/{peer}");
                        println!("  → PEERS_NODES={addr}/p2p/{peer}");
                    } else {
                        println!("listening (local only): {addr}/p2p/{peer}");
                    }
                }
                NodeEvent::PeerConnected { peer_id } => println!("peer connected: {peer_id}"),
                NodeEvent::PeerDisconnected { peer_id } => {
                    println!("peer disconnected: {peer_id}")
                }
                NodeEvent::RelayReservation { relay_peer, active } => {
                    let verb = if *active { "granted to" } else { "released by" };
                    println!("relay reservation {verb} {relay_peer}");
                }
                NodeEvent::ExternalAddr { addr, confirmed } if *confirmed => {
                    println!("external address confirmed: {addr}/p2p/{peer}");
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

    println!(
        "peers node is up. give clients one of the `PEERS_NODES=` lines above \
         (a public address, not a 127.x/0.0.0.0 one) — see docs/running-a-node.md."
    );

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_and_wildcard_are_not_shareable() {
        assert!(!is_shareable("/ip4/127.0.0.1/tcp/4001"));
        assert!(!is_shareable("/ip4/0.0.0.0/tcp/4001"));
        assert!(!is_shareable("/ip6/::1/tcp/4001"));
    }

    #[test]
    fn routable_addresses_are_shareable() {
        assert!(is_shareable("/ip4/203.0.113.7/tcp/4001"));
        assert!(is_shareable("/ip4/203.0.113.7/udp/4001/quic-v1"));
    }

    /// A LAN address is shareable in the sense that a peer on the same
    /// network can use it — the node cannot tell the difference, and saying
    /// otherwise would hide working same-network setups.
    #[test]
    fn lan_addresses_are_offered() {
        assert!(is_shareable("/ip4/192.168.1.20/tcp/4001"));
    }
}
