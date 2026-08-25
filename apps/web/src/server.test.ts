import {describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Identity, TEST_KDF} from '@peers/core';
import type {EventName} from '@peers/api';
import {startWebHost} from './server.js';
import WebSocket from 'ws';

/**
 * The WS transport adapter: the same command/event seam the desktop
 * shell gets over IPC, exercised over real sockets. Two hosts link via
 * their nodes so an event raised on one arrives on the other's socket.
 */

type Frame = {id?: number | string; ok?: boolean; ret?: unknown; error?: string; event?: EventName; payload?: unknown};

function wsClient(port: number): {
  socket: WebSocket;
  call: (cmd: string, args?: Record<string, unknown>) => Promise<Frame>;
  frames: Frame[];
  close(): void;
} {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const pending = new Map<number, (f: Frame) => void>();
  const frames: Frame[] = [];
  let nextId = 1;
  socket.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as Frame;
    if (f.event !== undefined) {
      frames.push(f);
      return;
    }
    const resolve = pending.get(f.id as number);
    if (resolve) {
      pending.delete(f.id as number);
      resolve(f);
    }
  });
  return {
    socket,
    frames,
    async call(cmd, args = {}) {
      const id = nextId++;
      const reply = new Promise<Frame>((resolve) => pending.set(id, resolve));
      socket.send(JSON.stringify({id, cmd, args}));
      return reply;
    },
    close() {
      socket.close();
    },
  };
}

async function opened(client: ReturnType<typeof wsClient>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.socket.once('open', resolve);
    client.socket.once('error', reject);
  });
}

describe('web host — HTTP + WS bridge of @peers/api', () => {
  it('serves the status page and answers commands over the socket', async () => {
    const web = await startWebHost({identity: Identity.random()});
    try {
      // Static fallback page while no renderer build exists.
      const res = await fetch(`http://127.0.0.1:${web.port}/`);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('Peers web host');

      const client = wsClient(web.port);
      await opened(client);
      try {
        const code = await client.call('my_code');
        expect(code.ok).toBe(true);
        expect(code.ret).toMatchObject({formatted: expect.stringMatching(/\d{4} \d{4} \d{4}/)});

        const status = await client.call('net_status');
        expect((status.ret as {listenAddrs: string[]}).listenAddrs.length).toBeGreaterThan(0);

        const bad = await client.call('lookup_code', {code: 'nope'});
        expect(bad.ok).toBe(false);
        expect(String(bad.error)).toMatch(/12 digits/);
      } finally {
        client.close();
      }
    } finally {
      await web.close();
    }
  }, 30_000);

  it('pushes engine events across sockets between two linked hosts', async () => {
    const aWeb = await startWebHost({identity: Identity.random()});
    const bWeb = await startWebHost({identity: Identity.random()});
    try {
      const aHost = aWeb.host_!;
      const bHost = bWeb.host_!;
      const addr = aHost.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      await bHost.dial(addr);

      const bClient = wsClient(bWeb.port);
      await opened(bClient);
      const aClient = wsClient(aWeb.port);
      await opened(aClient);
      try {
        // Alice's friend request travels her node → bob's node → bob's socket.
        for (let i = 0; i < 20; i++) {
          await aClient.call('send_friend_request', {peerId: bWeb.peerId});
          if (bClient.frames.some((f) => f.event === 'friend://request')) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        const evt = bClient.frames.find((f) => f.event === 'friend://request');
        expect(evt).toBeTruthy();
        expect((evt!.payload as {peerId: string}).peerId).toBe(aWeb.peerId);
      } finally {
        aClient.close();
        bClient.close();
      }
    } finally {
      await Promise.allSettled([aWeb.close(), bWeb.close()]);
    }
  }, 40_000);

  it('account mode: starts locked, unlocks over the socket, persists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peers-web-acct-'));
    try {
      // First boot: no keystore yet → locked; the renderer drives login.
      let thePhrase = '';
      {
        const web1 = await startWebHost({accountDir: dir, kdf: TEST_KDF});
        try {
          const c1 = wsClient(web1.port);
          await opened(c1);
          expect((await c1.call('has_identity')).ret).toBe(false);
          expect((await c1.call('is_unlocked')).ret).toBe(false);
          const locked = await c1.call('my_code');
          expect(locked.ok).toBe(false);

          thePhrase = (await c1.call('generate_phrase', {wordCount: 12})).ret as string;
          const info = (await c1.call('init_from_phrase', {phrase: thePhrase})).ret as {peerId: string};
          expect(info.peerId.startsWith('12D3KooW')).toBe(true);
          expect((await c1.call('is_unlocked')).ret).toBe(true);
          expect((await c1.call('my_code')).ok).toBe(true);
          c1.close();
        } finally {
          await web1.close(); // lock flushes sealed state to disk
        }
      }

      // Second boot on the same dir: identity known, still locked until
      // the correct phrase arrives — and it rebuilds the same peer id.
      {
        const web2 = await startWebHost({accountDir: dir, kdf: TEST_KDF});
        try {
          const c2 = wsClient(web2.port);
          await opened(c2);
          expect((await c2.call('has_identity')).ret).toBe(true);
          expect((await c2.call('is_unlocked')).ret).toBe(false);
          expect((await c2.call('unlock', {password: 'not the phrase'})).ok).toBe(false);
          const again = (await c2.call('unlock', {password: thePhrase})).ret as {peerId: string};
          expect(again.peerId.startsWith('12D3KooW')).toBe(true);
          c2.close();
        } finally {
          await web2.close();
        }
      }
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 30_000);
});
