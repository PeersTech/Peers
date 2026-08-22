import {ed25519, x25519} from '@noble/curves/ed25519.js';
import {randomBytes} from '@noble/hashes/utils.js';
import {derivePeerId, fingerprint, peerIdBytes as peerIdBytesOf} from './peerid.js';
import {deriveKeys} from './seed.js';

/**
 * The node's cryptographic identity: an Ed25519 keypair that derives the
 * peer ID (the "crypto hash" other peers know us by) plus an X25519 keypair
 * for ECDH key agreement in DM sessions.
 *
 * The same phrase always yields the same peer ID on any machine — this is
 * what makes the recovery phrase *be* the identity.
 */
export class Identity {
  /** Raw multihash bytes behind `peerId` (name seeding, code derivation). */
  readonly peerIdBytes: Uint8Array;

  private constructor(
    readonly edSeed: Uint8Array,
    readonly xSecret: Uint8Array,
    readonly peerId: string,
  ) {
    this.peerIdBytes = peerIdBytesOf(this.edPublic());
  }

  static fromEntropy(entropy: Uint8Array): Identity {
    const [edSeed, xSecret] = deriveKeys(entropy);
    return new Identity(edSeed, xSecret, derivePeerId(ed25519.getPublicKey(edSeed)));
  }

  static random(): Identity {
    const edSeed = ed25519.utils.randomSecretKey();
    return new Identity(edSeed, randomBytes(32), derivePeerId(ed25519.getPublicKey(edSeed)));
  }

  /** Restores from `marshalIdentity` output (`edSeed || xSecret`). */
  static unmarshal(bytes: Uint8Array): Identity {
    if (bytes.length !== 64) {
      throw new Error(`identity blob has wrong length: ${bytes.length}`);
    }
    return new Identity(bytes.slice(0, 32), bytes.slice(32), derivePeerId(ed25519.getPublicKey(bytes.slice(0, 32))));
  }

  marshal(): Uint8Array {
    return concat64(this.edSeed, this.xSecret);
  }

  edPublic(): Uint8Array {
    return ed25519.getPublicKey(this.edSeed);
  }

  /** JSON-friendly form for signed payloads. */
  edPublicAsArray(): number[] {
    return Array.from(this.edPublic());
  }

  xPublic(): Uint8Array {
    return x25519.getPublicKey(this.xSecret);
  }

  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.edSeed);
  }

  verify(message: Uint8Array, sig: Uint8Array): boolean {
    return ed25519.verify(sig, message, this.edPublic());
  }

  /** SHA-256 of both public keys as grouped base32. Must match out-of-band
   * between two peers to rule out a man-in-the-middle. */
  fingerprint(): string {
    return fingerprint(this.edPublic(), this.xPublic());
  }

  /** Conventional short form: first 8 + last 4 chars with an ellipsis. */
  peerIdShort(): string {
    return this.peerId.length <= 12 ? this.peerId : `${this.peerId.slice(0, 8)}…${this.peerId.slice(-4)}`;
  }
}

function concat64(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(a, 0);
  out.set(b, 32);
  return out;
}
