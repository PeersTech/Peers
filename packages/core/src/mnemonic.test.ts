import {describe, expect, it} from 'vitest';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {decodePhrase, entropyToPhrase, generatePhrase, validatePhrase} from './mnemonic.js';

describe('mnemonic (BIP39)', () => {
  it('generates valid 12-word phrases', () => {
    const phrase = generatePhrase(12);
    expect(phrase.split(' ')).toHaveLength(12);
    expect(validatePhrase(phrase)).toBe(true);
  });

  it('generates valid 24-word phrases', () => {
    const phrase = generatePhrase(24);
    expect(phrase.split(' ')).toHaveLength(24);
    expect(validatePhrase(phrase)).toBe(true);
  });

  it('round-trips phrase -> entropy -> phrase', () => {
    const phrase = generatePhrase(12);
    const entropy = decodePhrase(phrase);
    expect(entropy).toHaveLength(16);
    expect(entropyToPhrase(entropy)).toBe(phrase);
  });

  it('rejects a bad checksum', () => {
    const phrase = generatePhrase(12);
    const words = phrase.split(' ');
    // The last word carries the 4 checksum bits: stepping to the next word
    // in the list changes both its entropy and checksum bits, so the
    // corruption is guaranteed invalid (no probabilistic flake).
    const last = wordlist.indexOf(words[11]!);
    words[11] = wordlist[(last + 1) % wordlist.length]!;
    expect(words[11]).not.toBe(phrase.split(' ')[11]);
    expect(validatePhrase(words.join(' '))).toBe(false);
    expect(() => decodePhrase(words.join(' '))).toThrow();
  });

  it('rejects wrong word counts', () => {
    expect(validatePhrase('abandon abandon abandon')).toBe(false);
    expect(validatePhrase('')).toBe(false);
  });

  it('different phrases give different entropy', () => {
    expect(decodePhrase(generatePhrase(12))).not.toEqual(decodePhrase(generatePhrase(12)));
  });
});
