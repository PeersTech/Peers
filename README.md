# Peers

Peer-to-peer Discord-style messenger. Fully end-to-end encrypted, no central server.

## Roadmap

- [x] **M1** — App scaffold (Wails + React + Tailwind), static 3-pane UI mock, core package layout
- [ ] **M2** — Crypto core: Ed25519 identity, Argon2id keystore, X25519/HKDF sessions, ChaCha20-Poly1305, fingerprints + tests
- [ ] **M3** — Swarm layer: libp2p host, noise, Kademlia DHT, gossipsub, torrent-style blob parking, relay/AutoNAT, tray + background seeding
- [ ] **M4** — Servers: create/invite/join/kick, owner-signed member lists, rotating server keys, epochs
- [ ] **M5** — Channels + roles: ACLs, live bindings/events, UI wiring
- [ ] **M6** — Snapshots: owner-signed history export/import
- [ ] **M7** — Packaging (Windows/macOS/Linux) + open-source release docs

## Architecture

```
React + Tailwind (Discord-style UI)
        │  Wails bindings (typed Go methods) + events
Go backend: crypto/ · p2p/ · server/ · store/ (SQLite)
        │
Public testnet DHT swarm (torrent-style: gossipsub live + blob parking for offline)
```

GUI is a shell only: private keys and decryption stay in Go, the frontend never sees secrets.

## Development

```sh
wails dev      # live development with hot reload
wails build    # production build → build/bin/Peers
```

## License

TBD — open source.
