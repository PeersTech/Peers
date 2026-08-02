<div align="center">

# Peers

**A serverless, end-to-end encrypted Discord-style messenger.**

No accounts. No servers. No databases. Just you, your friends, and a peer-to-peer mesh network.

</div>

---

## What is Peers?

Peers is a desktop messenger where **every byte is encrypted end-to-end** and **every
message is delivered peer-to-peer** over a public libp2p network. There is no central
service to trust, no company that can read your conversations, and no server that can
be taken down or subpoenaed.

```
┌────────────────────────────────────────────────────────────────────┐
│                            Peers (Tauri 2)                        │
│  ┌───────────────────────────┐  ┌──────────────────────────────┐  │
│  │  frontend/                │  │  backend/                   │  │
│  │  React 19 + TypeScript    │◄─┼─► Rust (libp2p swarm)        │  │
│  │  Vite + Tailwind 4        │  │  invoke() ── crypto ── p2p   │  │
│  └───────────────────────────┘  └──────────────────────────────┘  │
│            │                         │                            │
│            │         E2E ciphertext  │ sealed envelopes + blobs   │
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
| End-to-end encryption | ChaCha20-Poly1305, per-session HKDF hash-chain keys, forward secrecy |
| Serverless | No backend, no accounts, no phone number, no database |
| P2P messaging | gossipsub live topics on the public libp2p network |
| Blob parking | Share large files torrent-style via the Kademlia DHT — the sender can go offline after uploading |
| Multi-recipient envelopes | One sealed message addressed to any number of peers, each with their own key |
| Local keystore | Argon2id + XChaCha20-Poly1305 sealed `identity.json`, permissions `0600` |
| NAT-friendly | TCP + QUIC transports, noise encryption, public bootstrap nodes |
| Cross-platform | Windows, macOS and Linux installers built by GitHub Actions |

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
- [ ] **M3** — Swarm: libp2p node, DHT blob parking, gossipsub chat, tray + background seeding
- [ ] **M4** — Servers: create/invite/join, owner-signed member lists, rotating server keys
- [ ] **M5** — Channels + roles: ACLs, live bindings, UI wiring
- [ ] **M6** — Snapshots: owner-signed history export/import
- [ ] **M7** — Packaging + open-source release

---

## License

TBD — open source.
