import {sha256} from '@noble/hashes/sha2.js';
import {utf8} from './util.js';

/** Domain separator for code derivation. **Frozen** — changing it changes
 * everyone's code. */
const CODE_DOMAIN = 'peers/v1/code';

/** Domain separator for the DHT rendezvous key a code resolves through. */
const CODE_KEY_DOMAIN = 'peers/v1/code-key';

/** Number of digits in a short peer code. */
export const CODE_DIGITS = 12;

/**
 * Derives the 12-digit short code for a peer id.
 *
 * The code is a *lookup hint*, never an identity. It is deliberately short
 * enough to read aloud, which also makes it short enough to grind: an
 * attacker can search keypairs until one derives a chosen code in a few
 * GPU-hours. That is fine here and only here, because resolving a code
 * yields a full peer id that the user verifies (name, avatar, fingerprint)
 * before accepting. Never treat a matching code as proof of identity.
 */
export function shortCode(peerIdBytes: Uint8Array): string {
  const digest = sha256(concatUtf8(CODE_DOMAIN, peerIdBytes));
  // Take 8 bytes, reduce mod 10^12 — modulo bias across the digit space
  // is far below anything that matters for a lookup hint.
  const view = new DataView(digest.buffer, digest.byteOffset, 8);
  const n = view.getBigUint64(0) % 1_000_000_000_000n;
  return n.toString().padStart(CODE_DIGITS, '0');
}

/** Formats a code for display in groups of four: `4827 1193 6052`. */
export function formatCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join(' ');
}

/** Strips spaces, dashes and any other separator a user might type, leaving
 * bare digits. Returns `null` unless exactly CODE_DIGITS digits remain. */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  return digits.length === CODE_DIGITS ? digits : null;
}

/** The DHT key a code is announced and looked up under. Peers publish
 * themselves as providers of this key, so resolution reuses the same
 * Kademlia provider machinery as blob parking. */
export function codeKey(code: string): Uint8Array {
  return sha256(utf8(CODE_KEY_DOMAIN + code));
}

function concatUtf8(s: string, bytes: Uint8Array): Uint8Array {
  const head = utf8(s);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}
