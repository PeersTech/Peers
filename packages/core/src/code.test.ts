import {sha256} from '@noble/hashes/sha2.js';
import {describe, expect, it} from 'vitest';
import {codeKey, formatCode, normalizeCode, shortCode, CODE_DIGITS} from './code.js';
import {Identity} from './identity.js';

/** Deterministic test identities, mirroring the Rust suite's seeded keys. */
function identity(seed: number): Identity {
  return Identity.fromEntropy(new Uint8Array(32).fill(seed));
}

describe('short codes', () => {
  it('is twelve digits', () => {
    const c = shortCode(identity(1).peerIdBytes);
    expect(c).toHaveLength(CODE_DIGITS);
    expect(c).toMatch(/^\d{12}$/);
  });

  it('is deterministic', () => {
    expect(shortCode(identity(9).peerIdBytes)).toBe(shortCode(identity(9).peerIdBytes));
  });

  it('different peers get different codes', () => {
    expect(shortCode(identity(1).peerIdBytes)).not.toBe(shortCode(identity(2).peerIdBytes));
  });

  it('formats in groups of four', () => {
    expect(formatCode('482711936052')).toBe('4827 1193 6052');
  });

  it('normalizes human spacing', () => {
    expect(normalizeCode('4827 1193 6052')).toBe('482711936052');
    expect(normalizeCode('4827-1193-6052')).toBe('482711936052');
    expect(normalizeCode(' 482711936052 ')).toBe('482711936052');
  });

  it('rejects wrong length', () => {
    expect(normalizeCode('4827 1193')).toBeNull();
    expect(normalizeCode('4827119360521')).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });

  it('code key is stable and distinct', () => {
    const a = codeKey('482711936052');
    expect(codeKey('482711936052')).toEqual(a);
    expect(codeKey('482711936053')).not.toEqual(a);
  });

  it('code key is domain separated', () => {
    const bare = sha256(new TextEncoder().encode('482711936052'));
    expect(codeKey('482711936052')).not.toEqual(bare);
  });

  it('a code is a lookup bucket, not the peer id', () => {
    const p = identity(3);
    expect(p.peerId.includes(shortCode(p.peerIdBytes))).toBe(false);
  });
});
