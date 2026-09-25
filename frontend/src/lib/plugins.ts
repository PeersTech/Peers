export const PLUGIN_CAPABILITIES = ["message:transform"] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    capabilities: PluginCapability[];
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const FORBIDDEN_SOURCE = /\b(?:eval|Function|importScripts|fetch|XMLHttpRequest|WebSocket|SharedWorker)\b/;

export function validatePluginManifest(value: unknown): PluginManifest {
    if (!value || typeof value !== "object") throw new Error("plugin manifest must be an object");
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !ID.test(candidate.id)) throw new Error("invalid plugin id");
    if (typeof candidate.name !== "string" || candidate.name.length < 1 || candidate.name.length > 64) {
        throw new Error("invalid plugin name");
    }
    if (typeof candidate.version !== "string" || !VERSION.test(candidate.version)) {
        throw new Error("plugin version must be semantic x.y.z");
    }
    if (!Array.isArray(candidate.capabilities) || candidate.capabilities.length === 0) {
        throw new Error("plugin must request at least one capability");
    }
    const capabilities = candidate.capabilities.map((capability) => {
        if (!PLUGIN_CAPABILITIES.includes(capability as PluginCapability)) {
            throw new Error(`unsupported plugin capability: ${String(capability)}`);
        }
        return capability as PluginCapability;
    });
    return {id: candidate.id, name: candidate.name, version: candidate.version, capabilities};
}

type Pending = {resolve: (text: string) => void; reject: (error: Error) => void};

/** A deliberately tiny plugin host. Plugins run in a Worker and can only
 *  transform message text; there is no filesystem, shell, credential, DOM,
 *  or Tauri API surface. A plugin must answer transform requests with
 *  `{ id, ok, text }`. */
export class PluginHost {
    private worker: Worker | null = null;
    private manifest: PluginManifest | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();

    load(manifestValue: unknown, source: string): PluginManifest {
        this.dispose();
        const manifest = validatePluginManifest(manifestValue);
        if (source.length > 64 * 1024 || FORBIDDEN_SOURCE.test(source)) {
            throw new Error("plugin source exceeds the sandbox policy");
        }
        const url = URL.createObjectURL(new Blob([source], {type: "text/javascript"}));
        this.worker = new Worker(url);
        URL.revokeObjectURL(url);
        this.manifest = manifest;
        this.worker.onmessage = (event: MessageEvent<{id?: number; ok?: boolean; text?: string; error?: string}>) => {
            const id = event.data?.id;
            if (typeof id !== "number") return;
            const request = this.pending.get(id);
            if (!request) return;
            this.pending.delete(id);
            if (event.data.ok && typeof event.data.text === "string") request.resolve(event.data.text);
            else request.reject(new Error(event.data.error ?? "plugin transform failed"));
        };
        return manifest;
    }

    transform(text: string, timeoutMs = 2000): Promise<string> {
        if (!this.worker || !this.manifest?.capabilities.includes("message:transform")) {
            return Promise.reject(new Error("no enabled message-transform plugin"));
        }
        const id = this.nextId++;
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("plugin transform timed out"));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.worker?.postMessage({type: "transform", id, text});
        });
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.manifest = null;
        for (const request of this.pending.values()) request.reject(new Error("plugin disposed"));
        this.pending.clear();
    }
}
