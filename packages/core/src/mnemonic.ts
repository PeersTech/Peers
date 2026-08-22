import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {peersErr} from './error.js';

/** BIP39 mnemonics are the login: the phrase *is* the private key.
 * 12 words = 128 bits of entropy, 24 = 256 bits. */

export type WordCount = 12 | 15 | 18 | 21 | 24;

const STRENGTH: Record<WordCount, number> = {
  12: 128,
  15: 160,
  18: 192,
  21: 224,
  24: 256,
};

export function generatePhrase(words: WordCount = 12): string {
  return generateMnemonic(wordlist, STRENGTH[words]);
}

export function validatePhrase(phrase: string): boolean {
  try {
    return validateMnemonic(normalize(phrase), wordlist);
  } catch {
    return false;
  }
}

/** Decodes a phrase to its entropy bytes, rejecting bad checksums and
 * malformed phrases outright. */
export function decodePhrase(phrase: string): Uint8Array {
  const normalized = normalize(phrase);
  if (!validateMnemonic(normalized, wordlist)) {
    throw peersErr('BadPhrase', 'invalid recovery phrase');
  }
  return mnemonicToEntropy(normalized, wordlist);
}

export function entropyToPhrase(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, wordlist);
}

function normalize(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}
