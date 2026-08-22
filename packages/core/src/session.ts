import {x25519} from '@noble/curves/ed25519.js';
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {utf8} from './util.js';

/** Maximum gap between message sequence numbers we are willing to skip
 * forward; guards against a hostile peer forcing unbounded SHA-256 chains. */
export const MAX_SESSION_GAP = 100_000;

/** Bounds the set of opened sequence numbers kept for replay detection. */
const REPLAY_WINDOW = 4096;

/** Serializable snapshot of a Session's state, persisted inside the sealed
 * store envelope. `opened` is bounded by the replay window. */
export interface SessionState {
  root: Uint8Array;
  counter: number;
  opened: number[];
  maxOpened: number;
}

/**
 * Per-contact E2E key derivation state. Both parties derive the same
 * sequence of message keys from the X25519 ECDH shared secret:
 *
 * ```text
 * chain_0 = root                    (HKDF of the ECDH secret)
 * chain_n = SHA-256^n(root)
 * key_n   = HKDF(chain_n, salt=n)
 * ```
 *
 * Deriving a key is a pure function of n (up to MAX_SESSION_GAP), which
 * makes out-of-order delivery and retries cheap. Replay protection is a
 * bounded set of opened sequence numbers. Memory-only until exported.
 */
export class Session {
  counter = 0;
  private readonly opened = new Set<number>();
  private maxOpened = 0;

  constructor(
    readonly root: Uint8Array,
  ) {}

  /** Derives a shared session from our X25519 secret and the other party's
   * public key. Both parties must pass the two public keys in canonical
   * order to obtain identical state — done internally via sorting. */
  static agree(ourSecret: Uint8Array, theirPub: Uint8Array): Session {
    const shared = x25519.getSharedSecret(ourSecret, theirPub);
    const ourPub = x25519.getPublicKey(ourSecret);
    const [canonA, canonB] =
      compareBytes(theirPub, ourPub) < 0 ? [theirPub, ourPub] : [ourPub, theirPub];
    const salt = sha256(concat(canonA, canonB));
    const root = hkdf(sha256, shared, salt, utf8('peers/v1/root'), 32);
    return new Session(root);
  }

  static import(state: SessionState): Session {
    const s = new Session(state.root);
    s.counter = state.counter;
    for (const n of state.opened) s.opened.add(n);
    s.maxOpened = state.maxOpened;
    return s;
  }

  export(): SessionState {
    return {
      root: this.root.slice(),
      counter: this.counter,
      opened: [...this.opened].sort((a, b) => a - b),
      maxOpened: this.maxOpened,
    };
  }

  /** Key for the next outgoing message; advances the counter. */
  nextKey(): Uint8Array {
    const key = this.keyAt(this.counter);
    this.counter += 1;
    return key;
  }

  /** Key for message `n`. Pure with respect to `n` — does not mutate
   * state, so failed opens and out-of-order deliveries are harmless. */
  keyAt(n: number): Uint8Array {
    if (n > MAX_SESSION_GAP) throw new Error(`message sequence gap too large: ${n}`);
    return hkdf(sha256, this.chainAt(n), seqSalt(n), utf8('peers/v1/msg'), 32);
  }

  /** Whether `n` is a replay: already opened, or too old to be a plausible
   * network reorder. */
  checkReplay(n: number): boolean {
    if (this.maxOpened > REPLAY_WINDOW && n < this.maxOpened - REPLAY_WINDOW) return true;
    return this.opened.has(n);
  }

  /** Records an opened sequence number, evicting entries outside the
   * replay window. */
  markOpened(n: number): void {
    this.opened.add(n);
    this.maxOpened = Math.max(this.maxOpened, n);
    for (const k of this.opened) {
      if (k + REPLAY_WINDOW < this.maxOpened) this.opened.delete(k);
    }
  }

  private chainAt(n: number): Uint8Array {
    let chain = this.root;
    for (let i = 0; i < n; i++) chain = sha256(chain);
    return chain;
  }
}

function seqSalt(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
