# TypeScript Migration Plan

Status tracker for the Rust → TypeScript rewrite. The product roadmap
lives in [`PLAN.md`](PLAN.md); this file tracks the migration itself.

**Branch:** `typescript-migration` (from `main`)
**Decisions:** one TS core, three hosts (Electron desktop, localhost web
server, headless `--node` CLI) · clean break from the Rust wire format ·
full parity + remaining milestones (M8–M10, M14–M15, M17) · Node 22.

## Architecture

```
Peers/
├── packages/
│   ├── api/     @peers/api   typed command/event seam (42 commands, 15 events)
│   ├── core/    @peers/core  domain deep module: identity, keystore, store,
│   │                         E2E sessions, servers/channels, profiles, codes
│   └── node/    @peers/node  createPeersNode(): js-libp2p assembly — gossipsub,
│                            kad-DHT blobs, relay v2, DCUtR, AutoNAT, bootstrap
└── apps/
    ├── desktop/ Electron shell (tray/close-to-tray) + renderer (moved frontend/)
    ├── web/     Node HTTP+WS host serving the same renderer on localhost
    └── cli/     peers --node headless backbone node
```

The seam is `@peers/api`: the renderer keeps its existing call surface,
only the transport adapter changes (Tauri `invoke()` → Electron IPC or
WebSocket). Three adapters = a real seam.

## Done ✅

- **Monorepo scaffold**: npm workspaces, strict TS (`tsc -p` per package),
  vitest at root, eslint flat config.
- **@peers/api**: full command/event interface types, transport-agnostic.
- **@peers/core — complete domain port**, tests ported from the Rust suites:
  - BIP39 mnemonics (`@scure/bip39`) replace the custom wordlist scheme
    (clean break; phrase *is* the key, M16 semantics kept)
  - entropy → HKDF-SHA256 (frozen labels `peers/v1/seed{,/ed25519,/x25519}`)
    → Ed25519 + X25519 → peer id (libp2p-compatible `12D3KooW…` derivation)
  - 12-digit friend codes + DHT rendezvous keys (domain-separated)
  - hash-chain E2E sessions with replay window; multi-recipient sealed
    envelopes carrying verified identity cards
  - sealed keystore + state store (Argon2id → XChaCha20-Poly1305, 0600,
    v1 refusal, no plaintext on disk)
  - owner-signed member lists with rotating signing keys, invites,
    snapshots, channel ACLs, join/profile notices, plaza messages
- **@peers/node tracer bullet** — `createPeersNode()` factory (TCP+noise+
  yamux, identify, gossipsub) with deterministic identity; integration test
  dials two real loopback nodes and exchanges a gossip message. Peer-id
  derivation cross-checked against js-libp2p's own.
- **87/87 tests green · tsc clean · eslint clean**

### Stack pin (important)

gossipsub@14 still targets `@libp2p/interface@^2`, so libp2p v3 is
unusable for us yet. Aligned on the v2-era set: `libp2p@~2.10`,
`tcp@^10`, `identify@^3`, `noise@^16`, `yamux@^7`, `kad-dht@^15`,
`crypto@5.1.5` (root `overrides` forces one copy). Revisit when a
v3-compatible gossipsub ships.

## Next (in order)

1. ~~@peers/node tracer bullet~~ ✅
2. **DHT blobs** — kad provide/get + request-response transfer, 64 KiB cap;
   park/fetch round trip between two nodes in tests.
3. **Friend codes end-to-end (M8/M17)** — publish code key → DHT lookup →
   dial → mutual accept handshake.
4. **Servers over gossipsub (M14 finish)** — signed lists on server topics,
   join flow, profiles riding member lists; DM envelopes over DM topics.
5. **Relay mesh + capacity tiers (M9/M12)** — circuit-relay-v2 client+server,
   citizen/node/off tiers, `PEERS_NODES` / nodes.json bootstrap, battery/idle
   guard via injected `powerSource` port.
6. **DCUtR hole punching (M10)** — loopback handshake test; cross-NAT stays
   a manual verification gate.
7. **Plaza (M15)** — auto-join topic, self-signed chat/profiles, presence.
8. **Hosts** — `apps/cli` (`--node`, M11 parity incl. auto identity),
   `apps/web` (HTTP + WS bridge adapter of @peers/api), `apps/desktop`
   (Electron shell + move `frontend/` renderer; tray/close-to-tray via
   powerMonitor-backed `powerSource`).
9. **Cutover** — delete `backend/`, swap CI to typecheck/lint/test +
   electron-builder matrix (3 OS), update PLAN.md/README/docs.
10. **Manual verification gate** — VPS node + laptop behind different
    networks: code connect, relayed delivery, hole-punch upgrade.

## Notes / risks

- noble v2 API: `ed25519.utils.randomSecretKey()`, Uint8Array-only hkdf
  salt/info — already handled in core.
- QUIC (`@libp2p/quic`) is native-bound and younger than rust-libp2p's —
  TCP-first ordering; QUIC behind a flag.
- Uncommitted Rust WIP on `backend/src/p2p/mod.rs` (battery re-check)
  rides along uncommitted; decide before step 9 whether to commit it to
  `main` for reference.
