import {chacha20poly1305} from '@noble/ciphers/chacha.js';
import {peersErr} from './error.js';
import type {Session} from './session.js';

/** Max plaintext size of a single message (64 KiB). */
export const MAX_MESSAGE_SIZE = 64 * 1024;

/**
 * Encrypts `plaintext` with the session's next key and authenticates `aad`
 * (additional authenticated data, e.g. channel/context metadata).
 *
 * Envelope layout: `[8-byte big-endian seq || nonce-derived ct+tag]`.
 * On success the session counter advances by one.
 */
export function seal(session: Session, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (plaintext.length > MAX_MESSAGE_SIZE) throw peersErr('MessageTooLarge');
  const seq = session.counter;
  const key = session.nextKey();
  const cipher = chacha20poly1305(key, nonceFor(seq), aad);
  const ct = cipher.encrypt(plaintext);
  return withSeqPrefix(seq, ct);
}

/**
 * Decrypts a `seal`-produced envelope. `aad` must match exactly. Key
 * derivation is stateless with respect to the sequence, so failed opens
 * never corrupt session state; successful opens are recorded for replay
 * detection.
 */
export function open(session: Session, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.length < 8 + 16) throw peersErr('BadCipher');
  const view = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const seq = Number(view.getBigUint64(0));
  const key = session.keyAt(seq);
  const cipher = chacha20poly1305(key, nonceFor(seq), aad);
  let pt: Uint8Array;
  try {
    pt = cipher.decrypt(sealed.subarray(8));
  } catch {
    throw peersErr('BadCipher');
  }
  if (session.checkReplay(seq)) throw peersErr('Replay');
  session.markOpened(seq);
  return pt;
}

/** Deterministic 12-byte nonce for sequence `n`: 4 zero bytes + seq BE. */
export function nonceFor(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n));
  return nonce;
}

function withSeqPrefix(seq: number, ct: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + ct.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(seq));
  out.set(ct, 8);
  return out;
}
