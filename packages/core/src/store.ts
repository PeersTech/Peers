import {existsSync} from 'node:fs';
import {mkdir, chmod, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {SignedProfile} from './card.js';
import {PROD_KDF, type KdfParams, deriveKey, openX, sealX} from './kdf.js';
import type {SessionState} from './session.js';
import type {SignedMessage} from './server.js';
import {b64decode, b64encode} from './util.js';

/** One message in a direct-message conversation. `peer` is the remote peer
 * id; `mine` marks the side that sent it. */
export interface DmMessage {
  peer: string;
  text: string;
  ts: number;
  mine: boolean;
}

/** Keyed message history. Server channels are keyed
 * `"{serverId}/{channel}"` and store raw signed messages (re-verifiable);
 * DMs are keyed by the remote peer id. */
export class History {
  readonly server = new Map<string, SignedMessage[]>();
  readonly dm = new Map<string, DmMessage[]>();

  pushServer(key: string, msg: SignedMessage): void {
    const list = this.server.get(key) ?? [];
    list.push(msg);
    this.server.set(key, list);
  }

  pushDm(peer: string, msg: DmMessage): void {
    const list = this.dm.get(peer) ?? [];
    list.push(msg);
    this.dm.set(peer, list);
  }

  serverMessages(key: string): SignedMessage[] {
    return this.server.get(key) ?? [];
  }

  dmMessages(peer: string): DmMessage[] {
    return this.dm.get(peer) ?? [];
  }

  /** All signed messages across every channel of `serverId`, sorted by
   * timestamp — the payload of a server snapshot. */
  serverSnapshot(serverId: string): SignedMessage[] {
    const prefix = `${serverId}/`;
    return [...this.server]
      .filter(([k]) => k.startsWith(prefix))
      .flatMap(([, v]) => v)
      .sort((a, b) => a.ts - b.ts);
  }
}

interface HistoryJson {
  server: [string, SignedMessage[]][];
  dm: [string, DmMessage[]][];
}

function historyToJson(h: History): HistoryJson {
  return {server: [...h.server], dm: [...h.dm]};
}

function historyFromJson(j: HistoryJson | undefined): History {
  const h = new History();
  for (const [k, v] of j?.server ?? []) h.server.set(k, v);
  for (const [k, v] of j?.dm ?? []) h.dm.set(k, v);
  return h;
}

/** Everything that survives a restart, serialized into one sealed blob.
 * Sessions/contacts carry per-contact E2E secrets and ride inside the
 * password-sealed envelope — never on disk unencrypted. */
export class PersistedState {
  sessions: [Uint8Array, SessionState][] = [];
  contacts: [string, Uint8Array][] = [];
  servers: unknown[] = [];
  history = new History();
  profile: SignedProfile | null = null;
}

interface PersistedStateJson {
  sessions: [string, SessionStateJson][];
  contacts: [string, string][];
  servers: unknown[];
  history: HistoryJson;
  profile: SignedProfile | null;
}

interface SessionStateJson extends Omit<SessionState, 'root'> {
  rootB64: string;
}

interface StoreFile {
  version: number;
  salt: string;
  nonce: string;
  sealed: string;
}

/**
 * Sealed at-rest persistence handle returned by Store.open. The key is
 * derived from the unlock password (Argon2id → XChaCha20-Poly1305), so
 * signing keys and decrypted history never sit on disk in plaintext.
 */
export class StoreHandle {
  constructor(
    private readonly key: Uint8Array,
    private readonly salt: Uint8Array,
    readonly path: string,
  ) {}

  /** Decrypts and returns the persisted state. */
  async load(): Promise<PersistedState> {
    let file: StoreFile;
    try {
      file = JSON.parse(await readFile(this.path, 'utf8')) as StoreFile;
    } catch (e) {
      throw Object.assign(new Error(`state unreadable: ${String(e)}`), {kind: 'Keystore'});
    }
    let plain: Uint8Array;
    try {
      plain = openX(this.key, b64decode(file.nonce), b64decode(file.sealed));
    } catch {
      throw Object.assign(new Error('bad password'), {kind: 'BadPassword'});
    }
    const json = JSON.parse(new TextDecoder().decode(plain)) as PersistedStateJson;
    const state = new PersistedState();
    state.sessions = json.sessions.map(([k, s]) => [
      b64decode(k),
      {...s, root: b64decode(s.rootB64)},
    ]);
    state.contacts = json.contacts.map(([p, k]) => [p, b64decode(k)]);
    state.servers = json.servers;
    state.history = historyFromJson(json.history);
    state.profile = json.profile ?? null;
    return state;
  }

  /** Encrypts and writes `state`. */
  async save(state: PersistedState): Promise<void> {
    const json: PersistedStateJson = {
      sessions: state.sessions.map(([k, s]) => [
        b64encode(k),
        {rootB64: b64encode(s.root), counter: s.counter, opened: s.opened, maxOpened: s.maxOpened},
      ]),
      contacts: state.contacts.map(([p, k]) => [p, b64encode(k)]),
      servers: state.servers,
      history: historyToJson(state.history),
      profile: state.profile,
    };
    const plain = new TextEncoder().encode(JSON.stringify(json));
    const nonce = new Uint8Array(24);
    crypto.getRandomValues(nonce);
    const sealed = sealX(this.key, nonce, plain);
    const file: StoreFile = {
      version: 1,
      salt: b64encode(this.salt),
      nonce: b64encode(nonce),
      sealed: b64encode(sealed),
    };
    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, JSON.stringify(file, null, 2));
    if (process.platform !== 'win32') await chmod(this.path, 0o600);
  }
}

/** The store itself: open with a password to mint or restore the handle.
 * The salt lives in the file itself; a fresh one is minted on first unlock. */
export class Store {
  constructor(
    readonly path: string,
    private readonly opts: {kdf?: KdfParams} = {},
  ) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Unlocks the store: reads (or mints) the salt, derives the storage key
   * from `password`, and returns a handle for loading/saving sealed state.
   */
  async open(password: string): Promise<StoreHandle> {
    let salt: Uint8Array;
    if (this.exists()) {
      const file = JSON.parse(await readFile(this.path, 'utf8')) as StoreFile;
      salt = b64decode(file.salt);
      if (salt.length !== 16) throw Object.assign(new Error('bad state salt'), {kind: 'Keystore'});
    } else {
      salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
    }
    const key = await deriveKey(password, salt, this.opts.kdf ?? PROD_KDF);
    const handle = new StoreHandle(key, salt, this.path);
    if (!this.exists()) {
      // First run: write an empty state so the salt is persisted and future
      // unlocks derive the same key.
      await handle.save(new PersistedState());
    }
    return handle;
  }
}
