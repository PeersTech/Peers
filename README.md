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
│                          Peers (TypeScript)                       │
│  ┌───────────────────────────┐  ┌──────────────────────────────┐  │
│  │  frontend/                │  │  packages/ + apps/           │  │
│  │  React 19 + TypeScript    │◄─┼─► @peers/host (engine)       │  │
│  │  Vite + Tailwind 4        │  │  @peers/core ── @peers/node   │  │
│  └───────────────────────────┘  │  (libp2p swarm)               │  │
│            │                    └──────────────────────────────┘  │
│            │         E2E ciphertext  sealed envelopes + blobs     │
│            ▼                                                      │
│  ┌────────────────────────────────────────────────────────────────┐
│  │  Public IPFS testnet: gossipsub topics + Kademlia DHT          │
│  │  (live chat)                 (torrent-style blob parking)      │
│  └────────────────────────────────────────────────────────────────┘
└────────────────────────────────────────────────────────────────────┘
```

The UI is a shell only — **private keys and decryption never leave the
host engine**, and the frontend never sees a secret. One TypeScript
engine (`@peers/core` domain + `@peers/node` network) powers three hosts:
the Electron desktop app, a localhost web server, and the headless
`peers --node` CLI.

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
| At-rest state | Sealed `state.json` — servers, keychains, DM sessions and full history survive restart |
| Presence | Live online/offline dots per member across the mesh |
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
│   ├── src/             components, screens, host bindings
│   └── package.json     npm scripts (dev / build / test)
├── packages/
│   ├── api/             @peers/api — the typed command/event seam
│   ├── core/            @peers/core — domain: identity, keystore, sessions,
│   │                    servers, profiles, codes, plaza (pure TS, tested)
│   ├── node/            @peers/node — createPeersNode(): libp2p assembly,
│   │                    DHT blobs, relay tiers, bootstrap config
│   └── host/            @peers/host — the engine implementing the seam
├── apps/
│   ├── desktop/         Electron shell (tray, close-to-tray, battery guard)
│   ├── web/             localhost HTTP + WS bridge serving the renderer
│   └── cli/             peers --node headless backbone node
├── scripts/             icon generator
└── .github/workflows/   CI, 3-OS bundles, releases
```

---

## Getting started

### Prerequisites

- [Node.js 22+](https://nodejs.org) with npm

### Run in development

```sh
# install everything (npm workspaces)
npm install

# typecheck + lint + test the whole monorepo
npm run typecheck && npm run lint && npm test

# build the renderer once for the desktop/web shells
cd frontend && npm install && npm run build && cd ..
```

### Hosts

```sh
# Desktop (Electron): builds main/preload then launches
npm run start --workspace apps/desktop

# Web: localhost HTTP + WebSocket bridge on :8787
npm run start --workspace apps/web

# Headless backbone node (relay tier, fixed port)
node apps/cli/src/main.ts        # or: peers --node after npm link
```

### Regenerate app icons

```sh
node scripts/gen-icons.mjs # draws the Peers logo (pure Node, zero deps)
```

---

## Continuous integration

| Workflow | When | What it does |
|---|---|---|
| `ci.yml` | every push/PR | frontend test+build; root `typecheck`, `lint`, full vitest suite; desktop bundle smoke on Windows/Linux/macOS |
| `release.yml` | tag `v*` | electron-builder matrix cutting installers for all three OSes onto a GitHub Release |

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
- [ ] **M7** — Packaging + open-source release (installers build in CI; release not cut yet)

### Node network (international chat — see [`PLAN.md`](PLAN.md))

- [x] **M8** — Friend codes: share/scan peer-ID code, DHT lookup, signed mutual-accept handshake
- [x] **M9** — Circuit Relay v2: NAT'd peers connect through always-on nodes
- [x] **M10** — DCUtR hole punching: upgrade relayed connections to direct P2P (cross-NAT verification pending)
- [x] **M11** — Headless node mode (`peers --node`): run an always-on routing/relay node (Pi/VPS)
- [x] **M12** — Node bootstrap + capacity caps: `PEERS_NODES`/`nodes.json`, tiered relay budgets (`PEERS_NO_RELAY=1` opts out)
- [x] **M13** — Deployment guide: [`docs/running-a-node.md`](docs/running-a-node.md)
- [x] **M14** — Custom profiles: signed display name, profile picture (DHT avatar), about me
- [x] **M16** — Seed-phrase login: BIP39 12/24-word phrase *is* the private key (HKDF → Ed25519 + X25519)

---

## License

TBD — open source.
