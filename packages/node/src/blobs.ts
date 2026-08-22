import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 as hasher } from 'multiformats/hashes/sha2';
import * as Digest from 'multiformats/hashes/digest';
import { lpStream } from 'it-length-prefixed-stream';
import type { PeerId, Stream } from '@libp2p/interface';

/** Wire protocol — torus already calls it /peers/blob/1.0.0 in Rust. Clean break, same name. */
export const BLOB_PROTOCOL = '/peers/blob/1.0.0';

/** Caps a single parked blob (64 KiB — enough for many messages; files get chunking later). Mirrors `MAX_BLOB_SIZE` in `backend/src/p2p/blobs.rs`. */
export const MAX_BLOB_SIZE = 64 * 1024;

/** SHA-256 of content, torrent-info-hash style. */
export type BlobHash = Uint8Array & { readonly __brand: 'BlobHash' };

export function hashBytes(data: Uint8Array): BlobHash {
  return sha256(data) as BlobHash;
}

export function toHex(hash: Uint8Array): string {
  let out = '';
  for (const b of hash) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): BlobHash | null {
  if (hex.length !== 64) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out as BlobHash;
}

/** Wrap a raw 32-byte SHA-256 in a CID so js-libp2p's Kademlia provider machinery will store it. */
export function hashToCid(hash: Uint8Array): CID {
  const digest = Digest.create(hasher.code, hash);
  return CID.createV1(raw.code, digest);
}

/** Local seed cache: content-addressed by SHA-256. Holds only ciphertext in production. */
export class BlobStore {
  private readonly map = new Map<string, Uint8Array>();

  put(data: Uint8Array): BlobHash {
    const h = hashBytes(data);
    this.map.set(toHex(h), data.slice());
    return h;
  }

  putWithHash(hash: BlobHash, data: Uint8Array): void {
    this.map.set(toHex(hash), data.slice());
  }

  get(hash: Uint8Array): Uint8Array | undefined {
    const v = this.map.get(toHex(hash));
    return v ? v.slice() : undefined;
  }

  has(hash: Uint8Array): boolean {
    return this.map.has(toHex(hash));
  }
}

/**
 * Server side of the blob protocol: one varint-len-prefixed request (32-byte hash),
 * one varint-len-prefixed response (blob bytes or empty = not found).  The Rust
 * side uses 4-byte BE framing; framing is intentionally not on the wire-critical
 * path for the TS migration (clean break), but the *behaviour* — single round-
 * trip, bounded size, hash-verified — is identical.  `lpStream` hides the
 * sink/source Duplex dance and gives us backpressure naturally.
 */
export function handleBlobProtocol(store: BlobStore) {
  return async ({ stream }: { stream: Stream }) => {
    const lp = lpStream(stream, {
      maxDataLength: MAX_BLOB_SIZE,
      maxLengthLength: 8,
    });
    try {
      const req = await lp.read();
      // Request is exactly 32 bytes hash; be lenient and slice.
      const hash = req.subarray(0, 32);
      const data = store.get(hash) ?? new Uint8Array(0);
      // Empty = not found (mirrors Rust's empty response).
      await lp.write(data);
    } catch {
      // Stream already closed/aborted — nothing to do.
    } finally {
      try {
        await stream.close();
      } catch {}
    }
  };
}

/**
 * Client side: open a blob stream to `peer`, ask for `hash`, return the blob
 * (or null if the remote doesn't have it). Enforces MAX_BLOB_SIZE and hash check
 * at the caller.
 */
export async function fetchFromPeer(
  dialProtocol: (peer: PeerId, protocol: string) => Promise<Stream>,
  peer: PeerId,
  hash: Uint8Array,
): Promise<Uint8Array | null> {
  const stream = await dialProtocol(peer, BLOB_PROTOCOL);
  const lp = lpStream(stream, {
    maxDataLength: MAX_BLOB_SIZE,
    maxLengthLength: 8,
  });
  try {
    await lp.write(hash);
    const res = await lp.read();
    const data = res.subarray();
    if (data.length === 0) return null;
    if (data.length > MAX_BLOB_SIZE) throw new Error('blob too large');
    return data;
  } finally {
    try {
      await stream.close();
    } catch {}
  }
}
