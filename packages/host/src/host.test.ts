import {describe, expect, it} from 'vitest';
import {Identity} from '@peers/core';
import {PeersHost} from './host.js';

/**
 * Two real hosts over real loopback nodes: the whole M8/M14 wire story —
 * friend handshakes become DM keys, sealed envelopes cross topics, and
 * an invite turns into a signed member list that carries profiles.
 */

async function linkedPair(): Promise<[PeersHost, PeersHost]> {
  const a = await PeersHost.start({identity: Identity.random()});
  const b = await PeersHost.start({identity: Identity.random()});
  const addr = (await a.request('net_status', {})).listenAddrs.find((ma) => ma.includes('/tcp/'))!;
  await b.dial(addr);
  await eventually(() => a.request('net_status', {}).then((s) => s.peers > 0));
  return [a, b];
}

describe('PeersHost — friend handshake → sealed DMs', () => {
  it('delivers sealed DMs both directions after accept', async () => {
    const [a, b] = await linkedPair();
    try {
      const seenRequest: {v?: {peerId: string; displayName: string}} = {};
      const requestSeen = new Promise<{peerId: string; displayName: string}>((resolve) =>
        b.on('friend://request', (r) => {
          seenRequest.v = r;
          resolve(r);
        }),
      );
      // Mesh formation takes a beat; retry the publish until b sees it.
      await eventually(() => {
        if (!seenRequest.v) {
          void a.request('send_friend_request', {peerId: b.peerId}).catch(() => {});
          return false;
        }
        return true;
      });

      const req = await requestSeen;
      expect(req.peerId).toBe(a.peerId);
      expect(req.displayName).toBe(''); // no profile yet — still delivered

      // Bob accepts; the accept notice is what delivers his card to Alice,
      // so her first sealed send may race it — retry until it lands.
      await eventually(async () => {
        try {
          await b.request('accept_friend', {peerId: a.peerId});
        } catch {
          /* retry */
        }
        await a.request('publish', {channel: b.peerId, text: 'gm bob'}).catch(() => {});
        return dmHas(b, a.peerId, 'gm bob');
      });
      expect(await dmHas(b, a.peerId, 'gm bob')).toBe(true);

      await b.request('publish', {channel: a.peerId, text: 'gm alice'});
      await eventually(() => dmHas(a, b.peerId, 'gm alice'));

      const aHist = await a.request('dm_history', {peer: b.peerId});
      expect(aHist.find((m) => m.text === 'gm bob')?.mine).toBe(true); // a sent it
      expect(aHist.find((m) => m.text === 'gm alice')?.mine).toBe(false); // b sent it
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
    }
  }, 40_000);

  it('carries display names on friend requests once a profile is set', async () => {
    const a = await PeersHost.start({identity: Identity.random()});
    const b = await PeersHost.start({identity: Identity.random()});
    try {
      await b.dial(a.listenAddrs.find((ma) => ma.includes('/tcp/'))!);
      await eventually(() => a.request('online_peers', {}).then((p) => p.length > 0));
      await a.request('set_profile', {displayName: 'Alice Prime', about: '', avatarHash: null});

      const seen: {v?: {displayName: string}} = {};
      const seenPromise = new Promise<{displayName: string}>((resolve) =>
        b.on('friend://request', (r) => {
          seen.v = r;
          resolve(r);
        }),
      );
      await eventually(() => {
        if (!seen.v) {
          void a.request('send_friend_request', {peerId: b.peerId}).catch(() => {});
          return false;
        }
        return true;
      });
      expect(await seenPromise).toMatchObject({displayName: 'Alice Prime'});

      // Acceptance caches the sender's profile for the contact list.
      await b.request('accept_friend', {peerId: a.peerId});
      await eventually(
        () => b.request('contact_profiles', {}).then((p) => p[a.peerId]?.displayName === 'Alice Prime'),
      );
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
    }
  }, 40_000);
});

describe('PeersHost — servers over gossipsub (M14)', () => {
  it('invite → join notice → signed list with riding profile → channel chat', async () => {
    const owner = await PeersHost.start({identity: Identity.random()});
    const joiner = await PeersHost.start({identity: Identity.random()});
    try {
      await owner.request('set_profile', {displayName: 'Owner', about: 'the boss', avatarHash: null});
      await joiner.request('set_profile', {displayName: 'Joiner', about: '', avatarHash: null});

      const view = await owner.request('create_server', {name: 'HQ'});
      expect(view.members).toHaveLength(1);
      expect(view.epoch).toBe(0);

      const inviteJson = await owner.request('create_invite', {serverId: view.id});
      // The engine re-announces until the owner's list admits us.
      const joined = await joiner.request('join_server', {inviteJson, name: 'joiner'});
      expect(joined.pending).toBe(false);
      const jm = joined.members.find((m) => m.peerId === joiner.peerId)!;
      expect(jm.role).toBe('member');
      expect(jm.profile?.displayName).toBe('Joiner');

      // Owner converges on the same signed state (profile riding the list).
      await eventually(async () => {
        const s = (await owner.request('list_servers', {})).find((x) => x.id === view.id)!;
        return (
          s.memberCount === 2 &&
          s.members.find((m) => m.peerId === joiner.peerId)?.profile?.displayName === 'Joiner'
        );
      });

      // Channel chat, verified and historized on both ends.
      await eventually(async () => {
        try {
          await joiner.request('publish_channel', {serverId: view.id, channel: 'general', text: 'hello HQ'});
          return true;
        } catch {
          return false; // mesh may still be forming
        }
      });
      await eventually(async () =>
        (await owner.request('server_history', {serverId: view.id, channel: 'general'})).length > 0,
      );
      const oh = await owner.request('server_history', {serverId: view.id, channel: 'general'});
      expect(oh[0]).toMatchObject({from: joiner.peerId, text: 'hello HQ', channel: 'general'});

      // ACL: admin-only channel rejects member writes locally.
      await owner.request('set_channel', {
        serverId: view.id,
        name: 'ops',
        topic: '',
        readMin: 'member',
        writeMin: 'admin',
      });
      await expect(
        joiner.request('publish_channel', {serverId: view.id, channel: 'ops', text: 'nope'}),
      ).rejects.toThrow(/not allowed/i);

      // Key rotation propagates through the chain; members follow.
      const rotated = new Promise<number>((resolve) =>
        joiner.on('server://list', (v) => v.epoch >= 1 && resolve(v.epoch)),
      );
      await owner.request('rotate_key', {serverId: view.id});
      await eventually(
        () => joiner.request('list_servers', {}).then((ls) => (ls.find((s) => s.id === view.id)?.epoch ?? 0) >= 1),
      );
      expect(await rotated).toBeGreaterThanOrEqual(1);
    } finally {
      await Promise.allSettled([owner.stop(), joiner.stop()]);
    }
  }, 60_000);

  it('ignores joins whose invite nonce was already used', async () => {
    const owner = await PeersHost.start({identity: Identity.random()});
    try {
      const addr = owner.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      const view = await owner.request('create_server', {name: 'HQ'});
      const inviteJson = await owner.request('create_invite', {serverId: view.id});

      const first = await PeersHost.start({identity: Identity.random()});
      try {
        await first.dial(addr);
        const joined = await first.request('join_server', {inviteJson, name: 'first'});
        expect(joined.pending).toBe(false);
        await eventually(
          () => owner.request('list_servers', {}).then((ls) => ls.find((s) => s.id === view.id)?.memberCount === 2),
        );

        // Replay: a different peer presents the SAME spent invite.
        const second = await PeersHost.start({identity: Identity.random()});
        try {
          await second.dial(addr);
          await second.request('join_server', {inviteJson, name: 'replay'}).catch(() => {});
          await sleep(2000);
          const after = (await owner.request('list_servers', {})).find((s) => s.id === view.id)!;
          expect(after.memberCount).toBe(2); // replay ignored
        } finally {
          await second.stop();
        }
      } finally {
        await first.stop();
      }
    } finally {
      await owner.stop();
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------
async function dmHas(host: PeersHost, peer: string, text: string): Promise<boolean> {
  const hist = await host.request('dm_history', {peer});
  return hist.some((m) => m.text === text);
}

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error('eventually: condition never held');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
