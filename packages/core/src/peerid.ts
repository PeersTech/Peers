import {sha256} from '@noble/hashes/sha2.js';
import {base58Encode, concatBytes, groupedBase32} from './util.js';

/**
 * Peer IDs follow the libp2p convention so a TS node and any other
 * libp2p implementation agree on identity: the Ed25519 public key is
 * protobuf-encoded (`0x08 0x01 0x12 0x20 || key`, 36 bytes), wrapped in
 * an *identity* multihash (`0x00 0x24 || payload` — 36 ≤ 42), and
 * base58btc-encoded. Every such id starts `12D3KooW`.
 */
const ED_PROTOBUF_PREFIX = Uint8Array.of(0x08, 0x01, 0x12, 0x20);

export function derivePeerId(edPub: Uint8Array): string {
  const payload = concatBytes(ED_PROTOBUF_PREFIX, edPub);
  const multihash = concatBytes(Uint8Array.of(0x00, payload.length), payload);
  return base58Encode(multihash);
}

/** The raw multihash bytes behind a peer id string (name seeding). */
export function peerIdBytes(edPub: Uint8Array): Uint8Array {
  const payload = concatBytes(ED_PROTOBUF_PREFIX, edPub);
  return concatBytes(Uint8Array.of(0x00, payload.length), payload);
}

/** SHA-256 of both public keys, base32-grouped. Compared out-of-band to
 * rule out man-in-the-middle. */
export function fingerprint(edPub: Uint8Array, xPub: Uint8Array): string {
  const digest = sha256(concatBytes(edPub, xPub));
  return groupedBase32(digest);
}
