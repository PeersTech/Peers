use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::TokioAsyncResolver;
use libp2p::Multiaddr;
use std::time::Duration;

const BOOTSTRAP_DNSADDR_HOST: &str = "bootstrap.libp2p.io";

/// Known always-on Peers nodes dialed on startup so we can reach peers we
/// don't share a topic mesh with (e.g. the operator's VPS backbone).
///
/// Config order: the `PEERS_NODES` env var (comma-separated `/ip4/.../p2p/<id>`
/// multiaddrs) takes precedence; otherwise a `nodes.json` array in the config
/// dir (`<config>/peers/nodes.json`). See `--node` headless mode which prints
/// its address for you to paste here.
pub fn known_nodes() -> Vec<Multiaddr> {
    let mut out = Vec::new();
    if let Ok(v) = std::env::var("PEERS_NODES") {
        for part in v.split(',') {
            let part = part.trim().to_string();
            if !part.is_empty() {
                if let Ok(ma) = part.parse::<Multiaddr>() {
                    out.push(ma);
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    if let Some(base) = dirs::config_dir() {
        let path = base.join("peers").join("nodes.json");
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(addrs) = serde_json::from_str::<Vec<String>>(&s) {
                for a in addrs {
                    if let Ok(ma) = a.trim().parse::<Multiaddr>() {
                        out.push(ma);
                    }
                }
            }
        }
    }
    out
}

/// TCP/QUIC port to bind, from the `PEERS_PORT` env var.
///
/// `default` is what the caller wants when the var is absent or unparseable:
/// `--node` passes 4001 (the port `docs/running-a-node.md` tells operators to
/// open in the firewall), GUI clients pass 0 to keep an ephemeral port, since
/// nobody dials a client by address — they're reached over a relay circuit.
///
/// A node's port has to be stable across restarts: clients hold it in
/// `nodes.json`, and an OS-assigned port silently invalidates every one of
/// those configs on each restart even though the peer id is unchanged.
pub fn listen_port(default: u16) -> u16 {
    match std::env::var("PEERS_PORT") {
        Ok(v) => parse_port(&v, default),
        Err(_) => default,
    }
}

/// Split out from [`listen_port`] so it can be tested without mutating the
/// process-global environment, which races across parallel test threads.
fn parse_port(raw: &str, default: u16) -> u16 {
    raw.trim().parse::<u16>().unwrap_or(default)
}

/// Publicly reachable addresses declared by the operator via `PEERS_ANNOUNCE`
/// (comma-separated, e.g. `/ip4/203.0.113.7/tcp/4001`).
///
/// On a cloud VM the NIC only carries the *private* address — the public one
/// lives on the provider's NAT — so the swarm's own listen addresses are
/// useless to a remote client. libp2p can learn the real address from
/// identify's `observed_addr`, but only once an outside peer has connected,
/// which is exactly what an unadvertised node can't get. Declaring it breaks
/// that circle.
///
/// Entries carry no `/p2p/<id>` suffix; the node appends its own peer id when
/// printing them.
pub fn announce_addrs() -> Vec<Multiaddr> {
    match std::env::var("PEERS_ANNOUNCE") {
        Ok(v) => parse_announce(&v),
        Err(_) => Vec::new(),
    }
}

/// Split out from [`announce_addrs`] for the same reason as [`parse_port`].
fn parse_announce(raw: &str) -> Vec<Multiaddr> {
    raw.split(',')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                None
            } else {
                part.parse::<Multiaddr>().ok()
            }
        })
        .collect()
}

/// Resolves the well-known IPFS public libp2p bootstrap nodes via
/// `_dnsaddr.bootstrap.libp2p.io` TXT records (magnet-style discovery).
///
/// These public nodes act as the "public testnet" bootstrap for Peers:
/// they only help find peers and route queries — they never see
/// plaintext. Returns concrete `/ip4/.../tcp/.../p2p/<id>` addrs ready
/// to dial; empty on failure (the app still works over LAN/manual).
pub async fn resolve_public_bootstrap() -> Vec<Multiaddr> {
    let resolver = TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default());
    let fqdn = format!("_dnsaddr.{BOOTSTRAP_DNSADDR_HOST}");
    let lookup =
        match tokio::time::timeout(Duration::from_secs(10), resolver.txt_lookup(fqdn)).await {
            Ok(Ok(lookup)) => lookup,
            _ => return Vec::new(),
        };

    let mut out = Vec::new();
    for record in lookup.iter() {
        let line = record.to_string();
        // e.g. `dnsaddr=/dnsaddr/bootstrap.libp2p.io/p2p/Qm...`
        //      `dnsaddr=/ip4/104.131.131.82/tcp/4001/p2p/Qm...`
        let Some(addr) = line.strip_prefix("dnsaddr=") else {
            continue;
        };
        if let Ok(ma) = addr.parse::<Multiaddr>() {
            out.push(ma);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_override_wins_over_default() {
        assert_eq!(parse_port("4001", 0), 4001);
        assert_eq!(parse_port("  4001  ", 0), 4001);
    }

    /// Garbage must not silently drop the node onto an ephemeral port — that
    /// is the failure this whole setting exists to prevent, so it falls back
    /// to the caller's stable default instead.
    #[test]
    fn unparseable_port_falls_back_to_default() {
        assert_eq!(parse_port("", 4001), 4001);
        assert_eq!(parse_port("http", 4001), 4001);
        assert_eq!(parse_port("70000", 4001), 4001); // > u16::MAX
        assert_eq!(parse_port("-1", 4001), 4001);
    }

    #[test]
    fn announce_splits_on_commas_and_trims() {
        let addrs = parse_announce("/ip4/203.0.113.7/tcp/4001, /ip4/203.0.113.7/udp/4001/quic-v1");
        assert_eq!(addrs.len(), 2);
        assert_eq!(addrs[0].to_string(), "/ip4/203.0.113.7/tcp/4001");
        assert_eq!(addrs[1].to_string(), "/ip4/203.0.113.7/udp/4001/quic-v1");
    }

    #[test]
    fn announce_drops_invalid_and_empty_entries() {
        let addrs = parse_announce("not-a-multiaddr,,/ip4/203.0.113.7/tcp/4001,   ");
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].to_string(), "/ip4/203.0.113.7/tcp/4001");
        assert!(parse_announce("").is_empty());
    }

    #[tokio::test]
    #[ignore = "requires network access; run manually or in CI"]
    async fn resolves_concrete_addrs() {
        let addrs = resolve_public_bootstrap().await;
        assert!(!addrs.is_empty(), "expected bootstrap addrs");
        for a in &addrs {
            assert!(
                a.to_string().contains("/p2p/"),
                "bootstrap addr missing peer id: {a}"
            );
        }
    }
}
