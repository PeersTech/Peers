import {ed25519} from '@noble/curves/ed25519.js';
import {peersErr} from './error.js';
import type {Identity} from './identity.js';
import {derivePeerId} from './peerid.js';
import {PeerCard} from './card.js';
import {b64decode, b64encode, canonicalJson, unixNow, utf8} from './util.js';

/**
 * Friend codes end-to-end (M8/M17): the mutual-accept handshake.
 *
 * Adding a friend is two signed notices over gossip:
 *
 *   1. Alice resolves Bob's 12-digit code on the DHT to his peer id,
 *      dials him, and publishes a signed *request* to
 *      `peers/v1/fr/<bob-peer-id>`.
 *   2. Bob — subscribed to that topic since startup — verifies it and
 *      answers with a signed *accept* back on `peers/v1/fr/<alice>`.
 *
 * Both notices carry the sender's verified identity card, so acceptance
 * doubles as the DM key exchange: after a full handshake both sides hold
 * each other's X25519 keys and can seal envelopes immediately.
 *
 * The code only ever *locates* a peer — 12 digits is grindable — so every
 * notice is bound to the recipient's full peer id and the sender must
 * prove possession of the Ed25519 key behind theirs.
 */

/** Gossip topic prefix for per-peer friend-request/accept traffic. */
export const FRIEND_REQUEST_TOPIC_PREFIX = 'peers/v1/fr/';

export function friendRequestTopic(peerId: string): string {
  return FRIEND_REQUEST_TOPIC_PREFIX + peerId;
}

/** What the notice says. */
export type FriendNoticeKind = 'request' | 'accept';

/**
 * A signed friend request or accept. `sig` covers every other field via
 * canonical JSON with this exact key order and `sig: ""` — same scheme as
 * SignedProfile and PlazaMessage.
 */
export interface FriendNotice {
  version: number;
  kind: FriendNoticeKind;
  /** Sender's peer id; must match the key embedded in `pubkey`. */
  from: string;
  /** Intended recipient's peer id — binds the notice so a captured one
   * can't be replayed against another peer. */
  to: string;
  pubkey: number[];
  ts: number;
  /** Sender's identity card: acceptance caches the X25519 key for DMs. */
  card: PeerCard;
  sig: string;
}

export const FriendNotice = {
  KIND_REQUEST: 'request' as const,
  KIND_ACCEPT: 'accept' as const,

  sign(identity: Identity, kind: FriendNoticeKind, to: string): FriendNotice {
    const n: FriendNotice = {
      version: 1,
      kind,
      from: identity.peerId,
      to,
      pubkey: identity.edPublicAsArray(),
      ts: unixNow(),
      card: PeerCard.sign(identity),
      sig: '',
    };
    n.sig = b64encode(identity.sign(canonicalJson(noticeSignView(n))));
    return n;
  },

  /**
   * Verifies authorship, that it is bound to its claimed sender, and that
   * any riding card belongs to them. Throws PeersError('SnapshotCorrupt')
   * on any mismatch — callers treat invalid as dropped, not fatal.
   */
  verify(msg: FriendNotice, expectedFrom?: string): void {
    let ok = false;
    try {
      ok =
        msg.pubkey.length === 32 &&
        ed25519.verify(b64decode(msg.sig), canonicalJson(noticeSignView(msg)), Uint8Array.from(msg.pubkey));
    } catch {
      ok = false;
    }
    if (!ok) throw peersErr('Crypto', 'friend notice signature invalid');
    if (derivePeerId(Uint8Array.from(msg.pubkey)) !== msg.from) {
      throw peersErr('Crypto', 'friend notice peer id mismatch');
    }
    // A code only locates a peer; the notice must be addressed to whoever
    // is actually being asked (or answering).
    if (expectedFrom !== undefined && msg.from !== expectedFrom) {
      throw peersErr('Crypto', 'friend notice from unexpected sender');
    }
    if (!PeerCard.verify(msg.card)) throw peersErr('Crypto', 'friend notice card invalid');
    if (!arrayEq(Array.from(msg.card.edPub), msg.pubkey)) {
      throw peersErr('Crypto', 'friend notice card does not belong to sender');
    }
  },
};

/**
 * Wire encoding for gossip: canonical JSON with every byte field as a
 * plain array (same shape the signature covers, plus the real sig). The
 * signature is computed over `noticeSignView`, not this string, so only
 * field round-tripping matters here — but keeping the shapes identical
 * makes one eyeball-check cover both.
 */
export function encodeFriendNotice(n: FriendNotice): Uint8Array {
  return utf8(
    JSON.stringify({
      version: n.version,
      kind: n.kind,
      from: n.from,
      to: n.to,
      pubkey: Array.from(n.pubkey),
      ts: n.ts,
      card: {
        edPub: Array.from(n.card.edPub),
        x25519Pub: Array.from(n.card.x25519Pub),
        sig: Array.from(n.card.sig),
      },
      sig: n.sig,
    }),
  );
}

/** Parses and rehydrates a notice from gossip bytes. Throws on malformed
 * input; cryptographic validity is `FriendNotice.verify`'s job. */
export function decodeFriendNotice(data: Uint8Array): FriendNotice {
  const raw = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) throw peersErr('Crypto', 'friend notice is not an object');
  const card = raw.card as Record<string, unknown> | undefined;
  const nums = (v: unknown, len: number): number[] =>
    Array.isArray(v) && v.length === len && v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 255)
      ? (v as number[])
      : [];
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const kind = raw.kind === 'request' || raw.kind === 'accept' ? raw.kind : undefined;
  if (kind === undefined) throw peersErr('Crypto', 'friend notice has unknown kind');
  return {
    version: typeof raw.version === 'number' ? raw.version : -1,
    kind,
    from: str(raw.from),
    to: str(raw.to),
    pubkey: nums(raw.pubkey, 32),
    ts: typeof raw.ts === 'number' ? raw.ts : -1,
    card: {
      edPub: Uint8Array.from(nums(card?.edPub, 32)),
      x25519Pub: Uint8Array.from(nums(card?.x25519Pub, 32)),
      sig: Uint8Array.from(nums(card?.sig, 64)),
    },
    sig: str(raw.sig),
  };
}

/** The object exactly as it was serialized for signing (`sig: ""`, card
 * fields as plain arrays so JSON bytes are stable). */
function noticeSignView(n: FriendNotice): Record<string, unknown> {
  return {
    version: n.version,
    kind: n.kind,
    from: n.from,
    to: n.to,
    pubkey: n.pubkey,
    ts: n.ts,
    card: {
      edPub: Array.from(n.card.edPub),
      x25519Pub: Array.from(n.card.x25519Pub),
      sig: Array.from(n.card.sig),
    },
    sig: '',
  };
}

function arrayEq(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
