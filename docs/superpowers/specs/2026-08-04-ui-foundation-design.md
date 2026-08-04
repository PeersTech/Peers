# Peers UI Foundation — Design

**Date:** 2026-08-04
**Status:** Approved for planning
**Scope:** Phase 1 of 4. Visual identity, frontend restructure, dialog system,
connectivity surface, three bug fixes, and one new backend command.

---

## Context

Peers is a serverless, E2E-encrypted Discord-style messenger (Tauri 2 + React 19
frontend, Rust + libp2p backend). The crypto core, servers/channels/roles,
gossipsub chat, DHT blob parking, presence, headless `--node` mode, signed
profiles and the Plaza are all shipped.

The UI has three problems that block further feature work:

1. **It is a Discord clone at the pixel level.** The palette is Discord's own hex
   values (`#5865f2` blurple, `#1e1f22`, `#2b2d31`, `#313338`) hardcoded in
   roughly 60 places across four files. There is no theme layer, so the app
   cannot be reskinned without a find-and-replace across the tree.
2. **`App.tsx` is 1089 lines.** It holds every screen, every modal, every event
   listener and every handler. Adding the remaining milestones (seed-phrase
   login, friend codes) means adding more screens to a file that is already
   past the point of being reliably editable.
3. **Core flows run on native browser dialogs.** `prompt()`, `confirm()` and
   `alert()` drive adding a DM, joining a server, creating a server, adding a
   channel, adding a member, renaming, key rotation, kicking, leaving, and
   snapshot import/export. In a Tauri webview these render as blocking OS
   dialogs that look broken and cannot be styled or tested.

Three concrete bugs are also in scope, found while reading the code:

- `App.tsx:1020` — the pending-avatar preview renders
  `src={bytesToBase64(avatarBytes)}` with no `data:image/png;base64,` prefix, so
  the image is dead after picking a file. Every other avatar path goes through
  `blobUrl()`, which adds the prefix.
- `MessagePane.tsx:237` — `setPrevLen` is called during render, which triggers a
  second render pass on every message received.
- `MessagePane.tsx:317` — `useEffectScroll` uses `useMemo` to perform a scroll
  side effect. Wrong hook; it runs during render with an empty dep array and
  does not do what its name implies.

## Goals

- A distinct visual identity ("Ember"), defined once as theme tokens.
- Discord's **layout and interaction model preserved exactly** — this is a
  deliberate constraint, not an accident. Only the skin changes.
- `App.tsx` reduced to a phase switch; state moved into focused hooks.
- Native dialogs replaced with in-app, promise-based dialogs.
- Real connectivity state visible to the user.
- The three bugs fixed.
- A frontend test runner covering pure logic.

## Non-goals

Explicitly excluded to keep this phase shippable:

- No state-management library, no router, no component library.
- No animation or transition work beyond what Tailwind gives for free.
- No theme switcher and no light mode — one theme, tokenized so a second is
  cheap later.
- No layout changes. Panes, widths, spacing and hit targets stay as they are.
- No work on M16 (seed-phrase login), M17 (friend codes), M12 (capacity caps) or
  M13 (deploy docs). Each gets its own spec.

---

## Visual identity: Ember

Warm-dominant dark theme. Soot-brown surfaces, ember-orange accent, sage green
for online/success. Sans-serif UI type; monospace reserved for peer IDs, hashes
and multiaddrs — the places where character-level precision matters.

| Token | Value | Use |
|---|---|---|
| `--color-surface-0` | `#100e0a` | Icon rail, deepest wells |
| `--color-surface-1` | `#17150f` | Message pane background |
| `--color-surface-2` | `#1c1912` | Channel sidebar, member list |
| `--color-surface-3` | `#241f16` | Composer, raised cards, hover |
| `--color-border` | `#221e16` | Hairline rules, dividers |
| `--color-accent` | `#e8863c` | Active state, own messages, primary buttons |
| `--color-accent-hover` | `#f09a55` | Hover on accent |
| `--color-online` | `#7bb08a` | Presence dots, success toasts |
| `--color-danger` | `#d9614f` | Errors, destructive actions, unread badges |
| `--color-warn` | `#e0b04a` | Mention highlights, degraded connectivity |
| `--color-text` | `#f0e6d2` | Primary text (parchment) |
| `--color-muted` | `#8f8574` | Secondary text, inactive channels |
| `--color-faint` | `#6b6354` | Timestamps, placeholders, `#` glyphs |

Radii follow Discord: `4px` channel rows, `6px` composer and inputs, `9px` rail
icons (morphing toward `12px` on hover as today), `50%` avatars.

Implemented as a Tailwind 4 `@theme` block in `frontend/src/style.css`. Tailwind
4 generates utilities from theme tokens, so `--color-surface-2` yields
`bg-surface-2`, `text-surface-2`, `border-surface-2` automatically.

**Acceptance:** `grep -rE '#(5865f2|1e1f22|2b2d31|313338|383a40|949ba4|b5bac1|f2f3f5|80848e|35373c|404249|23a55a|f23f43|eb459e|f0b232)' frontend/src` returns nothing.

The one intentional exception is `colorFor()`'s per-peer identity palette, which
derives a stable color from a peer ID. It gets retuned to warm hues that sit on
the Ember surfaces, and remains an explicit array in `lib/api.ts`.

---

## Frontend architecture

### Target structure

```
frontend/src/
  style.css                 @theme tokens + base layer
  App.tsx                   ~100 lines: phase switch, DialogHost, ToastHost
  main.tsx                  unchanged
  lib/
    api.ts                  Tauri bindings — unchanged except colorFor() hues
                            and a new netStatus() binding
  hooks/
    useIdentity.ts           boot → onboarding | locked → ready; unlock, lock
    useServers.ts            server list, per-channel history, unread
    useDms.ts                dm list, dm history, unread
    usePlaza.ts              plaza posts, presence roster
    useProfiles.ts           own + contact profiles, avatar blob cache
    useConnectivity.ts       peer set, net_status polling
    useEvents.ts             single place wiring every onX() listener
    useDialog.ts             promise-based confirm/prompt
  screens/
    AuthScreen.tsx           onboarding + locked
    ChatScreen.tsx           three-pane composition
  components/
    ServerRail.tsx           restyled
    ChannelList.tsx          restyled, member list extracted out
    MemberList.tsx           new — extracted from ChannelList
    MessagePane.tsx          restyled, bugs fixed
    SettingsModal.tsx        extracted from App.tsx
    ConnectionBadge.tsx      new
    Modal.tsx                new — shared shell (backdrop, esc, focus trap)
    DialogHost.tsx           new — renders queued confirm/prompt dialogs
    ToastHost.tsx            extracted from App.tsx
```

### Hook boundaries

Each hook owns one slice of state and exposes a narrow interface. None of them
call each other; cross-slice coordination happens in `ChatScreen`, which is the
only place that knows about more than one slice.

- `useIdentity()` → `{ phase, me, unlock, initAndUnlock, lock }`. Owns the
  `'boot' | 'onboarding' | 'locked' | 'ready'` machine. On `lock()` it clears
  its own state and signals phase change; other hooks reset via their own
  effect on `phase`.
- `useServers()` → `{ servers, refresh, history, unread, loadHistory, markRead, … }`
- `useDms()` → `{ dms, addDm, history, unread, loadHistory, markRead, … }`
- `usePlaza()` → `{ posts, who, publish, reload }`
- `useProfiles()` → `{ myProfile, profiles, avatarFor, save, reload }`. Owns the
  blob cache and the `ensureBlob` dedupe set.
- `useConnectivity()` → `{ online, status }` where `status` is the `net_status`
  payload.
- `useEvents(handlers)` — subscribes every Tauri event once, dispatching to
  callbacks. Today listener registration is spread across `App.tsx` and is the
  main source of its length.

**Why hooks and not context:** the state is consumed by one subtree
(`ChatScreen`) and prop-drilling depth is two at most. Context would add
indirection without removing any.

### The `live`/`activeRef` pattern

`App.tsx` currently keeps `live` and `activeRef` mirrors so event callbacks can
read current state without re-subscribing. This is load-bearing — event handlers
registered once must see fresh state — and is preserved. Each hook keeps its own
ref mirror internally rather than one shared mirror at the top.

---

## Dialog system

`useDialog()` returns:

```ts
confirm(opts: { title: string; body?: string; confirmLabel?: string;
                destructive?: boolean }): Promise<boolean>
prompt(opts: { title: string; body?: string; placeholder?: string;
               initial?: string; multiline?: boolean;
               validate?: (v: string) => string | null }): Promise<string | null>
```

A module-level queue holds pending requests; `<DialogHost/>` at the App root
renders the head of the queue and resolves its promise on confirm/cancel. Call
sites change minimally — `if (!confirm('Leave this server?')) return;` becomes
`if (!(await confirm({title: 'Leave this server?'}))) return;`.

Dialogs close on Escape, on backdrop click (cancel), and Enter submits.
`Modal.tsx` provides the shared backdrop, focus trap and Escape handling, and is
reused by `SettingsModal`.

### Call sites to convert

| Location | Current | Becomes |
|---|---|---|
| `addDm` | `prompt` peer ID | `prompt` with peer-ID validation |
| `join` | `prompt` invite JSON | `prompt` multiline |
| `createSrv` | `prompt` name | `prompt` |
| `addChannel` | `prompt` name | `prompt` |
| `addMemberUi` | `prompt` peer ID | `prompt` with validation |
| `renameSrv` | `prompt` name | `prompt` with `initial` |
| `rotateKeyUi` | `confirm` | `confirm` destructive |
| `kickMember` | `confirm` | `confirm` destructive |
| `leave` | `confirm` | `confirm` destructive |
| `importSnapshotUi` | `prompt` JSON | `prompt` multiline |
| `exportSnapshotUi` | `window.prompt` clipboard fallback | copyable text dialog |

`prompt`'s `validate` hook lets peer-ID fields reject malformed input inline
instead of failing in the backend and surfacing as a red toast.

---

## Connectivity

### Backend: `net_status` command

The swarm already tracks everything needed but exposes none of it. `AppState`
holds our listen addrs (learned from node `Listening` events, `lib.rs:67`) and
`online_peers` exists (`lib.rs:719`), but relay reservation state and
reachability are not surfaced.

```rust
#[derive(Serialize)]
struct NetStatus {
    peers: usize,             // connected peers
    listen_addrs: Vec<String>,
    external_addrs: Vec<String>,   // confirmed-observed addrs
    relay_reservations: usize,     // active reservations we hold
    serving_relay: bool,          // true in --node mode
    reachability: &'static str,   // "direct" | "relayed" | "unknown"
}

#[tauri::command]
fn net_status(state: State<'_, AppState>) -> Result<NetStatus, String>
```

`reachability` is derived, not measured: `"direct"` when we have at least one
confirmed external address, `"relayed"` when we hold ≥1 relay reservation but no
external address, `"unknown"` otherwise. This is a heuristic and the UI labels
it as such — it must not claim more confidence than libp2p gives us.

Requires tracking relay reservation count in the swarm loop. `relay::client::Event`
already flows into `Event::RelayClient` (`behaviour.rs:47`); the loop increments
on `ReservationReqAccepted` and decrements on connection close for that relay.

### Frontend: `ConnectionBadge`

Sits in the user panel bottom-left of the channel sidebar, under the display
name — where Discord puts its own connection state. Shows a colored dot plus
peer count; click opens a popover with listen addresses, external addresses,
reachability and relay state, each copyable.

| State | Dot | Label |
|---|---|---|
| `peers > 0` and `reachability == "direct"` | `--color-online` | `N peers · direct` |
| `peers > 0` and `reachability == "relayed"` | `--color-warn` | `N peers · relayed` |
| `peers > 0`, unknown | `--color-warn` | `N peers` |
| `peers == 0` | `--color-danger` | `connecting…` |

`useConnectivity` polls `net_status()` every 5s while the window is focused, and
stops when unfocused — a headless node keeps running regardless, and polling a
hidden window wastes cycles on the low-end devices this project targets. Peer
count also updates instantly from the existing `presence://peer-connected` and
`peer-disconnected` events, so the badge is not 5s stale on connect.

---

## Bug fixes

1. **Avatar preview** — introduce `dataUrl(bytes: number[]): string` in `lib/api.ts`
   returning `data:image/png;base64,${bytesToBase64(bytes)}`, and route both
   `blobUrl()` and the settings preview through it. The duplicated prefix logic
   is what allowed the paths to diverge.
2. **`setPrevLen` during render** — replace with a `useEffect` on
   `messages.length` that scrolls when it grows, guarded by a
   "was near bottom" check so scrolling up to read history is not yanked back
   down by an incoming message.
3. **`useEffectScroll`** — delete; folded into the effect above.
4. **`hashColor` duplication** — `MessagePane.tsx:225` duplicates `colorFor()`
   from `lib/api.ts` with the same palette. Delete the local copy, import the
   shared one.

---

## Error handling

`ToastHost` replaces the inline toast JSX. Behavior changes in one way: errors
currently auto-dismiss after 6s (`App.tsx:81`), which loses failures the user
did not happen to be looking at. New rules:

- Success/info toasts auto-dismiss after 4s.
- Error toasts persist until dismissed.
- Toasts stack (up to 3 visible, older ones collapse to a "+N more" row).

Dialog `validate` failures render inline in the dialog and never become toasts —
a validation error belongs next to the field that caused it.

---

## Testing

Add **Vitest** (`vitest` + `@vitest/coverage-v8`, no DOM environment needed for
the chosen scope). Component-render tests are out of scope; the value here is in
the pure logic that the restructure moves around.

| Unit | Tests |
|---|---|
| `useDialog` queue | confirm resolves true/false; prompt resolves value/null; sequential requests queue rather than drop; escape cancels |
| unread accounting | increments on non-active channel, resets on `markRead`, aggregates per server |
| `parseMentions` | existing behavior pinned before the refactor moves it |
| `dataUrl` / `bytesToBase64` | round-trips, chunking boundary at `0x8000` |
| `reachability` label mapping | each `NetStatus` shape → expected dot + label |

Backend: `net_status` gets a unit test asserting the reachability derivation for
each input shape. `cargo test` runs in CI only — the dev machine (4 cores,
3.7 GB RAM) cannot link this tree without swapping.

`npm run build` (tsc + vite) must pass locally before commit; that is the fast
local gate.

---

## Verification

1. `npx tsc --noEmit` clean.
2. `npx vitest run` green.
3. `npm run build` succeeds.
4. The hex-literal grep above returns nothing.
5. CI green: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`,
   frontend build, Windows/macOS `cargo check`.
6. Manual: unlock → create server → add channel → invite → open Plaza → edit
   profile with an avatar (preview renders) → connection badge shows a peer
   count → every converted dialog opens in-app with no native popup.

## Risks

- **Restructure regressions.** Moving state out of one file risks dropping an
  event subscription or breaking a ref mirror. Mitigation: `useEvents` centralizes
  subscriptions so a missing one is visible in a single file; convert one hook at
  a time with a build between each.
- **`net_status` reachability is a heuristic.** It can report `direct` for a peer
  that is not actually dialable from a given network. The UI must not present it
  as a guarantee; the popover wording states it is a best guess.
- **Relay reservation tracking is new swarm-loop state.** Getting the decrement
  path wrong leaks a count that only grows. Mitigation: derive from the live
  connection set where possible rather than maintaining a counter.

## Follow-on phases

Each gets its own spec:

- **Phase 2 — M16 seed-phrase login.** Passphrase *is* the key: 8–11 diceware
  words → 32 bytes → Ed25519 + X25519. Clean break, no migration from the
  current password-sealed keystore (decided 2026-08-04).
- **Phase 3 — M17 friend codes.** Decided 2026-08-04: a **12-digit short code
  plus a QR**. The short code is a DHT rendezvous key published as a record
  signed by the identity and pointing at the full peer ID — it is *not* a
  truncated peer ID. Truncation was rejected: 14 digits is ~2^46.5, so grinding
  a keypair to collide with a target code costs a few GPU-hours, making a
  truncated ID forgeable. Because the code is only a lookup hint and the app
  verifies the full peer ID (showing name, avatar and fingerprint) before the
  user accepts, collisions and grinding are not a security boundary. QR carries
  the full peer ID for in-person adds. No usernames — global uniqueness would
  require central arbitration, which contradicts the project's premise.
- **Phase 4 — M12 capacity caps + M13 deployment docs.** Per-node relay and
  bandwidth caps, tiered relaying, VPS/Pi deployment guide, public node list.
