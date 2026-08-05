# Peers — Decentralized Node Network Plan

## Goal

Make Peers work internationally (cross-country, cross-NAT) using a network of
always-on **Peers nodes**, the way a cryptocurrency network is a mesh of
validator/relay nodes. No central server, no single point of failure — and it
must run comfortably on low-end hardware (Raspberry Pi, old laptops, cheap VPSs,
phones on a charger).

## Why

Peers is serverless P2P: every message is end-to-end encrypted and delivered
over libp2p. That works on a LAN and for publicly reachable hosts, but two users
behind closed NATs in different countries cannot initiate a direct connection.
Any "friend lives in another country" scenario needs reachable intermediaries.

BitTorrent and IPFS solve this without a central server — they use a distributed
network of always-on peers on public addresses (seeders, DHT nodes). Peers will
do the same: **every install is a node**, and a small set of dedicated nodes
forms the backbone.

## How it works (the torrent / crypto-node model)

- **Every Peers process is a node.** It routes gossip, seeds parked blobs on the
  Kademlia DHT, and relays connections for others. Close-to-tray already keeps
  the node alive in the background after the window closes.
- **Dedicated always-on nodes are the backbone.** A VPS, Raspberry Pi, old
  laptop, or phone on a charger runs the same binary in headless mode and stays
  reachable 24/7 with a public address.
- **NAT'd clients join through the backbone** using Circuit Relay v2, then
  upgrade to a direct P2P connection when possible via DCUtR hole punching — so
  the backbone is a switchboard, not a bandwidth bottleneck.
- **Friend codes use DHT peer routing** (`kademlia` `find_peer`): share a code,
  the DHT locates the peer, we dial. No accounts, no central registry.
- **Traffic spreads across many nodes** so no single low-end device is
  saturated; nodes cap concurrent relays and bandwidth and degrade gracefully.

## Honest constraints

- "No central server" does **not** mean "no other machines involved". Two
  closed-NAT laptops with zero reachable intermediaries cannot connect — that is
  a property of the internet, not of the app.
- Low-end devices relay within their capacity; they are light clients first and
  relays second (idle/charging only).

## What's already shipped (context)

- gossipsub live topics + Kademlia DHT blob parking (torrent-style seeding)
- Serverless identity (Ed25519 + X25519), sealed keystore, E2E envelopes
- Servers: create/invite/join, owner-signed member lists, rotating server keys
- Channels + roles (ACL), signed history snapshots, presence
- Tray + close-to-tray background seeding
- Deterministic connectivity: invites carry the owner's listen addresses and the
  joiner dials them directly (works on LAN / same-network today)

## Milestones

- [ ] **M8 — Friend codes.** Share/copy a peer-ID code; add friend by code →
      DHT `find_peer` → dial. Direct connection for reachable/LAN peers.
- [ ] **M9 — Circuit Relay v2.** Enable relay client transport; NAT'd peers
      connect through always-on nodes. Needed for international NAT traversal.
- [ ] **M10 — DCUtR hole punching.** After relay rendezvous, upgrade to a direct
      connection where NATs allow — the backbone stays a light switchboard.
- [ ] **M11 — Headless node mode (`--node`).** ~~Run the Rust backend alone as a
      routing/relay node with no GUI: tiny footprint, 24/7 on a Pi/VPS/old phone.~~
      **Done:** `peers --node` starts the backend with no webview — it listens, dials
      known nodes, bootstraps the DHT, and relays gossip for any topic clients ask
      it to. Identity is auto-generated and stored 0600 at `<config>/peers/node_identity.json`.
- [x] **M12 — Node bootstrap + capacity caps.** ~~Clients connect to a short list
      of known nodes on startup; per-node concurrent-relay and bandwidth caps;
      tiered relaying (clients relay only while idle/charging).~~
      **Done:** bootstrap via `PEERS_NODES` (comma-separated multiaddrs) or
      `<config>/peers/nodes.json`. Capacity is tiered by role — `citizen`
      (every GUI client: 8 reservations / 16 circuits / 16 MiB), `node`
      (`--node`: 64 / 64 / 128 MiB), and `off` (`PEERS_NO_RELAY=1`). Clients
      are *not* pinned to zero: an unreachable install advertising slots is
      harmless because nobody can dial it, so reachability decides who carries
      traffic — the way open-port peers carry a torrent swarm.

### Relay mesh (how the backbone relays your chat)

Clients publish a `{ "op": "subscribe", "topic": "<name>" }` notice on the shared
`peers/v1/relay` topic whenever they join a server/channel/DM topic. Headless nodes
(`--node`) listen on that topic and mesh anything they're asked to, so two NAT'd
clients who both dial the same VPS node exchange chat through it. The control
traffic is dropped by clients (only the node in relay mode acts on it).
- [x] **M13 — Deployment guide + public node list.** ~~How to stand up a node on a
      cheap VPS/Pi, and the canonical node list clients bootstrap to.~~
      **Done:** [`docs/running-a-node.md`](docs/running-a-node.md) — build,
      firewall, systemd unit, client config, verification and troubleshooting.
      No canonical public node list ships: publishing one would make those
      nodes a de facto central dependency, so operators distribute their own
      `PEERS_NODES` line instead.
- [~] **M14 — Custom profiles.** ~~Global display name, profile picture and "about
      me", all signed by the identity so they can't be impersonated. Profile
      rides alongside the peer card (member lists, join notices, DM envelopes);
      avatars are parked as DHT blobs and fetched by hash. Editable from a
      settings screen in the UI.~~
      **In progress:** `SignedProfile` (display name/about/avatar) rides member
      lists, join notices + profile notices; fun auto-names (JuicyPear); profile
      cached per contact.
- [ ] **M15 — The Plaza.** A global auto-joined channel every peer subscribes to
      (no invites, can't leave). Self-signed chat + profiles; "who's here" =
      verified profiles + connected peers. A community for discovery, not a
      directory.
- [x] **M16 — Seed-phrase login.** ~~The login passphrase IS the private key: 8–11
      diceware words (or the private key hex) → 32 bytes → Ed25519 + X25519 keys
      derived deterministically (wallet-style). Lost phrase = lost identity.~~
      **Done:** BIP39 12/24-word mnemonic with checksum; entropy → HKDF-SHA256
      with frozen domain separation (`peers/v1/seed`, `.../ed25519`,
      `.../x25519`) → Ed25519 + X25519. The keystore is now a *cache*: the same
      phrase rebuilds the same peer ID on any machine, so a lost install is
      recoverable and a lost phrase is not. Keystore v1 is refused outright
      (clean break — its random key can never be phrase-derived).
- [~] **M17 — Friend codes (peer-id sharing).** ~~Share your peer id as a short
      code / QR; add a friend by code → DHT `find_peer` → dial → mutual accept.
      No usernames, no registry.~~
      **In progress:** 12-digit code derivation shipped
      (`crypto::code::short_code`, displayed `4827 1193 6052`). The code is a
      DHT *rendezvous key*, deliberately not a truncated peer id — 12 digits is
      grindable in GPU-hours, so a matching code is never proof of identity.
      Resolution yields the full peer id, which the user verifies (name,
      avatar, fingerprint) before accepting. DHT publish/lookup, QR and the
      mutual-accept flow are still pending.

## Identity, Plaza & usernames — finalized design

Decided: **no usernames.** The peer id IS the handle. Fun auto-names (JuicyPear)
and avatars are cosmetic display only (signed, un-impersonable). Adding a friend
= share your peer-id code/QR out-of-band (like a phone number), then mutual
accept. At 100–400k users this works because you already know the person you're
adding — the Plaza handles *discovery* of new people, never *lookup* of a
specific friend. Passphrase-is-the-key login; best-effort nothing, because there
is nothing unique to enforce.

## Profile system design (M14)

- **`SignedProfile`** — `{ display_name, about, avatar_hash }` + an Ed25519
  signature over the serialized profile, bound to the identity's peer ID.
  Self-authenticating, like the peer card: any peer can verify who it's from.
- **Transport** — the profile rides wherever the peer card already travels
  (server member lists, join notices, DM envelopes), so contacts learn it with
  no extra round-trips.
- **Avatar** — a small image parked via the existing DHT blob system
  (`park_blob`/`fetch_blob`, torrent-style). The profile stores the blob hash;
  clients fetch + cache avatars lazily. Sizing is capped so low-end devices and
  the DHT aren't flooded.
- **UI** — settings screen to edit name/about/avatar; avatars + names surface in
  the DM list, member list, message headers and the profile of your own node.
  Per-server nicknames remain an override on top of the global name.

## Low-end device strategy

- Headless mode skips the webview entirely → ~10–20 MB RAM idle, minimal CPU.
- Capacity caps prevent a low-end node from being crushed; surplus traffic is
  handled by other nodes in the mesh.
- Tiered relaying: phones/laptops relay a little and only when idle/charging;
  dedicated nodes do the heavy lifting.

## Verification

- CI (fmt, clippy `-D warnings`, full test suite, 3-OS builds) gates every
  milestone; libp2p relay/DCUtR/find_peer are exercised by integration tests.
- Manual international test: two nodes on different networks (VPS + home) —
  friend-code connect, relayed message delivery, and hole-punch upgrade.
