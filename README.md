<div align="center">

# Peers

**A serverless, peer-to-peer messenger with sealed direct messages.**

No accounts. No central message database. Direct messages and group messages travel
through libp2p without a project-operated message service.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## What is Peers?

Peers is a desktop messenger and libp2p node. It is designed around explicit
security boundaries rather than pretending that every transport topic is
private:

- **Direct messages and group messages are sealed end-to-end** between the
  intended peers.
- **DM and group attachments are encrypted** inside the message protocol. Files
  up to 8 MiB use independently sealed, retryable chunks.
- **Server channels, the Plaza, and relay-control messages** are authenticated
  broadcast/signed protocols. Relays and subscribed peers can observe their
  contents and routing metadata.
- **Channel attachments** are small raw DHT blobs, capped at 64 KiB, and are not
  E2E encrypted.
- Optional relay nodes help peers behind NAT connect; they are not a universal
  privacy boundary.

The GUI is only a shell around the local backend. Private keys, session
secrets, and message decryption stay in Rust.

```
┌────────────────────────────────────────────────────────────────────┐
│                            Peers (Tauri 2)                        │
│  ┌───────────────────────────┐  ┌──────────────────────────────┐  │
│  │  frontend/                │  │  backend/                   │  │
│  │  React 19 + TypeScript    │◄─┼─► Rust (libp2p swarm)        │  │
│  │  Vite + Tailwind 4        │  │  invoke() ── crypto ── p2p   │  │
│  └───────────────────────────┘  └──────────────────────────────┘  │
│            │                         │                            │
│            │       sealed DMs        │ signed/plaintext topics    │
│            ▼                         ▼                            │
│  ┌────────────────────────────────────────────────────────────────┐
│  │  Public IPFS testnet: gossipsub topics + Kademlia DHT          │
│  │  (live messaging)              (content-addressed blobs)      │
│  └────────────────────────────────────────────────────────────────┘
└────────────────────────────────────────────────────────────────────┘
```

## Features

### Messaging

- End-to-end encrypted direct messages
- Signed group descriptors, private invitations, and membership revisions
- Group delivery acknowledgements and encrypted read receipts
- Persistent offline outbox with retry and explicit retry controls
- Stable message IDs, delivery state, read state, and bounded local history
- Conversation search across message text and attachment names
- Persistent drafts, replies, reactions, edits, deletes, pins, and unpins
- Global Plaza with signed profiles and presence

### Files and media

- Encrypted DM attachments up to 8 MiB
- Encrypted group attachments up to 8 MiB
- 24 KiB transfer chunks with independent acknowledgements and deduplication
- Incomplete transfers resume from sealed local state
- Small server-channel attachments through the Kademlia DHT, up to 64 KiB
- Content-addressed blob parking for avatars and channel attachments

### Identity and network

- Ed25519 identities and X25519 key agreement
- BIP39 12/24-word recovery phrases
- Sealed local keystore and application state
- Friend codes and DHT peer rendezvous
- TCP, QUIC, Noise, relay transport, DCUtR, AutoNAT, and gossipsub
- Headless `--node` mode for always-on relay/routing machines
- Tiered relay capacity and bandwidth controls
- Signed profiles, avatars, and cross-machine recovery identity

### Servers and communities

- Server creation, invitations, roles, and channel ACLs
- Owner-signed member lists and rotating server keys
- Signed server history snapshots
- Group membership updates, invitations, leave flow, and private group topics

## Security model

| Data | Protection | Important boundary |
|---|---|---|
| Direct messages | ChaCha20-Poly1305 sealed envelopes | Relays can see routing metadata, not plaintext |
| Group messages | Multi-recipient sealed envelopes | Current group membership is the recipient set |
| DM/group attachments | Sealed message payloads and encrypted chunks | Relay nodes cannot decrypt attachment bytes |
| Server channels | Signed broadcast messages | Channel members/relays can observe protocol content |
| Plaza and relay control | Signed or plaintext broadcast/control | Not an E2E private channel |
| Channel attachments | Raw DHT blobs | DHT metadata and bytes are not E2E protected |
| Local state | Argon2id + XChaCha20-Poly1305 sealed store | Protect the OS account and recovery phrase |

The transport handshake protects the connection. It does not turn a signed or
plaintext application topic into an end-to-end encrypted channel. See the
[architecture and security documentation](https://github.com/PeersTech/docs/blob/main/content/docs/peers/architecture.mdx)
for the complete model.

## Cryptography

| Component | Choice |
|---|---|
| Identity | Ed25519 peer IDs + X25519 ECDH |
| Key agreement | X25519 ECDH + HKDF session root |
| Session keys | Directional HKDF hash-chain keys with replay protection |
| Message encryption | ChaCha20-Poly1305 AEAD with authenticated topic context |
| Keystore | Argon2id KDF + XChaCha20-Poly1305 at rest |
| Transport | libp2p Noise, TCP, QUIC, relay, and DCUtR |
| Blob addressing | SHA-256 content hashes via the Kademlia DHT |

Local crypto tests cover tamper detection, replay protection, out-of-order
delivery, wrong associated data, and third-party-open cases. Full Rust and
multi-network verification remains a release task; the frontend checks are
listed below.

## Getting started

### Prerequisites

- Node.js 20+
- npm
- A Rust toolchain
- Tauri 2 prerequisites: <https://tauri.app/start/prerequisites/>
  - Linux packages include WebKitGTK 4.1, GTK 3, librsvg, and patchelf
  - macOS and Windows require the normal Tauri native prerequisites

### Development

```sh
cd frontend
npm install
npm run tauri:dev
```

The frontend development server runs separately from the Tauri/Rust process;
`tauri:dev` starts both with hot reload.

### Production bundle

```sh
cd frontend
npm run tauri:build
```

Installers are written under `backend/target/release/bundle/`.

### Frontend checks

```sh
cd frontend
npm run typecheck
npm test
```

### Backend checks

Run these from `backend/` before publishing a release:

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets
```

## Node mode

A headless node runs without the desktop webview:

```sh
peers --node
```

Useful configuration:

| Variable | Purpose |
|---|---|
| `PEERS_NODES` | Comma-separated bootstrap/relay multiaddrs |
| `PEERS_NO_RELAY` | Set to `1` to disable relaying in a client |
| `PEERS_PORT` | Listen port for the node |
| `PEERS_ANNOUNCE` | Public address announced for NAT traversal |

There is no canonical public node list. Operators distribute their own
bootstrap and relay addresses; making one project-operated list mandatory would
reintroduce a central dependency.

For always-on deployments, see the separate
[Pterodactyl egg repository](https://github.com/PeersTech/ptero-egg) and the
[node deployment guide](https://github.com/PeersTech/docs/blob/main/content/docs/peers/running-a-node.mdx).

## Directory API

The Directory API is a signed node registry for discovering relay candidates.
It does not store, proxy, validate, or deliver messages, groups, or attachments.
Clients still perform identity verification and messaging locally over libp2p.

- Repository: <https://github.com/PeersTech/dir-api>
- API docs: <https://github.com/PeersTech/docs/tree/main/content/docs/dir-api>

## Repository layout

```text
Peers/
├── frontend/                  React UI (Vite + TypeScript + Tailwind)
│   ├── src/components/        Conversation and settings UI
│   ├── src/lib/               Tauri bindings and protocol types
│   └── package.json           Frontend and Tauri scripts
├── backend/                   Rust app (Tauri 2 + libp2p)
│   ├── src/crypto/            Identity, sessions, groups, cards, keystore
│   ├── src/p2p/               Swarm behaviour, blobs, relay, bootstrap
│   ├── src/store.rs           Sealed persistence and message history
│   └── src/lib.rs             Tauri commands and event relay
├── docs/                      Local architecture notes and plans
├── scripts/                   Icon generation
└── .github/workflows/         CI and cross-platform builds
```

## Roadmap

### Shipped

- [x] Desktop client, local identity, and sealed state
- [x] Direct messages, servers, channels, roles, and signed snapshots
- [x] Presence, profiles, Plaza, friend codes, and DHT blob parking
- [x] Group DMs, private invitations, membership revisions, and leave/update flows
- [x] Offline delivery, delivery acknowledgements, and read receipts
- [x] Encrypted resumable DM and group attachment chunks
- [x] Relay v2, DCUtR, headless nodes, bootstrap, and capacity caps
- [x] Seed-phrase recovery and deterministic identity

### Next

- [ ] Full Rust compile, test, clippy, and multi-network verification pass
- [ ] Multi-device state synchronization
- [ ] Directory client discovery integration
- [ ] Larger channel attachments with an explicit privacy model
- [ ] Calls and plugin interfaces

See [`PLAN.md`](PLAN.md) for implementation status and [`AGENTS.md`](AGENTS.md)
for repository conventions.

## License

MIT — see [`LICENSE`](LICENSE).
