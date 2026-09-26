import type {PluginManifest} from "./plugins";

/**
 * Ed25519 signatures over a plugin manifest, using WebCrypto so this runs in
 * the webview with no new dependency.
 *
 * The signed bytes are canonical JSON of `{id, name, version, capabilities}`
 * with the keys emitted in a fixed order, plus the exact source that will run.
 * Binding the source into the signature is the point: a signature over the
 * manifest alone would still let anyone swap the script.
 */

const SIGNED_FIELDS = ["id", "name", "version", "capabilities"] as const;

export interface SignedPlugin {
    manifest: PluginManifest;
    source: string;
    signature: string;
    keyId: string;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

/** Stable serialization: fixed field order, no incidental whitespace. */
export async function canonicalPayload(manifest: PluginManifest, source: string): Promise<Uint8Array<ArrayBuffer>> {
    const canonical = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        capabilities: [...manifest.capabilities].sort(),
        sourceSha256: await sourceDigestHex(source),
    };
    return new TextEncoder().encode(JSON.stringify(canonical));
}

/** SHA-256 of the plugin source, hex encoded. The signature covers this. */
export async function sourceDigestHex(source: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source) as BufferSource);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export function keyIdOf(publicKey: Uint8Array<ArrayBuffer>): string {
    // FNV-1a over the key bytes: a short, human-quotable handle only. It is
    // not a security boundary and is never used to verify anything.
    let hash = 0x811c9dc5;
    for (const byte of publicKey) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

export interface PluginKeyPair {
    keyId: string;
    publicKey: Uint8Array<ArrayBuffer>;
    sign: (data: Uint8Array<ArrayBuffer>) => Promise<string>;
}

export async function generatePluginKey(): Promise<PluginKeyPair> {
    const pair = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const keyId = keyIdOf(publicKey);
    return {
        keyId,
        publicKey,
        sign: async (data: Uint8Array<ArrayBuffer>) =>
            toBase64(new Uint8Array(await crypto.subtle.sign({name: "Ed25519"}, pair.privateKey, data))),
    };
}

export async function verifyPluginSignature(
    manifest: PluginManifest,
    source: string,
    signature: string,
    publicKey: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey(
            "spki",
            publicKey as BufferSource,
            {name: "Ed25519"},
            true,
            ["verify"],
        );
        return await crypto.subtle.verify(
            {name: "Ed25519"},
            key,
            fromBase64(signature) as BufferSource,
            await canonicalPayload(manifest, source),
        );
    } catch {
        // A malformed key or signature is a failed verification, never a throw.
        return false;
    }
}
