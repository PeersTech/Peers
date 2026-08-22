import {argon2id} from 'hash-wasm';
import {xchacha20poly1305} from '@noble/ciphers/chacha.js';

/** Argon2id parameters. Defaults match the hardened production profile;
 * tests inject lighter ones through the same interface. */
export interface KdfParams {
  time: number;
  memoryKib: number;
  threads: number;
}

export const PROD_KDF: KdfParams = {time: 3, memoryKib: 64 * 1024, threads: 4};

/** Light params for tests only — never ship these. */
export const TEST_KDF: KdfParams = {time: 1, memoryKib: 4096, threads: 4};

const KDF_KEY_LEN = 32;

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  kdf: KdfParams,
): Promise<Uint8Array> {
  return new Uint8Array(
    await argon2id({
      password,
      salt,
      parallelism: kdf.threads,
      iterations: kdf.time,
      memorySize: kdf.memoryKib,
      hashLength: KDF_KEY_LEN,
      outputType: 'binary',
    }),
  );
}

export function sealX(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce).encrypt(plain);
}

export function openX(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce).decrypt(sealed);
}
