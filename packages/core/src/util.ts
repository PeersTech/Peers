import {base32nopad, base58, base64} from '@scure/base';

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function b64encode(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function b64decode(s: string): Uint8Array {
  return base64.decode(s);
}

/** Uppercase RFC4648 base32 without padding, grouped in fours: the
 * fingerprint display format. */
export function groupedBase32(bytes: Uint8Array): string {
  const raw = base32nopad.encode(bytes).toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) groups.push(raw.slice(i, i + 4));
  return groups.join(' ');
}

export function base58Encode(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Canonical JSON signing bytes. Field order is fixed by constructing
 * ordered objects — sign and verify must build them identically. */
export function canonicalJson(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value));
}

/** Seconds since the unix epoch (u64 in the wire format; JS numbers are
 * exact well past any plausible timestamp). */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
