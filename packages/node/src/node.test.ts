import { describe, expect, it } from 'vitest';
import { Identity } from '@peers/core';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(message);
}
