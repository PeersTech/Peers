/**
 * The host transport: how this renderer reaches the engine.
 *
 * Exactly one seam, three carriers — chosen automatically:
 *
 *   1. `window.peers`  — Electron preload (contextBridge IPC), desktop shell.
 *   2. WebSocket       — the localhost web host (same-origin `/ws`), or
 *                        `VITE_PEERS_WS` in `vite dev`.
 *
 * Both satisfy the same shape the old Tauri adapter had: `invoke` resolves
 * with the command's return value or rejects, `listen` resolves with an
 * unlisten function. Nothing above this file knows which carrier won.
 */

export type UnlistenFn = () => void;

export interface HostTransport {
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    /** Resolves once registered; returns the unlisten function. */
    listen<T = unknown>(event: string, cb: (payload: T) => void): Promise<UnlistenFn>;
}

/** Injected by the Electron preload via contextBridge. */
interface ElectronPeers {
    request(cmd: string, args: unknown): Promise<{ok: true; ret: unknown} | {ok: false; error: string}>;
    on(event: string, cb: (payload: unknown) => void): () => void;
}

declare global {
    interface Window {
        peers?: ElectronPeers;
        __TAURI__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown>; event: { listen: (event: string, cb: (e: {payload: unknown}) => void) => Promise<UnlistenFn> } };
    }
}

function tauriTransport(tauri: NonNullable<Window['__TAURI__']>): HostTransport {
    return {
        invoke: (cmd, args) => tauri.invoke(cmd, args) as Promise<never>,
        listen: (event, cb) => tauri.event.listen(event, (e) => cb(e.payload as never)),
    };
}

function electronTransport(peers: ElectronPeers): HostTransport {
    return {
        async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
            const res = await peers.request(cmd, args ?? {});
            if (!res.ok) throw new Error(res.error);
            return res.ret as T;
        },
        async listen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
            // Wrap so a payload typed at this boundary stays typed inside.
            return peers.on(event, (payload) => cb(payload as T));
        },
    };
}

/**
 * WebSocket carrier. One shared socket; commands correlate by id, events
 * fan out to local listeners. Reconnects with capped backoff — the UI
 * stays usable and commands made while offline reject fast.
 */
function wsTransport(url: string, WebSocketImpl: typeof WebSocket = WebSocket): HostTransport {
    let socket: WebSocket | null = null;
    let attempt = 0;
    let closedForever = false;
    const pending = new Map<number, {resolve: (v: unknown) => void; reject: (e: Error) => void}>();
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const queue: string[] = [];
    let nextId = 1;

    const connect = (): void => {
        if (closedForever) return;
        const ws = new WebSocketImpl(url);
        socket = ws;
        ws.onopen = () => {
            attempt = 0;
            for (const frame of queue.splice(0)) ws.send(frame);
        };
        ws.onmessage = (msg) => {
            let frame: {id?: number | string; ok?: boolean; ret?: unknown; error?: string; event?: string; payload?: unknown};
            try {
                frame = JSON.parse(String(msg.data));
            } catch {
                return;
            }
            if (frame.event !== undefined) {
                for (const cb of listeners.get(frame.event) ?? []) cb(frame.payload);
                return;
            }
            const p = pending.get(frame.id as number);
            if (!p) return;
            pending.delete(frame.id as number);
            if (frame.ok) p.resolve(frame.ret);
            else p.reject(new Error(frame.error ?? 'command failed'));
        };
        ws.onclose = () => {
            if (closedForever || socket !== ws) return;
            socket = null;
            const delay = Math.min(500 * 2 ** attempt++, 5000);
            setTimeout(connect, delay);
        };
        ws.onerror = () => ws.close();
    };

    const send = (frame: unknown): void => {
        const raw = JSON.stringify(frame);
        if (socket && socket.readyState === WebSocketImpl.OPEN) socket.send(raw);
        else queue.push(raw);
    };

    connect();

    return {
        invoke<T>(cmd: string, args?: Record<string, unknown>) {
            const id = nextId++;
            return new Promise<T>((resolve, reject) => {
                pending.set(id, {resolve: resolve as (v: unknown) => void, reject});
                send({id, cmd, args: args ?? {}});
                // Offline-queue could hold commands forever; bound the wait.
                setTimeout(() => {
                    if (pending.delete(id)) reject(new Error(`${cmd}: host unreachable`));
                }, 15_000);
            });
        },
        async listen<T>(event: string, cb: (payload: T) => void) {
            let set = listeners.get(event);
            if (!set) {
                set = new Set();
                listeners.set(event, set);
            }
            set.add(cb as (payload: unknown) => void);
            return () => {
                set!.delete(cb as (payload: unknown) => void);
            };
        },
    };
}

let impl: HostTransport | null = null;

/** Probes candidate WS endpoints, returning the first that connects. */
async function probeWs(urls: string[], WebSocketImpl: typeof WebSocket): Promise<string | null> {
    for (const url of urls) {
        const ok = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 1200);
            try {
                const ws = new WebSocketImpl(url);
                ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); };
                ws.onerror = () => { clearTimeout(timer); resolve(false); };
            } catch {
                clearTimeout(timer);
                resolve(false);
            }
        });
        if (ok) return url;
    }
    return null;
}

let wsFallback: Promise<HostTransport> | null = null;

/** Thin shells (Tauri without a wired engine) ride the local web host. */
function wsHost(WebSocketImpl: typeof WebSocket): Promise<HostTransport> {
    if (!wsFallback) {
        wsFallback = (async () => {
            const candidates = [
                ...(typeof location !== 'undefined' && location.protocol.startsWith('http')
                    ? [`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`]
                    : []),
                'ws://127.0.0.1:8787/ws',
                'ws://127.0.0.1:8123/ws',
            ];
            const live = await probeWs(candidates, WebSocketImpl);
            return wsTransport(live ?? candidates[0], WebSocketImpl);
        })();
    }
    return wsFallback;
}

function defaultUrl(): string {
    const devUrl = import.meta.env?.VITE_PEERS_WS as string | undefined;
    return (
        devUrl ??
        (typeof location !== 'undefined' && location.protocol.startsWith('http')
            ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
            : 'ws://127.0.0.1:8787/ws')
    );
}

/** The selected carrier, decided once on first use. */
export function host(): HostTransport {
    if (!impl) {
        if (typeof window !== 'undefined' && window.__TAURI__) {
            // Tauri shell: the Rust side is a thin webview — the engine runs
            // in the local web host, so probe Tauri first and fall back to
            // WebSocket when the backend has no commands wired.
            const t = tauriTransport(window.__TAURI__);
            const probe = t
                .invoke('has_identity', {})
                .then(() => 'tauri' as const)
                .catch(() => 'fallback' as const);
            impl = {
                invoke: async (cmd, args) => {
                    if ((await probe) === 'tauri') return t.invoke(cmd, args);
                    return (await wsHost(WebSocket)).invoke(cmd, args);
                },
                listen: async (event, cb) => {
                    if ((await probe) === 'tauri') return t.listen(event, cb);
                    return (await wsHost(WebSocket)).listen(event, cb);
                },
            };
        } else if (typeof window !== 'undefined' && window.peers) {
            impl = electronTransport(window.peers);
        } else {
            impl = wsTransport(defaultUrl());
        }
    }
    return impl;
}

/** Test seam: force a specific carrier. */
export function useTransport(t: HostTransport): void {
    impl = t;
}
