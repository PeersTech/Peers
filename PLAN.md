# Peers — Decentralized Node Network Plan

## Critical hardening sprint — 2026-09-25

**Goal:** Make the existing Peers core safer and more reliable before adding new product surface.

**Approach:** Repair directional DM key derivation, fix the avatar hash race, add strict message/profile limits and deterministic message IDs where the current state model permits, and align the documented encryption model with the actual protocol.

**Files touched:** `backend/src/crypto/session.rs`, `backend/src/crypto/session.rs` tests, `backend/src/lib.rs`, `backend/src/store.rs`, avatar/profile path, relevant documentation, and frontend integration tests.

**Verification:** Rust unit tests, clippy, frontend typecheck/build/tests, and a review of every changed network-facing path.

## Product expansion roadmap — 2026-09-25

**Goal:** Add the full product surface in staged commits, starting with the Chat UX batch.

**Sequence:** Chat UX (search, replies, reactions, edit/delete, pins) → media and file sharing → group DMs and community controls → directory client integration → multi-device → calls and plugins.

**Testing policy:** Feature work lands before the full verification pass. Each stage still gets lightweight checks where they are cheap; heavy Rust/Docker/build verification is deferred to the dedicated test pass.

### Group DM protocol — next implementation slice

- Signed group descriptor with owner, group ID, member peer cards, and membership revision
- Private group invite delivered inside the existing sealed DM envelope
- Group topic derived from the group ID; no central group server
- Multi-recipient sealed messages using `SessionDir`
- Persisted group membership and message history
- Accept/decline/leave flows in the UI
- Reject removed members from newly issued group messages

**Status:** done — group protocol, membership revisions, and invitation flows are implemented.

### Delivery follow-up — current slice

- Persist read state on outgoing DM messages
- Apply delivered acknowledgements to stored DM/group history
- Keep frontend read indicators stable across history reloads
- Verify with frontend typecheck/tests; heavy Rust verification remains deferred

**Status:** done — read state now survives reloads and only explicit read receipts set it.

### Delivery controls — current slice

- Expose the pending outbox count in network status
- Add an explicit retry control to the message header
- Keep queued messages visible when the live publish attempt fails
- Enqueue only after recipient keys and local encryption succeed
- Verify with frontend typecheck/tests; heavy Rust verification remains deferred

**Status:** done — queued messages remain visible and can be retried explicitly.

### Chunked DM attachments — current slice

- Preserve the sealed single-envelope path for small attachments
- Split larger DM attachments into bounded encrypted chunks
- Persist incomplete incoming transfers across restart
- Acknowledge each chunk and deduplicate retransmissions
- Keep sender chunks in the existing outbox for retry
- Expose the larger attachment limit in the frontend

**Status:** done — large DM attachments now use encrypted, persisted, retryable chunks.

### Group read receipts — current slice

- Send encrypted read receipts to the current group membership
- Keep group delivery acknowledgements separate from read state
- Restore group read state from persisted history
- Show read indicators in group conversations

**Status:** done — group delivery acknowledgements and read receipts remain separate.

### Attachment transfer UX — current slice

- Show the active attachment name while upload work is in progress
- Prevent duplicate attachment selection during an active transfer
- Clear transfer status on success, validation failure, or backend failure
- Keep DM chunking and channel attachment flows behind the same UI state

**Status:** done — active attachment work is visible and duplicate selection is blocked.

### Persisted delivery state — current slice

- Persist delivered state separately from read state
- Restore delivery labels after conversation reloads
- Mark chunked attachments delivered only after every chunk is acknowledged
- Keep delivery acknowledgements separate from read receipts

**Status:** done — delivery labels now survive reloads and chunked transfers complete only after final acknowledgement.

### Conversation search refinement — current slice

- Include attachment names in conversation search
- Keep search case-insensitive across text and file metadata
- Preserve the existing result count and keyboard controls

**Status:** done — search now covers message text and attachment names.

### Group attachments — current slice

- Add small encrypted attachments to group DMs
- Carry the membership revision with the attachment payload
- Reuse group outbox retries and delivery acknowledgements
- Add group attachment upload UI with the existing DM limit
- Leave large group attachments for a later chunked protocol

**Status:** done — small group attachments are encrypted, revision-bound, retryable, and acknowledged.

### Chunked group attachments — current slice

- Extend the existing transfer state to identify group transfers
- Split large group attachments into independently sealed recipient envelopes
- Acknowledge each group chunk and mark the transfer delivered at completion
- Resume incomplete group transfers after restart
- Raise the frontend group attachment limit to 8 MiB

**Status:** done — group attachments now support encrypted 8 MiB chunked transfers.

### README refresh — current slice

- Replace stale attachment and roadmap claims
- Make the security boundaries explicit
- Document development, node, and deployment entry points
- Link the separate Directory API, Pterodactyl egg, and documentation repositories

**Status:** done — README now reflects the current protocol, setup, security boundaries, and roadmap.

### WebRTC calls — current slice

- Add encrypted call signaling over the existing DM session
- Add offer/answer/ICE events and call state to the backend
- Add local media capture and remote stream UI
- Keep media peer-to-peer; signaling never carries plaintext to relays

**Status:** done — WebRTC signaling is E2E sealed and the call UI supports media, mute, camera, and hangup.

### Plugin runtime — current slice

- Define a small manifest format
- Run explicitly enabled message-transform plugins in a Worker
- Reject filesystem, shell, credential, network, and DOM capabilities
- Keep signing/revocation as a separate release-hardening step

**Status:** done — the constrained message-transform runtime, Ed25519 signing, explicit key trust, and revocation are all implemented and reachable from Settings.

### Multi-device state synchronization — design

**The blocker that rules out the obvious design.** `Store::open` mints a random
per-device salt on first run and stores it inside the sealed state file. The
storage key is `Argon2id(password, salt)`. Two devices that share a recovery
phrase therefore derive *different* keys, and device B cannot decrypt device
A's `state.json`.

This is exactly why the existing manual transfer works as a **takeover**: the
importing device writes the exporting device's file wholesale, salt included,
so every later unlock reuses the exporter's salt. It is not a merge, and two
devices both editing after an import will silently diverge.

Making the salt deterministic from the identity would let devices share a
sealed file directly, but it changes the derived key for every existing
install. Existing users would find their state unreadable, so that is a
migration with no safe rollback and is not acceptable.

**Chosen design: sync deltas over the existing sealed DM transport.** Devices
keep their own salt and their own store. Each device periodically publishes an
encrypted delta addressed to a known device, using the DM sealing that already
works between any two peers and has been exercised since the start. No new key
distribution, no format change, no migration, and nothing new to trust.

**Merge rules**, chosen so that conflicts are impossible rather than resolved:

| Field | Rule | Why |
|---|---|---|
| Messages | union by message id | ids are UUIDs, so a duplicate is a duplicate |
| Contacts and friends | union | adding is monotonic |
| Group descriptors | higher `revision` wins | the wire format already carries a revision |
| Servers and roles | higher revision, else union of membership | |
| Delivery and read state | per-message union, existing state kept | never downgrade to "unread" |
| Profile | last received wins | no trusted clock; accept the staleness |
| Drafts | never synced | plaintext, already purged on lock |
| Outbox | never synced | it is bound to the local transport state |

**Work still required**, none of it started:

1. A `sync` payload kind alongside `DmTextPayload` in `lib.rs`.
2. Merge functions over `PersistedState` with the rules above, plus tests for
   each rule — a merge bug corrupts history, so this is the part to be careful
   with.
3. A periodic timer in the node, gated on being unlocked and on having at least
   one other device.
4. Device discovery: same recovery phrase means the same peer id, so devices
   need a way to learn each other's addresses before any of this works.
5. UI surface and a conflict-visible audit log.

Step 4 is the real dependency and is unsolved. Two devices from one phrase have
the same peer id, so they cannot find each other through the Directory, and a
peer cannot dial itself. libp2p reinforces this: `libp2p-swarm` returns
`DialError::LocalPeerId` when asked to dial its own id, so two instances of the
same identity cannot open a connection to each other at all. The DHT and
identify also map one peer id to one address, so two live endpoints would
overwrite each other's advertisement.

**Status: unblocked, not yet implemented.** A partial transport was written and
reverted earlier, when sync was believed to be gated on device rendezvous.

**That belief was wrong, and it is worth recording why.** It came from
generalising from *dialing*. Inbound connections are keyed by peer id, so a
contact dialing you reaches exactly one device. But message delivery does not
use that path: DMs are published to the gossipsub topic
`peers/v1/ch/<peerId>`, and each install subscribes to that topic for its own
peer id at unlock. Two installs of one account therefore derive the same topic
string, mesh into the same topic, and **both receive every message sent to
them**. Relay fan-out is per-subscriber, not per-dialed-peer.

So there is no rendezvous problem for delivery. The remaining work is ordinary
dedupe and suppression, not architecture:

- Duplicate read receipts and delivery acks: both devices auto-send them.
- Self-conversation: the same account messaging itself across two devices.
- Outbox double-send: queued entries retry from both installs.

**The keystone is now in place.** Sealing to the shared topic required a
recipient key for one's own peer id, and `remember_recipient_key` was only ever
called for group members. Unlock now registers the local X25519 key as a
recipient for the local peer id. Because both installs hold the same X25519 key
derived from the recovery phrase, the self-session is the one the other device
derives, so a device can publish a delta the other one opens.

Merge rules stay as written below: union by message id, union contacts, higher
revision wins for descriptors, never downgrade read state, drafts and outbox
never sync.

### Device model — the design to use if this is picked up

Model the "several endpoints per person" idea at the layer where it works:

| | Key | Shared across devices |
|---|---|---|
| libp2p peer id | one per install | no — routing must stay unambiguous |
| Application identity (Ed25519) | derived from the recovery phrase | yes — this is the person |
| Contact list row | keyed on application identity | one row per human, with a device list |
| DM session keys | derived from application identity | both devices can talk to the same contacts |

This keeps one person as one contact, gives every device a routable peer id so
devices can find and dial each other, and makes the state store keyed by
application identity so the takeover/divergence problem above disappears.

The open question is a product one: whether a contact should see one entry with
a device list, or a separate row per device. The first is recommended, but it
changes what "peer id" means throughout the app, so it is not a decision to
make inside an implementation pass.

Rebuild order if resumed: write the identity/contact keying tests first, then
the keying change, then merge, then the UI. A merge bug corrupts history and
must not be written without tests.

**Progress: the per-install device record is done.** Every install now has a
random local `device_id` and an editable label, persisted in the sealed state
and shown in Settings. The id is random rather than derived from the recovery
phrase, so installs cannot collide or be correlated from the id. The state
field is `serde(default)`, so existing installs load unchanged.

**The next step touches signed data and needs care.** To make devices visible
to contacts, the device id has to travel. The obvious place is
`SignedProfile`, and that is not a safe field to add casually.

`SignedProfile::sign` signs `serde_json::to_vec(&p)` — the whole struct. A
profile signed by an older client has no device field in those bytes. A newer
client that deserializes it and re-serializes will emit the field, producing
different bytes, and **every existing profile stops verifying**. The failure is
silent: no error, contacts simply cannot authenticate each other's names and
avatars any more.

The fix is `#[serde(default, skip_serializing_if = "String::is_empty")]` so an
absent or empty device id is omitted on re-serialization and reproduces the
original bytes exactly. That is the intended approach, but it must be proven
with a test that verifies a *legacy* profile (no device field) against a current
verifier before it is trusted. Do not add the field without that test.

An alternative that avoids signing entirely: carry the device id in the
presence or peer-card layer rather than the signed profile. Less tamper
evidence, but a device label cannot then be impersonated into someone's
profile, which is probably the better trade.

### Remaining roadmap

- Rust compile, test, clippy, and multi-network verification — deferred by user instruction
- Device rendezvous, then multi-device state synchronization
- TURN deployment and production call testing
- Plugin signing/revocation workflow — shipped; a publisher directory or key
  exchange would be the next step, and is a product decision
- `cargo fmt` run: `blobs.rs` and `p2p/mod.rs` already fail `fmt --check` at HEAD,
  so CI is red independently of the current work

**Status:** in progress

### Audit remediation — completed this pass

- Tauri `csp: null` replaced with a real policy; `assetProtocol` disabled
- Parked blobs written `0600` instead of world-readable under a default umask
- Disk blob cache bounded to 256 MiB, evicting least-recently-accessed files
- In-memory blob cache bounded to 32 MiB with LRU eviction
- Per-peer relay byte budget on a rolling window, with reconnect-proof accounting
- Directory registrations capped per source IP
- Drafts purged on lock and refused above 16 KiB
- Egg pinned to an immutable commit; `rustup-init` verified before execution

**Status:** done for the items above. Every Rust test added in this pass is
rustfmt-parse-verified only, because Cargo is off-limits; none has been compiled
or executed.

### Completion sequence

1. Photo previews and attachment UX
2. Directory discovery client integration
3. Chunked server-channel attachments
4. Multi-device encrypted state transfer
5. WebRTC call signaling, media UI, and call state
6. Capability-restricted plugin manifests and runtime
7. Documentation and release verification (without Cargo commands)

### Directory discovery integration — current slice

- Fetch fresh relay candidates from an optionally configured Directory API
- Validate and deduplicate returned multiaddrs in the backend
- Bootstrap the running node without replacing `PEERS_NODES`
- Keep discovery optional and fail silently when unconfigured

**Status:** done — configured clients now discover and bootstrap relay candidates after unlock.

### Chunked server-channel attachments — current slice

- Sign ordered DHT chunk manifests in channel messages
- Park 24 KiB chunks without changing the existing blob limit
- Reassemble verified chunks in the client
- Preserve the raw DHT/non-E2E channel privacy boundary

**Status:** done — channel attachments now support up to 8 MiB through signed DHT chunk manifests.

### Security audit remediation — current slice

- Remove unsolicited friend-accept key poisoning
- Reject private/loopback external addresses before adoption
- Bound relay topic ownership and retry sequence consumption
- Persist incoming history before acknowledging delivery
- Survive Tokio receiver lag without stopping event handling
- Verify blob hashes before storage and make hash parsing panic-free
- Reject removed group senders and prevent group key-map replacement
- Repair server signing-key rotation

**Status:** in progress

### Multi-device state transfer — current slice

- Export the already-sealed local state package without exposing plaintext
- Validate and atomically import a state package while locked
- Add explicit export/import controls to Settings
- Keep automatic background sync as a later protocol extension

**Status:** done — sealed state packages can be exported and imported while locked; automatic sync remains future work.



Make Peers work internationally (cross-country, cross-NAT) using a network of
always-on **Peers nodes**, the way a cryptocurrency network is a mesh of
validator/relay nodes. No central server, no single point of failure — and it
must run comfortably on low-end hardware (Raspberry Pi, old laptops, cheap VPSs,
phones on a charger).

## Why

Peers is serverless P2P: direct messages are end-to-end encrypted and delivered
over libp2p. Server, Plaza, and control messages are currently authenticated
broadcast protocol messages. This works on a LAN and for publicly reachable hosts, but two users
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

- [x] **M8 — Friend codes.** Share/copy a peer-ID code; add friend by code →
      DHT provider lookup → dial. Requests and acceptances carry verified
      identity cards, so direct DMs have the required X25519 key.
- [x] **M9 — Circuit Relay v2.** Enable relay client transport; NAT'd peers
      connect through always-on nodes. Needed for international NAT traversal.
      **Done:** the swarm has relay client/server behaviours, reservation events,
      relay-target backoff, and topic meshing through headless nodes.
- [x] **M10 — DCUtR hole punching.** After relay rendezvous, upgrade to a direct
      connection where NATs allow — the backbone stays a light switchboard.
      **Done:** DCUtR events are surfaced to the UI as direct/reachable results.
- [x] **M11 — Headless node mode (`--node`).** ~~Run the Rust backend alone as a
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
- [x] **M14 — Custom profiles.** ~~Global display name, profile picture and
      "about me", all signed by the identity so they can't be impersonated.
      Profile rides alongside the peer card (member lists, join notices, DM
      envelopes); avatars are parked as DHT blobs and fetched by hash. Editable
      from a settings screen in the UI.~~
      **Done:** `SignedProfile` travels in member lists, join/profile notices,
      and the Plaza; avatars are persisted, announced, fetched, and rendered
      in the UI.
- [x] **M15 — The Plaza.** A global auto-joined channel every peer subscribes to
      (no invites, can't leave). Self-signed chat + profiles; "who's here" =
      verified profiles + connected peers. A community for discovery, not a
      directory.
      **Done:** the app subscribes on unlock, announces a signed profile, keeps
      bounded history/presence, and renders the Plaza roster and conversation.
- [x] **M16 — Seed-phrase login.** ~~The login passphrase IS the private key: 8–11
      diceware words (or the private key hex) → 32 bytes → Ed25519 + X25519 keys
      derived deterministically (wallet-style). Lost phrase = lost identity.~~
      **Done:** BIP39 12/24-word mnemonic with checksum; entropy → HKDF-SHA256
      with frozen domain separation (`peers/v1/seed`, `.../ed25519`,
      `.../x25519`) → Ed25519 + X25519. The keystore is now a *cache*: the same
      phrase rebuilds the same peer ID on any machine, so a lost install is
      recoverable and a lost phrase is not. Keystore v1 is refused outright
      (clean break — its random key can never be phrase-derived).
- [x] **M17 — Friend codes (peer-id sharing).** ~~Share your peer id as a short
      code / QR; add a friend by code → DHT `find_peer` → dial → mutual accept.
      No usernames, no registry.~~
      **Done:** the 12-digit code is a DHT rendezvous key, not a truncated peer
      id. Resolution yields the full peer id, the UI requires explicit identity
      confirmation, and the signed request/acceptance carries a peer-bound card
      for DM key exchange.

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
  milestone. Current unit coverage includes directional DM keys, card/peer
  binding, list revisions, relay-topic limits, and persistent blob behavior;
  live relay/DCUtR testing still needs a multi-network integration harness.
- Manual international test: two nodes on different networks (VPS + home) —
  friend-code connect, relayed message delivery, and hole-punch upgrade.
