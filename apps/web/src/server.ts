import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';
import {Identity, type KdfParams} from '@peers/core';
import {PeersAccount, PeersHost} from '@peers/host';
import {resolveBootstrapNodes} from '@peers/node';
import type {CommandName, EventName} from '@peers/api';
import {WebSocketServer, WebSocket, type RawData} from 'ws';

/**
 * The localhost web host: the SAME renderer the desktop shell loads,
 * reached over HTTP + a single WebSocket instead of Electron IPC. It is
 * a pure transport adapter of @peers/api — every app decision stays in
 * @peers/host.
 *
 * Protocol: client sends `{id, cmd, args}`; server answers
 * `{id, ok: true, ret}` or `{id, ok: false, error}` and pushes events as
 * `{event, payload}` frames on the same socket.
 */

export interface WebHostOptions {
  /** Ephemeral auto-identity mode: the engine to wrap. */
  identity?: Identity;
  listenAddrs?: string[];
  /** Always-on nodes; defaults to directory + seeds resolution. */
  bootstrapAddrs?: string[];
  /** Account mode: keystore + sealed state under this dir. Starts locked
   * when the keystore doesn't exist yet — the renderer drives unlock. */
  accountDir?: string;
  /** KDF params for account mode (tests inject TEST_KDF). */
  kdf?: KdfParams;
  host?: string;
  port?: number;
  /** Static renderer root. Default: ../../frontend/dist if it exists. */
  distDir?: string;
}

/** Anything that answers the @peers/api seam: the unlocked engine, or a
 * full account (which handles the session commands while locked). */
export type Backend = Pick<PeersHost, 'request' | 'on'> & {stop?(): Promise<void>};

export interface WebHost {
  port: number;
  peerId: string | null;
  host_: PeersHost | null;
  backend: Backend;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * Starts the localhost bridge.
 *
 * - Default: an ephemeral auto-identity engine, always unlocked (demo/tests).
 * - With `accountDir`: a full {@link PeersAccount} backed by that dir —
 *   starts LOCKED when no keystore exists yet; the renderer drives
 *   generate_phrase / init_from_phrase / unlock through the same socket.
 */
export async function startWebHost(opts: WebHostOptions = {}): Promise<WebHost> {
  let backend: Backend;
  let peerId: string | null = null;
  let host_: PeersHost | null = null;
  let account: PeersAccount | null = null;

  if (opts.accountDir) {
    account = new PeersAccount({
      dataDir: opts.accountDir,
      kdf: opts.kdf,
      listenAddrs: opts.listenAddrs,
      bootstrapAddrs: opts.bootstrapAddrs ?? (await resolveBootstrapNodes({configDir: opts.accountDir})),
    });
    // Recover the peer id for display without unlocking anything.
    if (!account.hasIdentity()) peerId = null;
  } else {
    const identity = opts.identity ?? Identity.random();
    host_ = await PeersHost.start({identity});
    peerId = host_.peerId;
    backend = host_;
  }
  backend = (account ?? host_) as Backend;

  const http = createServer((req, res) => {
    void serveStatic(req, res, opts.distDir ?? defaultDist());
  });
  const wss = new WebSocketServer({server: http});

  wss.on('connection', (socket) => {
    const offs: (() => void)[] = [];
    // Every event the backend emits fans out to this socket as a frame.
    // While locked the account queues these and attaches them at unlock.
    for (const event of EVENT_NAMES) {
      offs.push(
        backend!.on(event, (payload) => {
          send(socket, {event, payload});
        }),
      );
    }
    socket.on('message', (raw: RawData) => {
      void dispatch(backend!, socket, raw);
    });
    socket.on('close', () => offs.forEach((off) => off()));
  });

  const port = opts.port ?? 0;
  await new Promise<void>((resolve) => http.listen(port, opts.host ?? '127.0.0.1', resolve));

  return {
    get port(): number {
      return (http.address() as {port: number}).port;
    },
    peerId,
    host_,
    backend,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (account) await account.lock();
      else if (host_) await host_.stop();
    },
  };
}

// ---------------------------------------------------------------------------

type WireRequest = {id?: number | string; cmd: CommandName; args?: Record<string, unknown>};

async function dispatch(backend: Backend, socket: WebSocket, raw: RawData): Promise<void> {
  let req: WireRequest;
  try {
    req = JSON.parse(String(raw)) as WireRequest;
  } catch {
    return send(socket, {ok: false, error: 'not json'});
  }
  if (!req || typeof req.cmd !== 'string') {
    return send(socket, {id: req?.id, ok: false, error: 'missing cmd'});
  }
  try {
    const ret = await backend.request(req.cmd, (req.args ?? {}) as never);
    send(socket, {id: req.id, ok: true, ret} as never);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    if (stack) console.error(`[engine] ${req.cmd} failed: ${stack}`);
    send(socket, {id: req.id, ok: false, error: msg} as never);
  }
}

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, distDir: string): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]!;
  let file = join(distDir, normalize(url === '/' ? '/index.html' : url));
  if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback — unknown paths render the app shell.
    file = join(distDir, 'index.html');
  }
  if (!existsSync(file)) {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(
      `<!doctype html><title>Peers</title><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div><h1>Peers web host</h1><p>Renderer not built yet — run <code>npm run build</code> in <code>frontend/</code>.</p><p>The WebSocket bridge is live at <code>/ws</code>.</p></div></body>`,
    );
    return;
  }
  res.writeHead(200, {'content-type': MIME[extname(file)] ?? 'application/octet-stream'});
  createReadStream(file).pipe(res);
}

function defaultDist(): string {
  const candidate = join(import.meta.dirname ?? '.', '../../../frontend/dist');
  return existsSync(candidate) ? candidate : join(process.cwd(), 'nonexistent-dist');
}

const EVENT_NAMES = [
  'presence://peer-connected',
  'presence://peer-disconnected',
  'node://message',
  'net://hole-punch',
  'code://resolved',
  'friend://request',
  'blob://parked',
  'blob://fetched',
  'blob://failed',
  'server://list',
  'server://message',
  'server://error',
  'server://join-request',
  'plaza://message',
  'plaza://profile',
] as const satisfies readonly EventName[];
