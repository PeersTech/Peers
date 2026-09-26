import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PluginHost} from "./plugins";

const manifest = {
    id: "uppercase",
    name: "Uppercase",
    version: "1.0.0",
    capabilities: ["message:transform"],
};

const SAFE_SOURCE = "self.onmessage = () => {};";

/** Captures the constructed worker so a test can drive the message protocol. */
class FakeWorker {
    static last: FakeWorker | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    terminated = false;
    sent: {type: string; id: number; text: string}[] = [];
    respond: (text: string) => void = () => {};

    constructor() {
        FakeWorker.last = this;
    }

    postMessage(message: {type: string; id: number; text: string}) {
        this.sent.push(message);
    }

    terminate() {
        this.terminated = true;
    }

    reply(data: Record<string, unknown>) {
        this.onmessage?.({data} as MessageEvent);
    }
}

beforeEach(() => {
    FakeWorker.last = null;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("Blob", class {
        constructor(public parts: unknown[], public options: unknown) {}
    });
    vi.stubGlobal("URL", {
        createObjectURL: () => "blob:fake",
        revokeObjectURL: () => {},
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("plugin host", () => {
    it("refuses to run when no plugin is loaded", async () => {
        const host = new PluginHost();
        await expect(host.transform("hi")).rejects.toThrow(/no enabled/);
    });

    it("sends a transform request and resolves the worker's reply", async () => {
        const host = new PluginHost();
        host.load(manifest, SAFE_SOURCE);
        const worker = FakeWorker.last!;

        const pending = host.transform("hello");
        expect(worker.sent).toHaveLength(1);
        expect(worker.sent[0]).toMatchObject({type: "transform", text: "hello"});

        worker.reply({id: worker.sent[0].id, ok: true, text: "HELLO"});
        await expect(pending).resolves.toBe("HELLO");
    });

    it("propagates a plugin-reported failure", async () => {
        const host = new PluginHost();
        host.load(manifest, SAFE_SOURCE);
        const worker = FakeWorker.last!;

        const pending = host.transform("hello");
        worker.reply({id: worker.sent[0].id, ok: false, error: "boom"});
        await expect(pending).rejects.toThrow("boom");
    });

    /// A plugin that never answers must not hang the send path forever.
    it("times out instead of hanging", async () => {
        const host = new PluginHost();
        host.load(manifest, SAFE_SOURCE);
        await expect(host.transform("hello", 5)).rejects.toThrow(/timed out/);
    });

    /// A reply for an unknown id must not resolve someone else's request.
    it("ignores replies that match no pending request", async () => {
        const host = new PluginHost();
        host.load(manifest, SAFE_SOURCE);
        const worker = FakeWorker.last!;

        const pending = host.transform("hello");
        worker.reply({id: 9999, ok: true, text: "WRONG"});
        worker.reply({id: worker.sent[0].id, ok: true, text: "RIGHT"});
        await expect(pending).resolves.toBe("RIGHT");
    });

    it("rejects in-flight work and terminates the worker on dispose", async () => {
        const host = new PluginHost();
        host.load(manifest, SAFE_SOURCE);
        const worker = FakeWorker.last!;

        const pending = host.transform("hello");
        host.dispose();
        await expect(pending).rejects.toThrow(/disposed/);
        expect(worker.terminated).toBe(true);
    });

    it("refuses source that reaches for the network or dynamic eval", () => {
        const host = new PluginHost();
        expect(() => host.load(manifest, "fetch('https://evil.test')")).toThrow(/sandbox/);
        expect(() => host.load(manifest, "new Function('x')")).toThrow(/sandbox/);
        expect(() => host.load(manifest, SAFE_SOURCE)).not.toThrow();
    });
});
