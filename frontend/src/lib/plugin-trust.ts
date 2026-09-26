import {verifyPluginSignature, type SignedPlugin} from "./plugin-signing";

/**
 * Plugin trust store.
 *
 * Trust is explicit: a key must be added by the user before any plugin it
 * signed will load. Revocation is checked at load time rather than cached, so
 * a revoked key stops working immediately instead of at the next restart.
 *
 * Kept free of storage and UI so the policy is testable on its own.
 */

export interface TrustedKey {
    keyId: string;
    publicKey: number[];
    label: string;
}

export type LoadDecision =
    | {ok: true; plugin: SignedPlugin}
    | {ok: false; reason: string};

export class PluginTrustStore {
    private keys = new Map<string, TrustedKey>();
    private revoked = new Set<string>();

    addKey(key: TrustedKey): void {
        this.keys.set(key.keyId, key);
    }

    removeKey(keyId: string): void {
        this.keys.delete(keyId);
    }

    listKeys(): TrustedKey[] {
        return [...this.keys.values()];
    }

    revoke(keyId: string, reason = "revoked by user"): void {
        this.revoked.add(keyId);
    }

    unrevoke(keyId: string): void {
        this.revoked.delete(keyId);
    }

    isRevoked(keyId: string): boolean {
        return this.revoked.has(keyId);
    }

    /**
     * Decides whether a signed plugin may load.
     *
     * Order matters: revocation is checked before anything else, and a
     * signature over different source is rejected outright. A tampered source
     * with a valid signature for the original must never load.
     */
    async evaluate(plugin: SignedPlugin): Promise<LoadDecision> {
        if (this.revoked.has(plugin.keyId)) {
            return {ok: false, reason: `plugin key ${plugin.keyId} is revoked`};
        }
        const key = this.keys.get(plugin.keyId);
        if (!key) {
            return {ok: false, reason: `plugin key ${plugin.keyId} is not trusted`};
        }
        const valid = await verifyPluginSignature(
            plugin.manifest,
            plugin.source,
            plugin.signature,
            new Uint8Array(key.publicKey),
        );
        if (!valid) {
            return {
                ok: false,
                reason: "signature does not match the manifest and source",
            };
        }
        return {ok: true, plugin};
    }
}
