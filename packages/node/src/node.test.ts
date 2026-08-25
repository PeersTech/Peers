import { describe, expect, it } from 'vitest';
import {
  FriendNotice,
  Identity,
  encodeFriendNotice,
  friendRequestTopic,
  shortCode,
} from '@peers/core';
import { PeersNode, MAX_BLOB_SIZE } from './peers-node.js';

const TOPIC = 'peers/v1/tracer';

/**
 * Tracer bullet for the whole migration: two REAL nodes on loopback TCP,
 * dialed, subscribed to one gossipsub topic, exchanging a message. No
 * mocks — the network either works or this fails.
 */
it('two loopback nodes gossip end-to-end', async () => {
  const a = await PeersNode.start({ identity: Identity.random() });
  const b = await PeersNode.start({ identity: Identity.random() });

  try {
    expect(a.peerId.startsWith('12D3KooW')).toBe(true);

    const bAddr = b.listenAddrs.find((ma) => ma.includes('/tcp/'));
    expect(bAddr).toBeTruthy();

    await a.dial(bAddr!);
    await eventually(() => a.peerCount > 0, 'a never connected to b');

    a.subscribe(TOPIC);
    b.subscribe(TOPIC);
    // DHT adds a beat to mesh formation vs the pre-DHT 300 ms.
    await sleep(1200);

    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('b never received the message')), 10_000);
      b.onMessage((msg) => {
        clearTimeout(timer);
        resolve(new TextDecoder().decode(msg.data));
      });
    });

    await a.publish(TOPIC, new TextEncoder().encode('gm from a'));
    expect(await received).toBe('gm from a');
  } finally {
    await Promise.allSettled([a.stop(), b.stop()]);
  }
});

describe('DHT blobs — kad provide/get + request-response transfer, 64 KiB cap', () => {
  it('park/fetch round trip between two nodes', async () => {
    const a = await PeersNode.start({ identity: Identity.random() });
    const b = await PeersNode.start({ identity: Identity.random() });
    try {
      const bAddr = b.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      await a.dial(bAddr);
      await eventually(() => a.peerCount > 0, 'nodes never connected');

      const payload = new TextEncoder().encode('hello blob — ' + 'x'.repeat(200));
      const hash = await a.parkBlob(payload);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      // Fetch locally on the parker is immediate (store hit).
      const local = await a.fetchBlob(hash);
      expect(new TextDecoder().decode(local)).toBe(new TextDecoder().decode(payload));

      // Remote fetch rides DHT providers → /peers/blob/1.0.0 stream.
      const fetched = await b.fetchBlob(hash);
      expect(Array.from(fetched)).toEqual(Array.from(payload));
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
    }
  });

  it('rejects blobs larger than 64 KiB', async () => {
    const a = await PeersNode.start({ identity: Identity.random() });
    try {
      const big = new Uint8Array(MAX_BLOB_SIZE + 1);
      await expect(a.parkBlob(big)).rejects.toThrow(/too large/i);
    } finally {
      await a.stop();
    }
  });

  it('fetches missing blob throws', async () => {
    const a = await PeersNode.start({ identity: Identity.random() });
    const b = await PeersNode.start({ identity: Identity.random() });
    try {
      const bAddr = b.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      await a.dial(bAddr);
      await eventually(() => a.peerCount > 0, 'nodes never connected');
      const fake = '00'.repeat(32);
      await expect(a.fetchBlob(fake)).rejects.toThrow();
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
    }
  });

  it('local deduplication: parking same bytes twice yields same hash', async () => {
    const a = await PeersNode.start({ identity: Identity.random() });
    try {
      const data = new TextEncoder().encode('dedup me');
      const h1 = await a.parkBlob(data);
      const h2 = await a.parkBlob(data);
      expect(h1).toBe(h2);
      const got = await a.fetchBlob(h1);
      expect(Array.from(got)).toEqual(Array.from(data));
    } finally {
      await a.stop();
    }
  });
});

describe('friend codes end-to-end (M8/M17) — publish → resolve → mutual accept', () => {
  it('derives the same code as the core domain function', async () => {
    const identity = Identity.random();
    const a = await PeersNode.start({ identity });
    try {
      expect(a.code).toBe(shortCode(identity.peerIdBytes));
    } finally {
      await a.stop();
    }
  });

  it('lookup rejects malformed codes', async () => {
    const a = await PeersNode.start({ identity: Identity.random() });
    try {
      await expect(a.lookupCode('123')).rejects.toThrow(/12 digits/);
      await expect(a.lookupCode('no-digits-at-all')).rejects.toThrow();
    } finally {
      await a.stop();
    }
  });

  it('resolves a published code via DHT and completes the mutual accept', async () => {
    const aId = Identity.random();
    const bId = Identity.random();
    const a = await PeersNode.start({ identity: aId });
    const b = await PeersNode.start({ identity: bId });
    try {
      const bAddr = b.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      await a.dial(bAddr);
      await eventually(() => a.peerCount > 0 && b.peerCount > 0, 'nodes never connected');

      // Both announce their codes; a resolves b's through the DHT.
      await Promise.all([a.publishCode(), b.publishCode()]);
      let resolved: string[] = [];
      await eventuallyAsync(
        async () => {
          resolved = await a.lookupCode(b.code);
          return resolved.includes(b.peerId);
        },
        'a never resolved b from its code',
      );
      // The code is a lookup hint only: it must never resolve to *us*.
      expect(resolved).not.toContain(a.peerId);

      // Full handshake: request → accept, both signed and verified. Early
      // publishes can drop while the per-topic mesh forms, so retry sends
      // until the verified notice arrives.
      const gotRequest = friendNotice(b, 'request', a.peerId);
      const gotAccept = friendNotice(a, 'accept', b.peerId);
      await sendUntil(() => a.sendFriendRequest(b.peerId), gotRequest, 'b never received a valid request');
      const req = await gotRequest;
      expect(req.card.x25519Pub).toEqual(aId.xPublic());

      await sendUntil(() => b.acceptFriend(req.from), gotAccept, 'a never received an accept');
      const acc = await gotAccept;
      expect(acc.card.x25519Pub).toEqual(bId.xPublic());
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
    }
  });

  it('drops notices addressed to someone else', async () => {
    const aId = Identity.random();
    const a = await PeersNode.start({ identity: aId });
    const b = await PeersNode.start({ identity: Identity.random() });
    try {
      const bAddr = b.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      await a.dial(bAddr);
      await eventually(() => a.peerCount > 0 && b.peerCount > 0, 'nodes never connected');

      // Both mesh on a third party's request topic so the notice really is
      // delivered — only the recipient binding may keep b from acting on it.
      const stranger = Identity.random();
      const topic = friendRequestTopic(stranger.peerId);
      a.subscribe(topic);
      b.subscribe(topic);
      await sleep(1200);

      let acted = false;
      const off = b.onFriendNotice(() => { acted = true; });
      try {
        // Validly signed, but bound `to` the stranger — not to b.
        const notice = FriendNotice.sign(aId, 'request', stranger.peerId);
        await a.publish(topic, encodeFriendNotice(notice));
        await sleep(1500);
      } finally {
        off();
      }
      expect(acted).toBe(false);
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
    }
  });
});

describe('relay mesh + capacity tiers (M9/M12)', () => {
  it('a node-tier relay carries traffic between citizens that only know it', async () => {
    const r = await PeersNode.start({
      identity: Identity.random(),
      relayRole: 'node',
    });
    const a = await PeersNode.start({identity: Identity.random()});
    // b listens nowhere: nobody can dial it directly, it can only be
    // reached (and reach others) through circuits.
    const b = await PeersNode.start({identity: Identity.random(), listenAddrs: []});
    try {
      const rAddr = r.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
      const circuitToA = `${rAddr}/p2p-circuit/p2p/${a.peerId}`;

      await a.dial(rAddr);
      await eventually(() => a.peerCount > 0, 'a never connected to the relay');

      // Reserve a slot so b can reach a through the relay.
      await a.reserveOnRelay(rAddr);
      expect(a.reservationCount).toBeGreaterThan(0);

      await b.dial(circuitToA);
      await eventually(() => b.peerCount > 0 && a.peerCount >= 2, 'circuit never established');

      // Gossip flows across the circuit: a hears from b.
      const got = new Promise<string>((resolve) => {
        a.onMessage((msg) => {
          if (msg.topic === TOPIC) resolve(new TextDecoder().decode(msg.data));
        });
      });
      a.subscribe(TOPIC);
      b.subscribe(TOPIC);
      await sleep(1200);
      await sendUntil(() => b.publish(TOPIC, new TextEncoder().encode('via relay')), got, 'no message over the circuit');
      expect(await got).toBe('via relay');
    } finally {
      await Promise.allSettled([r.stop(), a.stop(), b.stop()]);
    }
  }, 40_000);

  it('battery guard downgrades a node tier to citizen', async () => {
    const n = await PeersNode.start({
      identity: Identity.random(),
      relayRole: 'node',
      powerSource: {isPowerConstrained: () => true}, // laptop on battery
    });
    try {
      expect(n.relayRole).toBe('citizen'); // must not drain itself relaying
    } finally {
      await n.stop();
    }
  });

  it('off disables the relay transport entirely', async () => {
    const n = await PeersNode.start({
      identity: Identity.random(),
      relayRole: 'off',
    });
    try {
      expect(n.relayRole).toBe('off');
      // No circuit transport: dialing any /p2p-circuit addr is impossible.
      const other = await PeersNode.start({identity: Identity.random(), relayRole: 'node'});
      try {
        const addr = other.listenAddrs.find((ma) => ma.includes('/tcp/'))!;
        await expect(n.dial(`${addr}/p2p-circuit`)).rejects.toThrow();
      } finally {
        await other.stop();
      }
    } finally {
      await n.stop();
    }
  }, 30_000);
});

/** Retry `send` until `waiter` resolves — gossipsub needs a beat to graft a
 * freshly subscribed topic into the mesh, and early publishes vanish. */
async function sendUntil(send: () => Promise<void>, waiter: Promise<unknown>, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await send();
    const won = await Promise.race([waiter.then(() => true), sleep(700).then(() => false)]);
    if (won) return;
  }
  throw new Error(message);
}

function friendNotice(
  node: PeersNode,
  kind: string,
  from: string,
): Promise<{ kind: string; from: string; card: { x25519Pub: Uint8Array } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${kind} notice arrived`)), 20_000);
    node.onFriendNotice((n) => {
      if (n.kind === kind && n.from === from) {
        clearTimeout(timer);
        resolve(n);
      }
    });
  });
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function eventuallyAsync(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
