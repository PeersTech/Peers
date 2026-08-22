import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {peersErr} from './error.js';
import {utf8} from './util.js';

/** Domain-separation labels. **Frozen** — changing any of these changes
 * every peer ID derived from a phrase, orphaning existing identities. */
const SEED_SALT = utf8('peers/v1/seed');
const ED25519_INFO = utf8('peers/v1/ed25519');
const X25519_INFO = utf8('peers/v1/x25519');

/** Derives the Ed25519 seed and X25519 secret from mnemonic entropy.
 *
 * Entropy already carries 128–256 bits from a CSPRNG, so no password
 * stretching is applied — HKDF is used for domain separation, not
 * hardening. The two outputs are independent. */
export function deriveKeys(entropy: Uint8Array): [Uint8Array, Uint8Array] {
  if (entropy.length < 16) {
    throw peersErr(
      'BadPhrase',
      `entropy must be at least 16 bytes, got ${entropy.length}`,
    );
  }
  const ed = hkdf(sha256, entropy, SEED_SALT, ED25519_INFO, 32);
  const x = hkdf(sha256, entropy, SEED_SALT, X25519_INFO, 32);
  return [ed, x];
}
