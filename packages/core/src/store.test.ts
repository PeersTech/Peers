import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {SignedMessage} from './server.js';
import {History, PersistedState, Store, type DmMessage} from './store.js';
import {TEST_KDF as TEST} from './kdf.js';

describe('store (sealed at-rest state)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peers-store-'));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  const store = (tag: string) => new Store(join(dir, tag, 'state.json'), {kdf: TEST});

  it('round trips with the password', async () => {
    const handle = await store('roundtrip').open('hunter2hunter');
    const state = await handle.load();
    state.history.pushDm('peer1', dm('hello', true));
    await handle.save(state);

    const again = await (await store('roundtrip').open('hunter2hunter')).load();
    expect(again.history.dmMessages('peer1')).toHaveLength(1);
  });

  it('wrong password rejected on load', async () => {
    const s = store('badpass');
    const handle = await s.open('correct password');
    await handle.save(new PersistedState());

    const bad = await s.open('wrong password');
    try {
      await bad.load();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as {kind?: string}).kind).toBe('BadPassword');
    }
  });

  it('plaintext never leaks to disk', async () => {
    const s = store('leak');
    const handle = await s.open('hunter2hunter');
    const state = new PersistedState();
    state.history.pushDm(
      'sensitive-peer',
      dm('super secret contents', true),
    );
    await handle.save(state);
    const raw = readFileSync(s.path, 'utf8');
    expect(raw).not.toContain('super secret');
    expect(raw).not.toContain('sensitive-peer');
  });

  function dm(text: string, mine: boolean): DmMessage {
    return {peer: text === 'super secret contents' ? 'sensitive-peer' : 'peer1', text, ts: 1, mine};
  }
});

describe('history', () => {
  it('keys server channels and DMs separately', () => {
    const h = new History();
    h.pushServer('srv1/general', msg('x', 2));
    h.pushServer('srv1/general', msg('y', 1));
    h.pushDm('bob', {peer: 'bob', text: 'hey', ts: 3, mine: false});
    expect(h.serverMessages('srv1/general')).toHaveLength(2);
    expect(h.dmMessages('bob')).toHaveLength(1);
    expect(h.dmMessages('alice')).toHaveLength(0);
  });

  it('server snapshot merges channels sorted by timestamp', () => {
    const h = new History();
    h.pushServer('srv/general', msg('late', 5));
    h.pushServer('srv/off-topic', msg('early', 1));
    h.pushServer('other/general', msg('other-server', 9));
    const snap = h.serverSnapshot('srv');
    expect(snap.map((m) => m.text)).toEqual(['early', 'late']);
  });

  function msg(text: string, ts: number): SignedMessage {
    return {version: 1, serverId: 'srv', channel: 'c', from: 'f', pubkey: [], text, ts, sig: ''};
  }
});
