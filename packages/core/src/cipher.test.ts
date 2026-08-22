import {describe, expect, it} from 'vitest';
import {open, seal, nonceFor, MAX_MESSAGE_SIZE} from './cipher.js';
import {Session, MAX_SESSION_GAP} from './session.js';
import {x25519} from '@noble/curves/ed25519.js';

function pair(): [Session, Session] {
  const aSecret = x25519.utils.randomSecretKey();
  const bSecret = x25519.utils.randomSecretKey();
  const aPub = x25519.getPublicKey(aSecret);
  const bPub = x25519.getPublicKey(bSecret);
  return [Session.agree(aSecret, bPub), Session.agree(bSecret, aPub)];
}

describe('session key agreement', () => {
  it('both sides derive the same message keys', () => {
    const [sa, sb] = pair();
    for (let i = 0; i < 25; i++) {
      expect(sa.nextKey()).toEqual(sb.keyAt(i));
    }
  });

  it('key_at is pure — failed opens never corrupt state', () => {
    const [sa, sb] = pair();
    const k1 = sb.keyAt(4);
    for (let i = 0; i < 3; i++) open(sb, new Uint8Array(0), seal(sa, new Uint8Array(0), new Uint8Array(7).fill(1)));
    expect(sb.keyAt(4)).toEqual(k1);
  });

  it('rejects gaps beyond MAX_SESSION_GAP', () => {
    const [sa] = pair();
    expect(() => sa.keyAt(MAX_SESSION_GAP + 5)).toThrow(/gap/i);
    expect(sa.keyAt(10)).toHaveLength(32);
  });
});

describe('envelope seal/open', () => {
  it('prefixes the sequence number (8 bytes big-endian)', () => {
    const [sa] = pair();
    const env = seal(sa, new Uint8Array(0), new TextEncoder().encode('x'));
    expect(Number(new DataView(env.buffer).getBigUint64(0))).toBe(0);
  });

  it('mirrors in order with matching aad', () => {
    const [sa, sb] = pair();
    for (let i = 0; i < 5; i++) {
      const env = seal(sa, new TextEncoder().encode('ctx'), new TextEncoder().encode(`hello ${i}`));
      expect(new TextDecoder().decode(open(sb, new TextEncoder().encode('ctx'), env))).toBe(`hello ${i}`);
    }
  });

  it('aad mismatch is rejected, then the correct aad opens', () => {
    const [sa, sb] = pair();
    const env = seal(sa, new TextEncoder().encode('channel/general'), new TextEncoder().encode('secret'));
    expect(() => open(sb, new TextEncoder().encode('channel/other'), env)).toThrow();
    expect(new TextDecoder().decode(open(sb, new TextEncoder().encode('channel/general'), env))).toBe('secret');
  });

  it('tamper detected and rolled back', () => {
    const [sa, sb] = pair();
    const env = seal(sa, new Uint8Array(0), new TextEncoder().encode('do not touch'));
    env[env.length - 1]! ^= 0xff;
    expect(() => open(sb, new Uint8Array(0), env)).toThrow();
    const ok = seal(sa, new Uint8Array(0), new TextEncoder().encode('do not touch'));
    expect(new TextDecoder().decode(open(sb, new Uint8Array(0), ok))).toBe('do not touch');
  });

  it('replay rejected', () => {
    const [sa, sb] = pair();
    const env = seal(sa, new Uint8Array(0), new TextEncoder().encode('first'));
    open(sb, new Uint8Array(0), env);
    expect(() => open(sb, new Uint8Array(0), env)).toThrow(/replay/i);
  });

  it('out-of-order delivery within gap opens fine', () => {
    const [sa, sb] = pair();
    const envs = Array.from({length: 5}, (_, i) => seal(sa, new Uint8Array(0), Uint8Array.of(i)));
    for (const i of [1, 3, 2, 4]) {
      expect(open(sb, new Uint8Array(0), envs[i]!)).toEqual(Uint8Array.of(i));
    }
  });

  it('rejects oversized plaintext', () => {
    const [sa] = pair();
    const big = new Uint8Array(MAX_MESSAGE_SIZE + 1);
    expect(() => seal(sa, new Uint8Array(0), big)).toThrow(/large/i);
  });
});

describe('nonce_for', () => {
  it('is 4 zero bytes followed by the sequence in big-endian', () => {
    const n = nonceFor(1);
    expect(n).toHaveLength(12);
    expect(n.slice(0, 4)).toEqual(new Uint8Array(4));
    expect(n[11]).toBe(1);
  });
});
