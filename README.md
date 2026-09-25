<div align="center">

# Peers

**A serverless, peer-to-peer messenger with encrypted direct messages.**

No accounts. No central message database. Direct messages are sealed end-to-end;
server channels, Plaza messages, and network control data are currently
authenticated/broadcast protocol messages and may be visible to relay operators.

</div>

---

## What is Peers?

Peers is a desktop messenger where **direct messages are encrypted end-to-end** and
message traffic travels over a public libp2p network. There is no central message
database, but relay operators and public network observers can still see routing
metadata and the plaintext parts of server, Plaza, and control protocols. See the
security model in the documentation for the exact boundaries.

```
┌────────────────────────────────────────────────────────────────────┐
│                            Peers (Tauri 2)                        │
│  ┌───────────────────────────┐  ┌──────────────────────────────┐  │
│  │  frontend/                │  │  backend/                   │  │
│  │  React 19 + TypeScript    │◄─┼─► Rust (libp2p swarm)        │  │
│  │  Vite + Tailwind 4        │  │  invoke() ── crypto ── p2p   │  │
│  └───────────────────────────┘  └──────────────────────────────┘  │
│            │                         │                            │
│            │         Sealed DMs      │ signed/plaintext topics    │
│            ▼                         ▼                            │
│  ┌────────────────────────────────────────────────────────────────┐
│  │  Public IPFS testnet: gossipsub topics + Kademlia DHT          │
│  │  (live chat)                 (torrent-style blob parking)      │
│  └────────────────────────────────────────────────────────────────┘
└────────────────────────────────────────────────────────────────────┘
```

The GUI is a shell only — **private keys and decryption never leave the Rust
backend**, and the frontend never sees a secret.

---

## Features

| | |
|---|---|
| End-to-end direct messages | ChaCha20-Poly1305, per-session HKDF hash-chain keys, forward secrecy |
| Serverless | No backend, no accounts, no phone number, no database |
| P2P messaging | gossipsub live topics on the public libp2p network |
| Blob parking | Share small blobs and media up to 64 KiB via the Kademlia DHT; attachment bytes are not E2E encrypted yet |
| Multi-recipient envelopes | One sealed message addressed to any number of peers, each with their own key |
| Local keystore | Argon2id + XChaCha20-Poly1305 sealed `identity.json`, permissions `0600` |
| At-rest state | Sealed `state.json` — servers, keychains, DM sessions and bounded message history survive restart |
| Presence | Live online/offline dots per member across the mesh |
| Signed message actions | Replies, reactions, edits, deletes, and pin/unpin are signed and replayable through the channel history |
| Signed snapshots | Owner-signed server history export/import (verify before merging) |
| Deterministic dialing | Invites carry the owner's listen addresses; joiners dial them directly |
| NAT-friendly | TCP + QUIC transports, noise encryption, public bootstrap nodes |
| Cross-platform | Windows, macOS and Linux installers built by GitHub Actions |

> Planning **international, cross-NAT chat** via a decentralized network of
> always-on Peers nodes (friend codes, Circuit Relay v2, hole punching, headless
> node mode) — see [`PLAN.md`](PLAN.md).

### Cryptography

| Component | Choice |
|---|---|
| Identity | Ed25519 (peer IDs) + X25519 (ECDH) |
| Key agreement | X25519 ECDH + HKDF → session root key |
| Session keys | `keyₙ = HKDF(SHA256ⁿ(root))` — a fresh key per message, with replay protection and out-of-order delivery within a 100k-message window |
| Message encryption | ChaCha20-Poly1305 AEAD with authenticated channel context |
| Keystore | Argon2id (KDF) → XChaCha20-Poly1305 (at-rest encryption) |
| Transport security | libp2p noise handshake (IK) + TLS-grade forward secrecy |

Every design decision is pinned by unit tests — tamper, replay, out-of-order,
wrong-AAD and third-party-open attacks are all covered.

---

## Repository layout

```
Peers/
├── frontend/            React UI (Vite + TypeScript + Tailwind)
│   ├── src/             components, screens, Tauri bindings
│   └── package.json     npm scripts incl. tauri:dev / tauri:build
├── backend/             Rust app (Tauri 2 + libp2p)
│   ├── src/
│   │   ├── crypto/      identity, keystore, sessions, cipher, peer cards
│   │   ├── p2p/         libp2p behaviour, blob store, DNS bootstrap
│   │   └── lib.rs       Tauri commands + event relay
│   ├── tauri.conf.json  app/bundle config
│   └── Cargo.toml
├── scripts/             icon generator
└── .github/workflows/   CI, 3-OS builds, releases
```

---

## Getting started

### Prerequisites

- [Node.js 20+](https://nodejs.org) with npm
- A Rust toolchain — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)
  (Linux: webkit2gtk 4.1, libgtk-3, librsvg, patchelf)

### Run in development

```sh
# 1. install frontend deps (includes the Tauri CLI)
cd frontend && npm install

# 2. start the app with hot reload (vite + cargo watch)
npm run tauri:dev
```

### Production build

```sh
npm run tauri:build        # bundles installers into backend/target/release/bundle
```

### Regenerate app icons

```sh
node scripts/gen-icons.mjs # draws the Peers logo (pure Node, zero deps)
```

---

## Continuous integration

| Workflow | When | What it does |
|---|---|---|
| `ci.yml` | every push/PR | `cargo fmt --check`, clippy `-D warnings`, full test suite, frontend build, Windows/macOS `cargo check` |
| `build.yml` | main + PRs | builds **Windows, Linux and macOS installers** and uploads them as artifacts |
| `release.yml` | tag `v*` | cross-platform release draft with installers, signed to a GitHub Release |

Trigger a manual build or release anytime from the **Actions** tab.

---

## Roadmap

- [x] **M1** — Scaffold: React UI shell + 3-pane layout
- [x] **M2** — Crypto core: identity, keystore, sessions, AEAD, fingerprints (tested)
- [x] **M3** — Swarm: libp2p node, DHT blob parking, gossipsub chat, tray + background seeding
- [x] **M4** — Servers: create/invite/join, owner-signed member lists, rotating server keys
- [x] **M5** — Channels + roles: ACLs, live bindings, UI wiring
- [x] **M6** — Snapshots: owner-signed history export/import
- [x] **M6.5** — Persistence, presence, deterministic invite dialing
- [~] **M7** — Packaging + open-source release (MIT and release workflow ready; no release tag published yet)

### Node network (international chat — see [`PLAN.md`](PLAN.md))

- [x] **M8** — Friend codes: share/scan peer-ID code, DHT lookup, direct dial, signed mutual key exchange
- [ ] **M9** — Circuit Relay v2: NAT'd peers connect through always-on nodes
- [ ] **M10** — DCUtR hole punching: upgrade relayed connections to direct P2P
- [x] **M11** — Headless node mode (`--node`): run the backend as an always-on routing/relay node (Pi/VPS)
- [x] **M12** — Node bootstrap + capacity caps: `PEERS_NODES`/`nodes.json`, tiered relay budgets (`PEERS_NO_RELAY=1` opts out)
- [x] **M13** — Deployment guide: [`docs/running-a-node.md`](docs/running-a-node.md)
- [x] **M14** — Custom profiles: signed display name, profile picture (DHT avatar), about me
- [x] **M16** — Seed-phrase login: BIP39 12/24-word phrase *is* the private key (HKDF → Ed25519 + X25519)

---

## License

MIT — see [`LICENSE`](LICENSE).
