import {existsSync} from 'node:fs';
import {mkdir, chmod, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {peersErr} from './error.js';
import {Identity} from './identity.js';
import {decodePhrase} from './mnemonic.js';
import {deriveKey, openX, sealX, PROD_KDF, type KdfParams} from './kdf.js';
import {b64decode, b64encode} from './util.js';

/** Keystore format version. v1 (random key, password-sealed) is refused:
 * its identity was never derived from a phrase, so no phrase can recover it. */
export const VERSION = 2;

const KDF_NAME = 'argon2id';

interface KdfFile {
  name: string;
  salt: string;
  time: number;
  memory: number;
  threads: number;
}

interface KeystoreFile {
  version: number;
  kdf: KdfFile;
  nonce: string;
  sealed: string;
}

/**
 * Stores the identity sealed with a phrase-derived key (Argon2id →
 * XChaCha20-Poly1305). The plaintext identity never touches disk.
 *
 * The keystore is a *cache*, not the source of truth: the recovery phrase
 * both seals the file and derives the identity inside it, so deleting the
 * file is recoverable and losing the phrase is not.
 */
export class Keystore {
  constructor(
    readonly path: string,
    private readonly opts: {kdf?: KdfParams} = {},
  ) {}

  /**
   * Derives the identity from `phrase` and seals it with that same phrase.
   * Idempotent: one phrase always yields one identity, so calling this
   * again after the file is lost recovers the original peer ID.
   */
  async createFromPhrase(phrase: string): Promise<Identity> {
    const entropy = decodePhrase(phrase);
    const id = Identity.fromEntropy(entropy);
    await this.seal(id.marshal(), phrase);
    return id;
  }

  /** Restores the identity if the phrase is correct. */
  async load(phrase: string): Promise<Identity> {
    return Identity.unmarshal(await this.open(phrase));
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  async seal(blob: Uint8Array, password: string): Promise<void> {
    const kdf = this.opts.kdf ?? PROD_KDF;
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const nonce = new Uint8Array(24);
    crypto.getRandomValues(nonce);

    const key = await deriveKey(password, salt, kdf);
    const sealed = sealX(key, nonce, blob);

    const file: KeystoreFile = {
      version: VERSION,
      kdf: {
        name: KDF_NAME,
        salt: b64encode(salt),
        time: kdf.time,
        memory: kdf.memoryKib,
        threads: kdf.threads,
      },
      nonce: b64encode(nonce),
      sealed: b64encode(sealed),
    };
    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, JSON.stringify(file, null, 2));
    if (process.platform !== 'win32') await chmod(this.path, 0o600);
  }

  private async open(password: string): Promise<Uint8Array> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      throw peersErr('NoKeystore');
    }
    let file: KeystoreFile;
    try {
      file = JSON.parse(raw) as KeystoreFile;
    } catch {
      throw peersErr('Keystore', 'corrupt keystore file');
    }
    if (file.version < VERSION) throw peersErr('StaleKeystore');
    if (file.version > VERSION) {
      throw peersErr(
        'Keystore',
        `keystore version ${file.version} is newer than this build supports`,
      );
    }
    if (file.kdf.name !== KDF_NAME) throw peersErr('Keystore', `unsupported kdf ${file.kdf.name}`);

    const key = await deriveKey(password, b64decode(file.kdf.salt), {
      time: file.kdf.time,
      memoryKib: file.kdf.memory,
      threads: file.kdf.threads,
    });
    try {
      return openX(key, b64decode(file.nonce), b64decode(file.sealed));
    } catch {
      throw peersErr('BadPassword');
    }
  }
}
