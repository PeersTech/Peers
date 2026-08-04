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
