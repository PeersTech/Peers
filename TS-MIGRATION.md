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

## Status

**Migration complete through step 9 (cutover).** The Rust backend is gone;
`packages/` + `apps/` are the product. Step 10 is the physical cross-NAT
verification gate — it needs a VPS and a laptop on different networks, so
it cannot run in CI.

Deferred follow-ups, resolved:
- **Sealed persistence + account lifecycle** — `PeersAccount`
  (`generate_phrase` / `initFromPhrase` / `unlock` / `lock`) wraps the
  engine; sessions, contacts, servers, histories and profile survive
  restarts via the Argon2id-sealed state store (tested incl. two-account
  DM round trip across lock/unlock).
- **Hosts ride the account** — web host starts locked when no keystore
  exists (renderer drives login over the socket); desktop shell routes IPC
  through the account with the battery-guarded power source.
- **Frontend transport swap** — `lib/api.ts` now speaks to
  `window.peers` (Electron) or a WebSocket (`/ws`, same-origin or
  `VITE_PEERS_WS`); Tauri deps removed from the renderer entirely.
- **Desktop smoke under Xvfb** — window + renderer boot clean headless
  (GPU/shutdown warnings only); real GUI verification rides step 10.
- **QUIC** — `@libp2p/quic` was never published to npm; js-libp2p has no
  QUIC transport at all, so there is nothing to put behind a flag. TCP is
  the wire; revisit if/when an official QUIC transport ships.

`133/133 root tests green (+22 frontend) · tsc clean · eslint clean`

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
- **@peers/node DHT blobs** — `BlobStore` + `BLOB_PROTOCOL` (`/peers/blob/1.0.0`)
  via `it-length-prefixed-stream` (varint framing, clean break from Rust's
  4-byte BE), 64 KiB cap, CID-wrapped SHA-256 provider keys, `kadDHT` in
  server mode with `passthroughMapper` (so loopback 127.0.0.1 survives the
  default `removePrivateAddressesMapper`), `ping` added for DHT deps, bounded
  `provide`/`findProviders` (1.5 s abort, dedup set, direct-connection
  fallback for cold routing tables), hash-verified fetch. `PeersNode` is the
  deep module: `parkBlob(data): hex` / `fetchBlob(hex): Uint8Array` hide
  CID math, provider iteration, stream framing, and verification — two methods
  buy the whole cycle (locality: cap/CID/corruption in one place). Tests:
  park/fetch round trip between two nodes, cap rejection, missing blob,
  dedup — plus gossip now waits 1.2 s for DHT mesh. `91/91 tests green`.
- **@peers/node friend codes end-to-end (M8/M17)** — signed `FriendNotice`
  request/accept in core (canonical-JSON sig covering kind/from/to/pubkey/ts
  + riding card; recipient-bound so captured notices can't be replayed at a
  third peer) with wire encode/decode. `PeersNode` grew four methods:
  `publishCode`/`lookupCode` reuse the blob provider machinery on the
  domain-separated code key (bounded 1.5 s, self-excluding), and
  `sendFriendRequest`/`acceptFriend` publish verified, addressed notices on
  per-peer `peers/v1/fr/<id>` topics — own topic subscribed for the node's
  lifetime, subscribe-before-publish mirrors Rust's relay-mesh dance,
  invalid/foreign notices drop silently via `onFriendNotice`. Tests: DHT
  code resolution between two loopback nodes, full mutual accept both
  directions with card exchange, foreign-addressed drop, malformed-code
  rejection. `101/101 tests green`.
- **@peers/host engine + servers over gossipsub (M14 finish)** — new
  `packages/host` (@peers/host): ONE implementation of the @peers/api
  command/event seam over core+node, so the three future hosts stay thin
  transports. Friend notices now carry signed profiles; verified
  requests/accepts cache cards + profiles. DMs seal multi-recipient
  envelopes to `peers/v1/ch/<peer>` topics (aad-bound, replay-windowed);
  servers do invite→JoinNotice (owner-side nonce authorization)→signed
  member list with cards/profiles riding, channel SignedMessages under ACL,
  profile notices folded into lists by the owner, snapshots, key rotation
  followed via chain head. Wire JSON hydrates typed arrays both ways
  (canonicalJson would mangle Uint8Array); join re-announces until the
  owner's list admits. Members track the verified chain head (`seenEpoch`)
  — core fix, unit-tested. Tests over real loopback swarms: handshake→
  sealed DMs both directions, display names on requests, full server flow
  incl. ACL rejection, spent-invite replay ignored.
- **Relay mesh + capacity tiers (M9/M12)** — `circuit-relay-v2` wired per
  tier: `node` = backbone hop (server, bounded reservations: 128 slots /
  2 h / 4 MiB), `citizen` = client-only, `off` strips the transport.
  `powerSource` port injected at start — a constrained source downgrades
  `node`→`citizen` (laptops never relay on battery; no platform deps in
  the package). `reserveOnRelay()` listens on `<relay>/p2p-circuit` for
  HOP reservations, counted in `net_status.relayReservations`. Bootstrap
  config ported from Rust (`PEERS_NODES` env → `nodes.json` fallback,
  `PEERS_PORT`, `PEERS_ANNOUNCE`, injectable env/dir). Test: a relay
  carries gossip between two citizens where one listens nowhere — real
  circuit traffic, plus tier/battery/parsing suites. `117/117 green`.
- **DCUtR hole punching (M10)** — `@libp2p/dcutr` service wired for every
  non-`off` tier; upgrades relayed connections automatically (inbound-side
  trigger, unilateral direct dial first, then synchronized handshake).
  Loopback test: two citizens meet ONLY through a circuit and end up with
  a non-limited direct connection. Cross-NAT stays a manual gate (step 10).
  `118/118 tests green`.
- **Plaza (M15)** — auto-joined `peers/v1/plaza` in the engine; self-signed
  chat (card riding) and profile announcements via core `PlazaMessage`,
  dedup by sig, 200-message history, 600 s presence window (`plaza_who`),
  `plaza://message` + `plaza://profile` events, `set_profile` announces to
  the Plaza (Rust `announce_plaza_profile` parity). Two-node test covers
  chat delivery, profile riding, presence and empty-message rejection.
  `119/119 tests green`.
- **Hosts** — all three adapters, one engine:
  - `apps/cli` — `peers --node` headless backbone (M11 parity): plaintext
    0600 auto-identity in the config dir, fixed port via `PEERS_PORT`
    (4001), `PEERS_NODES`/nodes.json dial + relay reservation, RFC1918/
    loopback shareability filter, pasteable `PEERS_NODES=` lines.
    js-libp2p hides wildcard listeners from advertisement — engine exposes
    `rawListenAddrs()` so operators get concrete per-interface addresses.
  - `apps/web` — Node HTTP + WS transport adapter: same renderer over a
    single socket (`{id,cmd,args}` → `{id,ok,ret|error}`, events pushed as
    frames). Static serving of `frontend/dist` with SPA fallback + status
    page. Tested with real WS clients incl. cross-host event fanout.
  - `apps/desktop` — Electron shell: tray + close-to-tray (hide keeps the
    node alive; OS shutdown quits for real), single-instance lock,
    `powerMonitor`-backed powerSource (battery+idle → citizen downgrade),
    contextBridge preload exposing exactly the @peers/api surface;
    esbuild-bundled main/preload. Runtime check needs a display — rides
    the step-10 manual gate.
  `126/126 tests green`.
- **126/126 tests green · tsc clean · eslint clean**

### Stack pin (important)

gossipsub@14 still targets `@libp2p/interface@^2`, so libp2p v3 is
unusable for us yet. Aligned on the v2-era set: `libp2p@~2.10`,
`tcp@^10`, `identify@^3`, `noise@^16`, `yamux@^7`, `kad-dht@^15`,
`crypto@5.1.5` (root `overrides` forces one copy). Revisit when a
v3-compatible gossipsub ships.

## Next (in order)

1. ~~@peers/node tracer bullet~~ ✅
2. ~~DHT blobs~~ ✅ — kad provide/get + request-response transfer, 64 KiB cap;
   park/fetch round trip between two nodes in tests.
3. ~~Friend codes end-to-end (M8/M17)~~ ✅ — publish code key → DHT lookup →
   signed request/accept handshake over per-peer gossip topics, cards riding
   both notices.
4. ~~Servers over gossipsub (M14 finish)~~ ✅ — @peers/host engine: signed
   lists on server topics, nonce-authorized join flow, profiles riding
   member lists, sealed DM envelopes over DM topics.
5. ~~Relay mesh + capacity tiers (M9/M12)~~ ✅ — circuit-relay-v2 client+
   server, citizen/node/off tiers, PEERS_NODES/nodes.json bootstrap,
   battery/idle guard via injected `powerSource` port.
6. ~~DCUtR hole punching (M10)~~ ✅ — loopback handshake test; cross-NAT
   stays a manual verification gate.
7. ~~Plaza (M15)~~ ✅ — auto-join topic, self-signed chat/profiles, presence.
8. ~~Hosts~~ ✅ — `apps/cli` (`--node`, M11 parity incl. auto identity),
   `apps/web` (HTTP + WS bridge adapter of @peers/api), `apps/desktop`
   (Electron shell + `frontend/` renderer; tray/close-to-tray via
   powerMonitor-backed `powerSource`).
9. ~~Cutover~~ ✅ — `backend/` deleted (Rust history preserved in git; the
   battery-guard WIP was committed pre-cutover in 085e949), CI swapped to
   frontend + root typecheck/lint/vitest + desktop bundle smoke on 3 OS,
   release.yml now cuts electron-builder installers for all three OSes,
   README/docs updated to the TS architecture.
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
