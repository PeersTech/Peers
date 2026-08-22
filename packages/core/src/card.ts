import {ed25519} from '@noble/curves/ed25519.js';
import {sha256} from '@noble/hashes/sha2.js';
import {peersErr} from './error.js';
import type {Identity} from './identity.js';
import {derivePeerId} from './peerid.js';
import {Session, type SessionState} from './session.js';
import {open as openEnvelope, seal as sealEnvelope} from './cipher.js';
import {b64decode, b64encode, canonicalJson, concatBytes, utf8} from './util.js';

/** Domain separation string for the identity-card signature. */
const CARD_DOMAIN = 'peers/v1/card';
/** Wire format version of the sealed envelope. */
const ENVELOPE_VERSION = 0x01;
/** Cap on recipients per message (defends the header against bloat). */
const MAX_RECIPIENTS = 64;

/**
 * Self-authenticating identity card: the sender's Ed25519 public key, the
 * X25519 key used for ECDH, and an Ed25519 signature binding them. The
 * signature is over SHA-256("peers/v1/card" || x25519_pub), so anyone can
 * verify the card and cache (peer id -> x25519 key) for later sends.
 */
export interface PeerCard {
  edPub: Uint8Array;
  x25519Pub: Uint8Array;
  sig: Uint8Array;
}

function cardSignBytes(x25519Pub: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8(CARD_DOMAIN), x25519Pub));
}

export const PeerCard = {
  sign(identity: Identity): PeerCard {
    const x25519Pub = identity.xPublic();
    return {
      edPub: identity.edPublic(),
      x25519Pub,
      sig: identity.sign(cardSignBytes(x25519Pub)),
    };
  },

  /** Verifies the card's signature. The X25519 key is trusted after this. */
  verify(card: PeerCard): boolean {
    if (card.edPub.length !== 32 || card.x25519Pub.length !== 32) return false;
    try {
      return ed25519.verify(card.sig, cardSignBytes(card.x25519Pub), card.edPub);
    } catch {
      return false;
    }
  },

  /** The peer id implied by a verified card's embedded key. */
  peerIdOf(card: PeerCard): string {
    return derivePeerId(card.edPub);
  },
};

/**
 * Stable, playful auto-generated display name ("JuicyPear") seeded from
 * the peer id bytes, so every identity has a fun default without needing
 * to persist it.
 */
export function defaultDisplayName(peerIdBytes: Uint8Array): string {
  const ADJS = ['Juicy', 'Cosmic', 'Turbo', 'Silky', 'Crispy', 'Golden', 'Mellow', 'Fuzzy', 'Swift', 'Velvet', 'Spicy', 'Breezy'];
  const NOUNS = ['Pear', 'Comet', 'Duck', 'Ghost', 'Taco', 'Beetle', 'Cloud', 'Fox', 'Cactus', 'Orbit', 'Llama', 'Waffle'];
  const a = peerIdBytes[peerIdBytes.length - 1]! % ADJS.length;
  const n = peerIdBytes[0]! % NOUNS.length;
  return ADJS[a]! + NOUNS[n]!;
}

/**
 * Self-authenticating display profile: display name, "about" line and an
 * optional avatar blob hash, all signed by the identity so they can't be
 * impersonated. Rides alongside the peer card wherever contacts are
 * exchanged (member lists, join notices, profile notices).
 *
 * `sig` covers every other field via canonical JSON with this exact key
 * order and `sig: ""`.
 */
export interface SignedProfile {
  version: number;
  peerId: string;
  pubkey: number[];
  displayName: string;
  about: string;
  avatarHash: string | null;
  sig: string;
}

export const SignedProfile = {
  sign(identity: Identity, displayName: string, about: string, avatarHash: string | null): SignedProfile {
    const trimmed = displayName.trim();
    const p: SignedProfile = {
      version: 1,
      peerId: identity.peerId,
      pubkey: Array.from(identity.edPublic()),
      displayName: trimmed.length > 0 ? trimmed : defaultDisplayName(identity.peerIdBytes),
      about: about.trim(),
      avatarHash,
      sig: '',
    };
    p.sig = b64encode(identity.sign(canonicalJson(profileSignView(p))));
    return p;
  },

  /** Verifies the signature and that it is bound to `peerId`. */
  verify(p: SignedProfile): void {
    let ok = false;
    try {
      ok =
        p.pubkey.length === 32 &&
        ed25519.verify(b64decodeSig(p.sig), canonicalJson(profileSignView(p)), Uint8Array.from(p.pubkey));
    } catch {
      ok = false;
    }
    if (!ok) throw peersErr('Crypto', 'profile signature invalid');
    const derived = derivePeerId(Uint8Array.from(p.pubkey));
    if (derived !== p.peerId) throw peersErr('Crypto', 'profile peer id mismatch');
  },
};

/** The object exactly as it was serialized for signing (`sig: ""`). */
function profileSignView(p: SignedProfile): Record<string, unknown> {
  return {
    version: p.version,
    peerId: p.peerId,
    pubkey: p.pubkey,
    displayName: p.displayName,
    about: p.about,
    avatarHash: p.avatarHash,
    sig: '',
  };
}

function b64decodeSig(s: string): Uint8Array {
  return b64decode(s);
}

/**
 * Per-contact E2E state: one session per recipient X25519 key, plus the
 * identity cards validated so far. Sealed envelopes carry one copy of the
 * plaintext per recipient:
 *
 * ```text
 * [ver 1][ed_pub 32][x25519 32][sig 64][n u16 BE]
 *   n × [rcpt_x25519 32][ct_len u32 BE][seq 8][nonce-derived ct+tag]
 * ```
 *
 * `aad` binds each copy to its context (e.g. channel).
 */
export class SessionDir {
  private readonly sessions = new Map<string, Session>();
  private readonly contacts = new Map<string, Uint8Array>();

  constructor(private readonly identity: Identity) {}

  static restore(
    state: {sessions: [Uint8Array, SessionState][]; contacts: [string, Uint8Array][]},
    identity: Identity,
  ): SessionDir {
    const dir = new SessionDir(identity);
    for (const [key, s] of state.sessions) dir.sessions.set(toKey(key), Session.import(s));
    for (const [peer, key] of state.contacts) dir.contacts.set(peer, key.slice());
    return dir;
  }

  export(): {sessions: [Uint8Array, SessionState][]; contacts: [string, Uint8Array][]} {
    return {
      sessions: [...this.sessions].map(([k, s]) => [fromKey(k), s.export()]),
      contacts: [...this.contacts].map(([p, k]) => [p, k.slice()]),
    };
  }

  /** Remembers a validated card so future sends can encrypt to this peer. */
  rememberContact(peerId: string, card: PeerCard): void {
    this.contacts.set(peerId, card.x25519Pub.slice());
  }

  /** The X25519 key we can encrypt to for a peer id, if we hold their
   * validated card. `undefined` means keys were never exchanged. */
  recipientKey(peerId: string): Uint8Array | undefined {
    return this.contacts.get(peerId);
  }

  recipientKeys(): Uint8Array[] {
    return [...this.contacts.values()].map((k) => k.slice());
  }

  seal(recipients: Uint8Array[], aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (recipients.length === 0) {
      throw peersErr('Other', 'no recipients with validated identity cards yet');
    }
    if (recipients.length > MAX_RECIPIENTS) throw peersErr('MessageTooLarge');

    const card = PeerCard.sign(this.identity);
    const copies: Uint8Array[] = [];
    for (const rcpt of recipients) {
      const session = this.sessionFor(rcpt);
      const sealed = sealEnvelope(session, aad, plaintext);
      const head = new Uint8Array(36);
      head.set(rcpt, 0);
      new DataView(head.buffer).setUint32(32, sealed.length);
      copies.push(concatBytes(head, sealed));
    }

    const copiesLen = copies.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(1 + 32 + 32 + 64 + 2 + copiesLen);
    const view = new DataView(out.buffer);
    let off = 0;
    out[0] = ENVELOPE_VERSION;
    off += 1;
    out.set(card.edPub, off); off += 32;
    out.set(card.x25519Pub, off); off += 32;
    out.set(card.sig, off); off += 64;
    view.setUint16(off, recipients.length); off += 2;
    for (const c of copies) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /**
   * Opens an envelope addressed to us. Verifies the sender card, picks our
   * copy, decrypts with replay protection. On success the sender's card is
   * cached under their Ed25519-derived peer id.
   */
  open(aad: Uint8Array, payload: Uint8Array): Uint8Array {
    const card = parseCard(payload);
    if (!PeerCard.verify(card)) throw peersErr('BadCipher', 'card signature invalid');
    if (bytesEqual(card.x25519Pub, this.identity.xPublic())) {
      throw peersErr('Other', 'message from ourselves');
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const n = view.getUint16(129);
    let rest = payload.subarray(131);
    const own = this.identity.xPublic();
    for (let i = 0; i < n; i++) {
      if (rest.length < 32 + 4 + 8 + 16) throw peersErr('BadCipher');
      const rcpt = rest.slice(0, 32);
      const ctLen = new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getUint32(32);
      const copyLen = 32 + 4 + ctLen;
      if (rest.length < copyLen) throw peersErr('BadCipher');
      const sealed = rest.subarray(36, 36 + ctLen);
      if (bytesEqual(rcpt, own)) {
        const session = this.sessionFor(card.x25519Pub);
        const plaintext = openEnvelope(session, aad, sealed);
        this.rememberContact(PeerCard.peerIdOf(card), card);
        return plaintext;
      }
      rest = rest.subarray(copyLen);
    }
    throw peersErr('NotAddressed');
  }

  private sessionFor(theirPub: Uint8Array): Session {
    const k = toKey(theirPub);
    let session = this.sessions.get(k);
    if (!session) {
      session = Session.agree(this.identity.xSecret, theirPub);
      this.sessions.set(k, session);
    }
    return session;
  }
}

/** Parses (does not verify) the sender's card from a sealed envelope. */
export function cardFromEnvelope(payload: Uint8Array): PeerCard {
  return parseCard(payload);
}

function parseCard(payload: Uint8Array): PeerCard {
  const min = 1 + 32 + 32 + 64 + 2;
  if (payload.length < min || payload[0] !== ENVELOPE_VERSION) throw peersErr('BadCipher');
  return {
    edPub: payload.slice(1, 33),
    x25519Pub: payload.slice(33, 65),
    sig: payload.slice(65, 129),
  };
}

function toKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromKey(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
