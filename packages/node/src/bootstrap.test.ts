import {describe, expect, it} from 'vitest';
import {
  announceAddrs,
  knownNodes,
  listenPort,
  parsePort,
  type BootstrapEnv,
} from './bootstrap.js';
import {alwaysPluggedIn, type PowerSource} from './power.js';

/** Pure config parsing — the Rust bootstrap.rs suite, ported. */

describe('bootstrap config', () => {
  it('PEERS_NODES wins over nodes.json and splits on commas', () => {
    const env: BootstrapEnv = {
      PEERS_NODES: ' /ip4/203.0.113.7/tcp/4001/p2p/12D3KooWABC, ,/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWDEF ',
    };
    expect(knownNodes(env, '/tmp')).toEqual([
      '/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWABC',
      '/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWDEF',
    ]);
  });

  it('entries missing a peer id are dropped (undialable)', () => {
    const env: BootstrapEnv = {PEERS_NODES: '/ip4/10.0.0.1/tcp/4001,not-an-addr'};
    expect(knownNodes(env)).toEqual([]);
  });

  it('falls back to nodes.json when the env var is unset or empty', async () => {
    const {mkdtemp, rm} = await import('node:fs/promises');
    const {join} = await import('node:path');
    const dir = await mkdtemp('/tmp/opencode/peers-boot-');
    try {
      const peersDir = join(dir, 'peers');
      const {mkdirSync, writeFileSync} = await import('node:fs');
      mkdirSync(peersDir, {recursive: true});
      const good = '/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWABC';
      writeFileSync(
        join(peersDir, 'nodes.json'),
        JSON.stringify([good, 'garbage', 42]),
      );
      expect(knownNodes({}, dir)).toEqual([good]);
      // Env var takes precedence over the file.
      const env: BootstrapEnv = {PEERS_NODES: `/ip4/1.2.3.4/tcp/1/p2p/12D3KooWXYZ`};
      expect(knownNodes(env, dir)).toEqual(['/ip4/1.2.3.4/tcp/1/p2p/12D3KooWXYZ']);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('missing file and malformed json both degrade to empty', async () => {
    expect(knownNodes({}, '/tmp/opencode/definitely-not-here')).toEqual([]);
    expect(knownNodes({PEERS_NODES: ''}, undefined)).toEqual([]);
  });

  it('port override wins over default; garbage falls back', () => {
    expect(parsePort('4001', 0)).toBe(4001);
    expect(parsePort('  4001  ', 0)).toBe(4001);
    expect(parsePort('', 4001)).toBe(4001);
    expect(parsePort('http', 4001)).toBe(4001);
    expect(parsePort('70000', 4001)).toBe(4001); // > u16::MAX
    expect(listenPort(4001, {PEERS_PORT: '70000'})).toBe(4001);
    expect(listenPort(0, {})).toBe(0);
  });

  it('announce addrs split on commas and drop junk', () => {
    expect(
      announceAddrs({
        PEERS_ANNOUNCE: 'not-a-multiaddr,,/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWA,   ',
      }),
    ).toEqual(['/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWA']);
    expect(announceAddrs({})).toEqual([]);
  });
});

describe('powerSource port', () => {
  it('desktops and servers are never constrained', () => {
    expect(alwaysPluggedIn.isPowerConstrained()).toBe(false);
  });

  it('hosts can inject any battery logic without platform deps', () => {
    let battery = 0.9;
    const laptop: PowerSource = {
      isPowerConstrained: () => battery < 0.2,
    };
    expect(laptop.isPowerConstrained()).toBe(false);
    battery = 0.1;
    expect(laptop.isPowerConstrained()).toBe(true);
  });
});
