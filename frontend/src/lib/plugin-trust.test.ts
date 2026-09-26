import {describe, expect, it} from "vitest";
import {generatePluginKey, sourceDigestHex} from "./plugin-signing";
import {PluginTrustStore} from "./plugin-trust";
import type {PluginManifest} from "./plugins";

const manifest: PluginManifest = {
    id: "uppercase",
    name: "Uppercase",
    version: "1.0.0",
    capabilities: ["message:transform"],
};

async function makeSigned(source = "self.onmessage = () => {};") {
    const key = await generatePluginKey();
    const {canonicalPayload} = await import("./plugin-signing");
    const signature = await key.sign(await canonicalPayload(manifest, source));
    return {
        key,
        plugin: {manifest, source, signature, keyId: key.keyId},
    };
}

function storeWith(key: {keyId: string; publicKey: Uint8Array}, label = "dev") {
    const store = new PluginTrustStore();
    store.addKey({
        keyId: key.keyId,
        publicKey: Array.from(key.publicKey),
        label,
    });
    return store;
}

describe("plugin trust", () => {
    it("loads a plugin whose key is trusted and signature matches", async () => {
        const {key, plugin} = await makeSigned();
        const decision = await storeWith(key).evaluate(plugin);
        expect(decision.ok).toBe(true);
    });

    it("refuses a plugin signed by an unknown key", async () => {
        const {plugin} = await makeSigned();
        const decision = await new PluginTrustStore().evaluate(plugin);
        expect(decision).toMatchObject({ok: false});
        if (!decision.ok) expect(decision.reason).toMatch(/not trusted/);
    });

    /// The signature covers the source, so swapping the script must not load.
    it("refuses a plugin whose source was swapped after signing", async () => {
        const {key, plugin} = await makeSigned("self.onmessage = () => {};");
        const tampered = {...plugin, source: "self.onmessage = () => exfiltrate();"};
        const decision = await storeWith(key).evaluate(tampered);
        expect(decision).toMatchObject({ok: false});
    });

    it("refuses a plugin whose manifest was edited after signing", async () => {
        const {key, plugin} = await makeSigned();
        // Deliberately out of contract: a signature must not survive a manifest
        // edit even when the added capability is one the validator would reject.
        const escalated = {
            ...plugin,
            manifest: {
                ...plugin.manifest,
                capabilities: ["message:transform", "filesystem"],
            } as unknown as PluginManifest,
        };
        const decision = await storeWith(key).evaluate(escalated);
        expect(decision).toMatchObject({ok: false});
    });

    it("refuses a revoked key even though it is still trusted", async () => {
        const {key, plugin} = await makeSigned();
        const store = storeWith(key);
        store.revoke(key.keyId);
        expect(store.isRevoked(key.keyId)).toBe(true);
        const decision = await store.evaluate(plugin);
        expect(decision).toMatchObject({ok: false});
        if (!decision.ok) expect(decision.reason).toMatch(/revoked/);
    });

    it("allows a plugin again once the key is unrevoked", async () => {
        const {key, plugin} = await makeSigned();
        const store = storeWith(key);
        store.revoke(key.keyId);
        store.unrevoke(key.keyId);
        expect((await store.evaluate(plugin)).ok).toBe(true);
    });

    it("stops trusting a key once it is removed", async () => {
        const {key, plugin} = await makeSigned();
        const store = storeWith(key);
        store.removeKey(key.keyId);
        expect((await store.evaluate(plugin)).ok).toBe(false);
    });

    it("treats a malformed signature as a failure rather than throwing", async () => {
        const {key, plugin} = await makeSigned();
        const decision = await storeWith(key).evaluate({...plugin, signature: "!!!not-base64!!!"});
        expect(decision).toMatchObject({ok: false});
    });

    it("hashes sources deterministically and distinguishes different ones", async () => {
        const a = await sourceDigestHex("abc");
        const b = await sourceDigestHex("abc");
        const c = await sourceDigestHex("abd");
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
});
