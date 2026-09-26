import {describe, expect, it} from "vitest";
import {draftKey, MAX_DRAFT_CHARS, purgeDrafts, shouldPersistDraft} from "./drafts";

/** Minimal in-memory Storage stand-in. */
function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        key: (i: number) => Array.from(map.keys())[i] ?? null,
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
    } as Storage;
}

describe("draft storage", () => {
    it("removes only draft keys and leaves other storage alone", () => {
        const storage = fakeStorage();
        storage.setItem(draftKey("dm:alice"), "secret plans");
        storage.setItem("unrelated-key", "keep me");
        expect(purgeDrafts(storage)).toBe(1);
        expect(storage.getItem(draftKey("dm:alice"))).toBeNull();
        expect(storage.getItem("unrelated-key")).toBe("keep me");
    });

    it("reports zero when there is nothing to purge", () => {
        expect(purgeDrafts(fakeStorage())).toBe(0);
    });

    it("refuses to persist oversized or empty drafts", () => {
        expect(shouldPersistDraft("hello")).toBe(true);
        expect(shouldPersistDraft("")).toBe(false);
        expect(shouldPersistDraft("x".repeat(MAX_DRAFT_CHARS + 1))).toBe(false);
    });
});
