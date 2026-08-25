import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';
import {Identity} from '@peers/core';
import {PeersHost} from '@peers/host';
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
  /** Auto-created in `dataDir` when omitted (plaintext node identity). */
  identity?: Identity;
  dataDir?: string;
  host?: string;
  port?: number;
  /** Static renderer root. Default: ../../frontend/dist if it exists. */
  distDir?: string;
}

export interface WebHost {
  port: number;
  peerId: string;
  host_: PeersHost;
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

export async function startWebHost(opts: WebHostOptions = {}): Promise<WebHost> {
  const identity = opts.identity ?? Identity.random();
  const host = await PeersHost.start({identity});

  const http = createServer((req, res) => {
    void serveStatic(req, res, opts.distDir ?? defaultDist());
  });
  const wss = new WebSocketServer({server: http});

  wss.on('connection', (socket) => {
    const offs: (() => void)[] = [];
    // Every event the engine emits fans out to this socket as a frame.
    for (const event of EVENT_NAMES) {
      offs.push(
        host.on(event, (payload) => {
          send(socket, {event, payload});
        }),
      );
    }
    socket.on('message', (raw: RawData) => {
      void dispatch(host, socket, raw);
    });
    socket.on('close', () => offs.forEach((off) => off()));
  });

  const port = opts.port ?? 0;
  await new Promise<void>((resolve) => http.listen(port, opts.host ?? '127.0.0.1', resolve));

  return {
    get port(): number {
      return (http.address() as {port: number}).port;
    },
    peerId: host.peerId,
    host_: host,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await host.stop();
    },
  };
}

// ---------------------------------------------------------------------------

type WireRequest = {id?: number | string; cmd: CommandName; args?: Record<string, unknown>};

async function dispatch(host: PeersHost, socket: WebSocket, raw: RawData): Promise<void> {
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
    const ret = await host.request(req.cmd, (req.args ?? {}) as never);
    send(socket, {id: req.id, ok: true, ret} as never);
  } catch (e) {
    send(socket, {id: req.id, ok: false, error: e instanceof Error ? e.message : String(e)} as never);
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
