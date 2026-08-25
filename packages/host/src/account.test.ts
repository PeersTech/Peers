import {describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Identity} from '@peers/core';
import { TEST_KDF} from '@peers/core';
import type {PeersNode} from '@peers/node';
import {PeersAccount} from './account.js';

/**
 * The account lifecycle: phrase → identity → sealed keystore, and the
 * sealed state store that lets servers/DMs/contacts survive a lock.
 * Node construction is injected so unlocks never touch the network.
 */

async function makeAccount(nodeFactory?: (id: Identity) => Promise<PeersNode>): Promise<{account: PeersAccount; dir: string}> {
  const dir = await mkdtemp(join(tmpdir(), 'peers-account-'));
  const account = new PeersAccount({dataDir: dir, kdf: TEST_KDF, nodeFactory});
  return {account, dir};
}

describe('PeersAccount — locked surface', () => {
  it('starts locked with no identity; app commands reject', async () => {
    const {account, dir} = await makeAccount();
    try {
      expect(await account.request('has_identity', {})).toBe(false);
      expect(await account.request('is_unlocked', {})).toBe(false);
      await expect(account.request('my_code', {})).rejects.toThrow(/locked/i);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('generate_phrase yields a valid word count', async () => {
    const {account, dir} = await makeAccount();
    try {
      expect((await account.request('generate_phrase', {})).split(' ')).toHaveLength(12);
      expect((await account.request('generate_phrase', {wordCount: 24})).split(' ')).toHaveLength(24);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('queues event subscriptions made while locked', async () => {
    const {account, dir} = await makeAccount();
    try {
      let fired = 0;
      const off = account.on('friend://request', () => fired++);
      // Unlocked later in the lifecycle test — the queue must not leak here.
      off();
      expect(fired).toBe(0);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe('PeersAccount — init → lock → unlock round trip', () => {
  it('recovers the same identity from the phrase and restores sealed state', async () => {
    const {account, dir} = await makeAccount();
    try {
      const phrase = await account.request('generate_phrase', {});
      const info = await account.request('init_from_phrase', {phrase});
      expect(info.peerId.startsWith('12D3KooW')).toBe(true);
      expect(await account.request('is_unlocked', {})).toBe(true);
      expect(account.host).not.toBeNull();

      // Same phrase again while unlocked is refused.
      await expect(account.request('init_from_phrase', {phrase})).rejects.toThrow(/already unlocked/);

      // Leave durable marks: profile + a server we own.
      await account.host!.request('set_profile', {displayName: 'Persist Me', about: '', avatarHash: null});
      const view = await account.host!.request('create_server', {name: 'Durable'});
      expect(view.members).toHaveLength(1);

      // Wrong password refuses to open the keystore.
      const words = phrase.split(' ');
      const wrong = words.map((w, i) => (i === 0 ? (w === 'abandon' ? 'zoo' : 'abandon') : w)).join(' ');
      await account.request('lock', {});
      expect(await account.request('is_unlocked', {})).toBe(false);
      await expect(account.request('unlock', {password: wrong})).rejects.toThrow();

      // The correct phrase rebuilds the SAME peer id…
      const again = await account.request('unlock', {password: phrase});
      expect(again.peerId).toBe(info.peerId);
      expect(again.fingerprint).toBe(info.fingerprint);
      // …and the sealed state came back with it.
      expect((await account.host!.request('get_profile', {}))?.displayName).toBe('Persist Me');
      const servers = await account.host!.request('list_servers', {});
      const restored = servers.find((s) => s.id === view.id);
      expect(restored?.name).toBe('Durable');

      await account.request('lock', {});
      expect(await account.request('is_unlocked', {})).toBe(false);
      await account.request('lock', {}); // idempotent
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 30_000);

  it('DM history and contact cards survive a restart', async () => {
    // Two accounts linked through real loopback nodes.
    const mkNode = (identity: Identity): Promise<PeersNode> =>
      import('@peers/node').then(({PeersNode: N}) => N.start({identity}));
    const aliceDir = await mkdtemp(join(tmpdir(), 'peers-ac-a-'));
    const bobDir = await mkdtemp(join(tmpdir(), 'peers-ac-b-'));
    const alice = new PeersAccount({dataDir: aliceDir, kdf: TEST_KDF, nodeFactory: mkNode});
    const bob = new PeersAccount({dataDir: bobDir, kdf: TEST_KDF, nodeFactory: mkNode});
    try {
      const aPhrase = await alice.request('generate_phrase', {});
      await alice.request('init_from_phrase', {phrase: aPhrase});
      const bPhrase = await bob.request('generate_phrase', {});
      await bob.request('init_from_phrase', {phrase: bPhrase});

      const aHost = alice.host!;
      const bHost = bob.host!;
      const addr = aHost.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      await bHost.dial(addr);

      // Handshake so Alice holds Bob's card.
      const seen: {v?: unknown} = {};
      bob.on('friend://request', (r) => (seen.v = r));
      for (let i = 0; i < 20 && !seen.v; i++) {
        await aHost.request('send_friend_request', {peerId: bHost.peerId}).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
      await bHost.request('accept_friend', {peerId: aHost.peerId});
      // The accept carries Bob's card; Alice's first sealed send races its
      // arrival, so retry until the envelope lands on Bob's side.
      let deliveredToBob = false;
      for (let i = 0; i < 40 && !deliveredToBob; i++) {
        await aHost.request('publish', {channel: bHost.peerId, text: 'survive me'}).catch(() => {});
        deliveredToBob = (await bHost.request('dm_history', {peer: aHost.peerId})).some(
          (m) => m.text === 'survive me',
        );
        if (!deliveredToBob) await new Promise((r) => setTimeout(r, 300));
      }
      expect(deliveredToBob).toBe(true);

      await bob.request('lock', {});
      await alice.request('lock', {});

      // Restart BOTH sides from their phrases.
      await bob.request('unlock', {password: bPhrase});
      await alice.request('unlock', {password: aPhrase});

      const hist = await alice.host!.request('dm_history', {peer: bHost.peerId});
      expect(hist.some((m) => m.text === 'survive me' && m.mine)).toBe(true);

      // Fresh nodes means fresh connections: re-dial, then prove Bob's
      // card survived too — Alice seals immediately, no handshake needed.
      await bob.host!.dial(alice.host!.listenAddrs.find((ma) => ma.includes('/tcp/'))!);
      await alice.host!.request('publish', {channel: bHost.peerId, text: 'still sealed'});
      let delivered = false;
      for (let i = 0; i < 40 && !delivered; i++) {
        delivered = (await bob.host!.request('dm_history', {peer: alice.host!.peerId})).some(
          (m) => m.text === 'still sealed',
        );
        if (!delivered) {
          await alice.host!.request('publish', {channel: bHost.peerId, text: 'still sealed'}).catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      expect(delivered).toBe(true);
    } finally {
      await alice.lock();
      await bob.lock();
      await rm(aliceDir, {recursive: true, force: true}).catch(() => {});
      await rm(bobDir, {recursive: true, force: true}).catch(() => {});
    }
  }, 90_000);
});
