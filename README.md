# Peers

Peer-to-peer Discord-style messenger. Fully end-to-end encrypted, no central server.

## Roadmap

- [x] **M1** — App scaffold, static 3-pane UI mock, core package layout
- [x] **M2** — Crypto core: Ed25519 identity, Argon2id keystore, X25519/HKDF sessions, ChaCha20-Poly1305, fingerprints + tests
- [ ] **M3** — Swarm layer: libp2p host, noise, Kademlia DHT, gossipsub, torrent-style blob parking, relay/AutoNAT, tray + background seeding
- [ ] **M4** — Servers: create/invite/join/kick, owner-signed member lists, rotating server keys, epochs
- [ ] **M5** — Channels + roles: ACLs, live bindings/events, UI wiring
- [ ] **M6** — Snapshots: owner-signed history export/import
- [ ] **M7** — Packaging (Windows/macOS/Linux) + open-source release docs

## Architecture

```
React + Tailwind (Discord-style UI)
        │  Tauri 2 invoke bindings (typed Rust commands) + events
Rust backend: crypto/ · p2p/ (libp2p swarm) · error.rs
        │
Public testnet DHT swarm (torrent-style: gossipsub live + blob parking for offline)
```

GUI is a shell only: private keys and decryption stay in Rust, the frontend never sees secrets.

## Development

Requires a Rust toolchain and [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install         # frontend deps
npm run tauri dev   # live development with hot reload
npm run tauri build # production build → src-tauri/target/release
```

## CI / Release

- `.github/workflows/ci.yml` — fmt, clippy, tests, frontend build on every push
- `.github/workflows/release.yml` — manual build of Windows/macOS/Linux installers via `tauri-action`

## License

TBD — open source.
