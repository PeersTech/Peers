import {describe, expect, it} from 'vitest';
import {deriveKeys} from './seed.js';

describe('seed derivation (HKDF-SHA256, frozen labels)', () => {
  it('is deterministic', () => {
    const e = new Uint8Array(16).fill(7);
    const [aEd, aX] = deriveKeys(e);
    const [bEd, bX] = deriveKeys(e);
    expect(aEd).toEqual(bEd);
    expect(aX).toEqual(bX);
  });

  it('ed25519 and x25519 keys differ (domain separation)', () => {
    const [ed, x] = deriveKeys(new Uint8Array(32).fill(3));
    expect(ed).not.toEqual(x);
  });

  it('different entropy gives different keys', () => {
    const [a] = deriveKeys(new Uint8Array(16).fill(1));
    const [b] = deriveKeys(new Uint8Array(16).fill(2));
    expect(a).not.toEqual(b);
  });

  it('rejects short entropy', () => {
    expect(() => deriveKeys(new Uint8Array(8))).toThrow();
  });
});
