import {expect, it} from 'vitest';
import {Identity} from '@peers/core';
import {PeersNode} from './peers-node.js';

const TOPIC = 'peers/v1/tracer';

/**
 * Tracer bullet for the whole migration: two REAL nodes on loopback TCP,
 * dialed, subscribed to one gossipsub topic, exchanging a message. No
 * mocks — the network either works or this fails.
 */
it('two loopback nodes gossip end-to-end', async () => {
  const a = await PeersNode.start({identity: Identity.random()});
  const b = await PeersNode.start({identity: Identity.random()});

  try {
    // Core's peer-id derivation must agree with js-libp2p's own.
    expect(a.peerId.startsWith('12D3KooW')).toBe(true);

    const bAddr = b.listenAddrs.find((ma) => ma.includes('/tcp/'));
    expect(bAddr).toBeTruthy();

    await a.dial(bAddr!);
    await eventually(() => a.peerCount > 0, 'a never connected to b');

    a.subscribe(TOPIC);
    b.subscribe(TOPIC);
    // Give gossipsub a beat to propagate subscriptions into the mesh.
    await sleep(300);

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
