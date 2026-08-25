import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {dirname, join} from 'node:path';
import {Identity} from '@peers/core';
import {
  DEFAULT_DIRECTORIES,
  announceAddrs,
  listenPort,
  resolveBootstrapNodes,
  type BootstrapEnv,
} from '@peers/node';
import {b64encode} from '@peers/core';
import {c, paintLine} from './ui.js';

/**
 * Headless backbone node (M11 parity with `backend/src/node.rs`).
 *
 * A `--node` process has no user secrets — it never decrypts anything —
 * so its routing identity lives plaintext at 0600, unlike the GUI
 * keystore. The port is fixed (4001 unless PEERS_PORT says otherwise)
 * because clients hold the address in nodes.json; an OS-assigned port
 * would silently invalidate every one of those configs on restart.
 */

export interface BackboneOptions {
  env?: BootstrapEnv;
  dataDir?: string;
  /** Ephemeral port for tests; beats PEERS_PORT and the 4001 default. */
  portOverride?: number;
  onLine?: (line: string) => void;
  /** Print the manual PEERS_NODES seed line (hidden by default — directory does it). */
  showSeed?: boolean;
}

export interface Backbone {
  peerId: string;
  port: number;
  shareable: string[];
  stop(): Promise<void>;
}

/** Loads or creates the plaintext routing identity. */
export async function loadOrCreateIdentity(path: string): Promise<Identity> {
  if (existsSync(path)) {
    const bytes = await readFile(path);
    return Identity.unmarshal(new Uint8Array(bytes));
  }
  const id = Identity.random();
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, id.marshal(), {mode: 0o600});
  return id;
}

/**
 * True when a listener is worth handing to another machine. Loopback and
 * `0.0.0.0` are real listeners but useless in someone else's config. With
 * a declared public address (`PEERS_ANNOUNCE`), RFC1918 listeners are
 * noise next to the real one; without one, private addresses are kept —
 * a same-LAN setup is a real working configuration.
 */
export function isShareable(addr: string, announced: boolean): boolean {
  if (addr.includes('/127.0.0.1/') || addr.startsWith('/ip4/0.0.0.0/') || addr.includes('/0.0.0.0/')) {
    return false;
  }
  if (!announced && addr.startsWith('/ip4/')) return true; // keep LAN addrs
  const m = /\/ip4\/(\d+)\.(\d+)\.(\d+)\.(\d+)\//.exec(addr);
  if (!m) return !addr.startsWith('/ip4/'); // dns/other schemes pass
  const [a, b] = [Number(m[1]), Number(m[2])];
  const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  return !isPrivate;
}

/** Shareable listen/announce lines formatted for clients to paste. */
export function shareableLines(addrs: string[], announced: boolean, peerId: string): string[] {
  return addrs.filter((a) => isShareable(a, announced)).map((a) => `${a}/p2p/${peerId}`);
}

/**
 * rust-libp2p expands a `0.0.0.0` listener into concrete per-interface
 * addresses; js-libp2p keeps the wildcard literal. Expand it ourselves so
 * the printed lines are actually dialable (and the loopback/wildcard ones
 * never masquerade as shareable).
 */
export function expandListenAddrs(listen: string[]): string[] {
  const out: string[] = [];
  for (const addr of listen) {
    const m = /^\/ip4\/0\.0\.0\.0\/tcp\/(\d+)$/.exec(addr);
    if (!m) {
      out.push(addr);
      continue;
    }
    for (const infos of Object.values(networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        out.push(`/ip4/${info.address}/tcp/${m[1]}`);
      }
    }
    if (!out.some((a) => a.endsWith(`/tcp/${m[1]}`))) {
      out.push(`/ip4/127.0.0.1/tcp/${m[1]}`); // no external NIC — local only
    }
  }
  return out;
}

/** Runs the backbone node until `stop()`. Never throws for network hiccups. */
export async function runBackbone(opts: BackboneOptions = {}): Promise<Backbone> {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? env.XDG_CONFIG_HOME ?? `${env.HOME ?? '.'}/.config`;
  const identityPath = join(dataDir, 'peers', 'node-identity.bin');
  const log = opts.onLine ?? ((line: string): void => {
    process.stdout.write(`${paintLine(line)}\n`);
  });

  // Directories first: live list, cached to disk, seeds as fallback.
  const nodes = await resolveBootstrapNodes({env, configDir: dataDir});
  const port = opts.portOverride ?? listenPort(4001, env);
  const identity = await loadOrCreateIdentity(identityPath);

  // ── pretty startup banner (tests inject onLine so they see raw lines too) ──
  log('');
  log(c.bold(c.yellow('  peers  •  backbone node')));
  log(c.dim('  ─────────────────────────'));
  log(`peers node peer id: ${identity.peerId}`);
  log(`peers node identity: ${identityPath}`);
  log(`${c.dim('  port      ')}${c.yellow(String(port))}  ${c.dim('•')}  ${c.green('relay tier: node')}  ${c.dim('•')}  ${c.cyan('directory.peers.dpdns.org')} ${c.dim('(auto)')}`);
  log('');

  const {PeersNode} = await import('@peers/node');
  const announce = announceAddrs(env);
  const announced = announce.length > 0;

  const node = await PeersNode.start({
    identity,
    listenAddrs: [`/ip4/0.0.0.0/tcp/${port}`],
    relayRole: 'node',
    bootstrapAddrs: nodes,
  });

  // Dial + reserve on every known always-on node so this node works as a
  // rendezvous for hole-punching even when it itself sits behind NAT.
  for (const ma of nodes) {
    log(`dialing known node: ${ma}`);
    try {
      await node.dial(ma);
      await node.reserveOnRelay(ma);
    } catch {
      /* the mesh heals itself */
    }
  }

  // rust-libp2p reports concrete per-interface listeners; js-libp2p hides
  // them behind advertisement filtering, so read the raw listeners and
  // filter for shareability here.
  const listenAddrs = expandListenAddrs(await node.rawListenAddrs());
  for (const line of shareableLines(listenAddrs, announced, node.peerId)) {
    log(`listening: ${line}`);
  }
  for (const line of shareableLines(announce, announced, node.peerId)) {
    log(`announcing: ${line}`);
  }
  const showSeed = opts.showSeed ?? env.PEERS_SHOW_SEED === '1';
  if (showSeed && listenAddrs.length > 0) {
    const seed = shareableLines(listenAddrs, announced, node.peerId)[0] ?? shareableLines(announce, announced, node.peerId)[0];
    if (seed) log(`seed (manual override): PEERS_NODES=${seed}`);
  }
  log('peers node is up. discovery via directory.peers.dpdns.org — no client config needed.');

  // Keep this node's address fresh in the directory so fresh installs find it.
  // Best-effort: directory may not be deployed yet; the fallback seeds still work.
  const heartbeatAddr = shareableLines(listenAddrs, announced, node.peerId)[0] ?? shareableLines(announce, announced, node.peerId)[0];
  if (heartbeatAddr) startDirectoryHeartbeat(identity, heartbeatAddr);

  return {
    peerId: node.peerId,
    port,
    shareable: shareableLines(listenAddrs, announced, node.peerId),
    stop: async () => {
      stopDirectoryHeartbeat();
      await node.stop();
    },
  };
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startDirectoryHeartbeat(identity: Identity, multiaddr: string): void {
  const tick = async (): Promise<void> => {
    const ts = Date.now();
    const msg = `peers-directory:v1:heartbeat:${identity.peerId}:${ts}`;
    const sig = b64encode(identity.sign(new TextEncoder().encode(msg)));
    const body = JSON.stringify({peerId: identity.peerId, ts, sig, multiaddr});
    for (const base of DEFAULT_DIRECTORIES) {
      try {
        await fetch(`${base.replace(/\/$/, '')}/v1/heartbeat`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body,
        });
      } catch {
        /* directory not deployed / offline — fallback seeds keep the mesh alive */
      }
    }
  };
  void tick();
  heartbeatTimer = setInterval(() => void tick(), 10 * 60_000);
  // allow process to exit even if timer is still armed (tests)
  heartbeatTimer.unref?.();
}

function stopDirectoryHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
