import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

/**
 * Bootstrap configuration for reaching always-on Peers backbone nodes
 * (M9). Port of `backend/src/p2p/bootstrap.rs`, plus the directory:
 * config order is
 *
 *   1. `PEERS_NODES` env var (power users)
 *   2. user's `nodes.json`
 *   3. live node directories (`DEFAULT_DIRECTORIES`, cached to disk)
 *   4. built-in `DEFAULT_SEEDS`
 *
 * so a fresh install connects with zero configuration and no pasted ids.
 */

export interface BootstrapEnv {
  PEERS_NODES?: string;
  PEERS_PORT?: string;
  PEERS_ANNOUNCE?: string;
  PEERS_SHOW_SEED?: string;
  XDG_CONFIG_HOME?: string;
  HOME?: string;
}

/** Official node directories — queried in order, results merged+deduped. */
export const DEFAULT_DIRECTORIES = [
  'https://directory.peers.dpdns.org',
];

/** Built-in seed nodes — last-resort fallback when the directories are
 * unreachable (fresh install, offline first run). Operators join this list
 * via PR; users override everything with PEERS_NODES / nodes.json. */
export const DEFAULT_SEEDS: string[] = [
  '/ip4/213.136.86.78/tcp/4001/p2p/12D3KooWNYP5YYmb6ex8qoy4RkUUrEh9EosbSfenVBrSQwiyLDuu',
];

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

/** Sync sources only (env → nodes.json → defaults). The async directory
 * lookup lives in {@link resolveBootstrapNodes}. */
export function knownNodes(env: BootstrapEnv = process.env, configDir?: string): string[] {
  const fromEnv = parseAddrList(env.PEERS_NODES);
  if (fromEnv.length > 0) return fromEnv;
  const custom = (() => {
    const path = join(configDir ?? defaultConfigDir(env), 'peers', 'nodes.json');
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw.filter((a): a is string => typeof a === 'string' && isValidAddr(a.trim()));
    } catch {
      return [];
    }
  })();
  if (custom.length > 0) return custom;
  return DEFAULT_SEEDS;
}

export interface ResolveOptions {
  env?: BootstrapEnv;
  configDir?: string;
  directories?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Full bootstrap resolution, directories included. Order:
 * env → nodes.json → live directory query (cached to
 * `<config>/peers/directory-cache.json` so an offline NEXT run still has
 * the last known-good list) → built-in seeds. Never throws: every failure
 * degrades to the next source.
 */
export async function resolveBootstrapNodes(opts: ResolveOptions = {}): Promise<string[]> {
  const env = opts.env ?? process.env;
  const configDir = opts.configDir ?? defaultConfigDir(env);
  const staticNodes = knownNodes(env, configDir);
  // Static config wins outright — a power user naming nodes means it.
  if (staticNodes !== DEFAULT_SEEDS && staticNodes.length > 0) return staticNodes;

  const cachePath = join(configDir, 'peers', 'directory-cache.json');
  const cached = readCache(cachePath);
  if (cached.length > 0) return cached;

  const dirs = opts.directories ?? DEFAULT_DIRECTORIES;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const found = new Set<string>();
  await Promise.allSettled(
    dirs.map(async (dirUrl) => {
      const res = await withTimeout(
        doFetch(`${dirUrl.replace(/\/$/, '')}/v1/nodes?limit=200`),
        timeoutMs,
      );
      if (!res.ok) return;
      const body = (await res.json()) as {nodes?: {multiaddr?: string}[]};
      for (const n of body.nodes ?? []) {
        if (typeof n.multiaddr === 'string' && isValidAddr(n.multiaddr)) found.add(n.multiaddr);
      }
    }),
  );
  if (found.size === 0) return DEFAULT_SEEDS;
  writeCache(cachePath, [...found]);
  return [...found];
}

async function withTimeout(p: Promise<Response>, ms: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('directory timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function readCache(path: string): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((a): a is string => typeof a === 'string' && isValidAddr(a));
  } catch {
    return [];
  }
}

function writeCache(path: string, addrs: string[]): void {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(addrs));
  } catch {
    /* cache is best-effort */
  }
}
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
