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
- [ ] **M11 — Headless node mode (`--node`).** Run the Rust backend alone as a
      routing/relay node with no GUI: tiny footprint, 24/7 on a Pi/VPS/old phone.
- [ ] **M12 — Node bootstrap + capacity caps.** Clients connect to a short list
      of known nodes on startup; per-node concurrent-relay and bandwidth caps;
      tiered relaying (clients relay only while idle/charging).
- [ ] **M13 — Deployment guide + public node list.** How to stand up a node on a
      cheap VPS/Pi, and the canonical node list clients bootstrap to.

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
