import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * Bootstrap configuration for reaching always-on Peers backbone nodes
 * (M9). Port of `backend/src/p2p/bootstrap.rs`, minus the DNS resolver:
 * config order is the `PEERS_NODES` env var (comma-separated multiaddrs)
 * first, then a `nodes.json` array in the config dir.
 *
 * Everything here is injectable so tests never touch the real environment.
 */

export interface BootstrapEnv {
  PEERS_NODES?: string;
  PEERS_PORT?: string;
  PEERS_ANNOUNCE?: string;
  XDG_CONFIG_HOME?: string;
  HOME?: string;
}

/** Multiaddrs of known always-on nodes, dialed on startup. */
export function knownNodes(env: BootstrapEnv = process.env, configDir?: string): string[] {
  const fromEnv = parseAddrList(env.PEERS_NODES);
  if (fromEnv.length > 0) return fromEnv;
  const path = join(configDir ?? defaultConfigDir(env), 'peers', 'nodes.json');
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((a): a is string => typeof a === 'string' && isValidAddr(a.trim()));
  } catch {
    return [];
  }
}

/** TCP port to bind, from `PEERS_PORT`. A node's port must stay stable —
 * clients hold it in nodes.json; an OS-assigned one silently invalidates
 * every client's config on restart. */
export function listenPort(fallback: number, env: BootstrapEnv = process.env): number {
  return parsePort(env.PEERS_PORT ?? '', fallback);
}

/** Publicly reachable addresses declared by the operator (`PEERS_ANNOUNCE`)
 * — on a cloud VM the NIC only carries the private address. */
export function announceAddrs(env: BootstrapEnv = process.env): string[] {
  return parseAddrList(env.PEERS_ANNOUNCE);
}

// ---------------------------------------------------------------------------

function parseAddrList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && isValidAddr(part));
}

/** Loose shape check: a multiaddr we dial must name its peer. */
function isValidAddr(s: string): boolean {
  return s.startsWith('/') && s.includes('/p2p/');
}

export function parsePort(raw: string, fallback: number): number {
  const n = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(n) || n < 0 || n > 65535) return fallback;
  return n;
}

function defaultConfigDir(env: BootstrapEnv): string {
  return env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config');
}
