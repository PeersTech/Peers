import {describe, expect, it} from 'vitest';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  isShareable,
  loadOrCreateIdentity,
  runBackbone,
  shareableLines,
} from './main.js';

describe('backbone identity (plaintext, 0600)', () => {
  it('creates once and restores the same identity after', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peers-cli-'));
    const path = join(dir, 'peers', 'node-identity.bin');
    try {
      const first = await loadOrCreateIdentity(path);
      const perms = (await stat(path)).mode & 0o777;
      expect(perms).toBe(0o600);
      const second = await loadOrCreateIdentity(path);
      expect(second.peerId).toBe(first.peerId);
      expect(second.marshal()).toEqual(first.marshal());
      // The blob is the raw marshal format, not JSON.
      const raw = new Uint8Array(await readFile(path));
      expect(raw.length).toBe(64);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe('shareable address filtering', () => {
  const peer = '12D3KooWABC';

  it('drops loopback and unspecified listeners', () => {
    expect(isShareable('/ip4/127.0.0.1/tcp/4001', false)).toBe(false);
    expect(isShareable('/ip4/0.0.0.0/tcp/4001', false)).toBe(false);
  });

  it('keeps LAN addrs when nothing is announced', () => {
    expect(isShareable('/ip4/192.168.1.10/tcp/4001', false)).toBe(true);
    const lines = shareableLines(
      ['/ip4/127.0.0.1/tcp/4001', '/ip4/192.168.1.10/tcp/4001'],
      false,
      peer,
    );
    expect(lines).toEqual([`/ip4/192.168.1.10/tcp/4001/p2p/${peer}`]);
  });

  it('hides RFC1918 noise when a public address is announced', () => {
    expect(isShareable('/ip4/10.0.0.5/tcp/4001', true)).toBe(false);
    expect(isShareable('/ip4/172.16.9.9/tcp/4001', true)).toBe(false);
    expect(isShareable('/ip4/203.0.113.7/tcp/4001', true)).toBe(true);
  });
});

describe('runBackbone', () => {
  it('starts a relay-tier node — discovery via directory, seed hidden by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peers-cli-run-'));
    try {
      const lines: string[] = [];
      // Port 0 lets the OS pick — only tests use ephemeral backbone ports.
      const backbone = await runBackbone({
        env: {},
        dataDir: dir,
        portOverride: 0,
        onLine: (l) => lines.push(l),
      });
      const backboneId = backbone.peerId;
      try {
        expect(backboneId.startsWith('12D3KooW')).toBe(true);
        expect(lines.some((l) => l.includes(`peers node peer id: ${backboneId}`))).toBe(true);
        // Seed line hidden by default — directory handles discovery.
        expect(lines.some((l) => l.includes('PEERS_NODES='))).toBe(false);
        expect(lines.some((l) => l.includes('directory.peers.dpdns.org'))).toBe(true);
      } finally {
        await backbone.stop();
      }

      // Explicit --show-seed prints it for manual override.
      const seeded: string[] = [];
      const withSeed = await runBackbone({
        env: {},
        dataDir: dir,
        portOverride: 0,
        showSeed: true,
        onLine: (l) => seeded.push(l),
      });
      try {
        expect(seeded.some((l) => l.includes('PEERS_NODES=') && l.endsWith(`/p2p/${withSeed.peerId}`))).toBe(true);
        expect(withSeed.peerId).toBe(backboneId);
      } finally {
        await withSeed.stop();
      }

      // A third instance over the same data dir restores the identity.
      const again = await runBackbone({env: {}, dataDir: dir, portOverride: 0, onLine: () => {}});
      try {
        expect(again.peerId).toBe(backboneId);
      } finally {
        await again.stop();
      }
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 30_000);
});
