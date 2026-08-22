import {existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {generatePhrase} from './mnemonic.js';
import {Keystore} from './keystore.js';
import {TEST_KDF} from './kdf.js';

describe('keystore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peers-ks-'));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  const ks = (tag: string) => new Keystore(join(dir, tag, 'identity.json'), {kdf: TEST_KDF});

  it('create + load round trip', async () => {
    const store = ks('roundtrip');
    const phrase = generatePhrase(12);
    const created = await store.createFromPhrase(phrase);
    const loaded = await store.load(phrase);
    expect(loaded.peerId).toBe(created.peerId);
  });

  it('file is sealed: no peer id and no phrase words leak', async () => {
    const store = ks('leak');
    const phrase = generatePhrase(12);
    const created = await store.createFromPhrase(phrase);
    const raw = readFileSync(store.path, 'utf8');
    expect(raw).not.toContain(created.peerId);
    for (const word of phrase.split(' ')) {
      expect(raw).not.toContain(word);
    }
  });

  it('wrong phrase rejected with BadPassword', async () => {
    const store = ks('wrongphrase');
    await store.createFromPhrase(generatePhrase(12));
    try {
      await store.load(generatePhrase(12));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as {kind?: string}).kind).toBe('BadPassword');
    }
  });

  it('identity recoverable without the file (M16)', async () => {
    const store = ks('recover');
    const phrase = generatePhrase(12);
    const original = await store.createFromPhrase(phrase);

    rmSync(store.path);
    expect(store.exists()).toBe(false);

    const recovered = await new Keystore(store.path, {kdf: TEST_KDF}).createFromPhrase(phrase);
    expect(recovered.peerId).toBe(original.peerId);
  });

  it('missing keystore throws NoKeystore', async () => {
    const store = ks('missing');
    try {
      await store.load('x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as {kind?: string}).kind).toBe('NoKeystore');
    }
  });

  it('version 1 keystore refused outright', async () => {
    const path = join(dir, 'v1', 'identity.json');
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        kdf: {name: 'argon2id', salt: 'AAAA', time: 3, memory: 65536, threads: 4},
        nonce: 'AAAA',
        sealed: 'AAAA',
      }),
    );
    try {
      await new Keystore(path, {kdf: TEST_KDF}).load('anything');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as {kind?: string}).kind).toBe('StaleKeystore');
    }
  });

  it('keystore newer than this build refused', async () => {
    const store = ks('future');
    await store.createFromPhrase(generatePhrase(12));
    const raw = JSON.parse(readFileSync(store.path, 'utf8'));
    raw.version = 99;
    writeFileSync(store.path, JSON.stringify(raw));
    try {
      await store.load(generatePhrase(12));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/newer/);
    }
  });

  it('creates parent dirs and marks file 0600 on unix', async () => {
    const store = ks('perms/nested/deep');
    await store.createFromPhrase(generatePhrase(12));
    expect(existsSync(store.path)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    }
  });
});
