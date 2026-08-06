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
///
/// `announced` is whether the operator declared a public address via
/// `PEERS_ANNOUNCE`. When they have, we're on a cloud VM whose NIC carries
/// only a private address, so RFC1918 listeners are noise next to the real
/// one — offering them is how an operator ends up pasting `192.168.x.y` into
/// a remote client. When they haven't, private addresses are kept: a
/// same-LAN setup is a real, working configuration and the node has no way to
/// tell the two situations apart on its own.
fn is_shareable(addr: &str, announced: bool) -> bool {
    if addr.contains("/ip4/127.") || addr.contains("/ip6/::1") || addr.contains("/ip4/0.0.0.0") {
        return false;
    }
    !(announced && is_private_v4(addr))
}

/// RFC1918 ranges: 10/8, 172.16/12, 192.168/16.
fn is_private_v4(addr: &str) -> bool {
    let Some(rest) = addr.strip_prefix("/ip4/") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("");
    let mut octets = host.split('.');
    let (Some(a), Some(b)) = (octets.next(), octets.next()) else {
        return false;
    };
    match (a.parse::<u8>(), b.parse::<u8>()) {
        (Ok(10), _) => true,
        (Ok(192), Ok(168)) => true,
        (Ok(172), Ok(b)) if (16..=31).contains(&b) => true,
        _ => false,
    }
}

/// Runs the headless node forever. Callers should `block_on` this; it only
/// returns on unrecoverable setup errors.
pub async fn run_headless() -> Result<()> {
    let identity = load_or_create_identity()?;
    let peer = identity.peer_id.to_string();
    println!("peers node peer id: {peer}");
    println!("peers node identity: {}", identity_path().display());

    let handle = p2p::spawn(identity, true)?;

    // Addresses the operator declared as publicly reachable. On a cloud VM the
    // swarm can only see the private NIC address, so without this the node has
    // nothing shareable to print.
    let announce = p2p::bootstrap::announce_addrs();
    let announced = !announce.is_empty();

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
                    if is_shareable(addr, announced) {
                        println!("listening: {addr}/p2p/{peer}");
                        // With a declared public address, that one is what
                        // clients need; don't offer a second candidate.
                        if !announced {
                            println!("  → PEERS_NODES={addr}/p2p/{peer}");
                        }
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
                // AutoNAT dial-back result. On a node this is the single most
                // useful line in the log: "private" means clients cannot reach
                // it however healthy the process looks, and that is otherwise
                // invisible until someone reports that chat does not work.
                NodeEvent::NatStatus { status } => match status.as_str() {
                    "public" => println!("reachability: public (peers dialed us successfully)"),
                    "private" => eprintln!(
                        "reachability: PRIVATE — peers tried to dial this node and could not \
                         reach it. Check the firewall and the provider's security group, and \
                         set PEERS_ANNOUNCE if this machine is behind NAT."
                    ),
                    _ => println!("reachability: unknown (not enough peers to probe with yet)"),
                },
                NodeEvent::Error { message } => eprintln!("node error: {message}"),
                _ => {}
            }
        }
    });

    // Act as a relay and mesh topics we're asked to, then listen. The port is
    // fixed (4001 unless PEERS_PORT says otherwise) because clients hold this
    // address in nodes.json — an OS-assigned port would change on every
    // restart and silently break every one of them.
    let port = p2p::bootstrap::listen_port(4001);
    handle.send(NodeCommand::Relay(true)).await?;
    handle.send(NodeCommand::Listen { port }).await?;

    if announced {
        handle.send(NodeCommand::Announce(announce.clone())).await?;
        for ma in &announce {
            println!("announcing: {ma}/p2p/{peer}");
            println!("  → PEERS_NODES={ma}/p2p/{peer}");
        }
    }

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

    if announced {
        println!(
            "peers node is up. give clients the `PEERS_NODES=` line above \
             — see docs/running-a-node.md."
        );
    } else {
        println!(
            "peers node is up. give clients one of the `PEERS_NODES=` lines above \
             (a public address, not a 127.x/0.0.0.0 one) — see docs/running-a-node.md."
        );
        println!(
            "note: if every line above is a private address (10.x/172.16-31.x/192.168.x), \
             this machine is behind NAT and cannot tell you its public address. Set \
             PEERS_ANNOUNCE=/ip4/<public-ip>/tcp/{port} and restart."
        );
    }

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_and_wildcard_are_not_shareable() {
        for announced in [false, true] {
            assert!(!is_shareable("/ip4/127.0.0.1/tcp/4001", announced));
            assert!(!is_shareable("/ip4/0.0.0.0/tcp/4001", announced));
            assert!(!is_shareable("/ip6/::1/tcp/4001", announced));
        }
    }

    #[test]
    fn routable_addresses_are_shareable() {
        for announced in [false, true] {
            assert!(is_shareable("/ip4/203.0.113.7/tcp/4001", announced));
            assert!(is_shareable("/ip4/203.0.113.7/udp/4001/quic-v1", announced));
        }
    }

    /// A LAN address is shareable in the sense that a peer on the same
    /// network can use it — the node cannot tell the difference, and saying
    /// otherwise would hide working same-network setups.
    #[test]
    fn lan_addresses_are_offered() {
        assert!(is_shareable("/ip4/192.168.1.20/tcp/4001", false));
    }

    /// ...but once the operator has declared a public address, the machine is
    /// known to be behind NAT and its private listeners are just decoys.
    #[test]
    fn lan_addresses_are_hidden_once_announced() {
        assert!(!is_shareable("/ip4/192.168.100.7/tcp/4001", true));
        assert!(!is_shareable("/ip4/10.0.0.5/tcp/4001", true));
        assert!(!is_shareable("/ip4/172.31.0.9/tcp/4001", true));
    }

    #[test]
    fn rfc1918_boundaries() {
        assert!(is_private_v4("/ip4/10.255.255.255/tcp/4001"));
        assert!(is_private_v4("/ip4/172.16.0.1/tcp/4001"));
        assert!(is_private_v4("/ip4/172.31.255.255/tcp/4001"));
        assert!(is_private_v4("/ip4/192.168.0.1/udp/4001/quic-v1"));
        // Just outside the 172.16/12 block on both sides.
        assert!(!is_private_v4("/ip4/172.15.0.1/tcp/4001"));
        assert!(!is_private_v4("/ip4/172.32.0.1/tcp/4001"));
        // 11.x and 193.168.x are public despite the near-miss prefixes.
        assert!(!is_private_v4("/ip4/11.0.0.1/tcp/4001"));
        assert!(!is_private_v4("/ip4/193.168.0.1/tcp/4001"));
        assert!(!is_private_v4("/ip6/::1/tcp/4001"));
    }
}
