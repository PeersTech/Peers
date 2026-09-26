const PREFIX = "peers-draft:";

/** Drafts are plaintext message text, so nothing oversized belongs in storage. */
export const MAX_DRAFT_CHARS = 16 * 1024;

export function draftKey(key: string): string {
    return `${PREFIX}${key}`;
}

export function shouldPersistDraft(value: string): boolean {
    return value.length > 0 && value.length <= MAX_DRAFT_CHARS;
}

/**
 * Removes every persisted draft.
 *
 * Drafts are written to `localStorage`, which is plaintext on disk and is not
 * covered by the encrypted state package. Locking clears the rest of the
 * in-memory state, so leaving them behind would mean locking does not actually
 * lock: previously typed message text would still be sitting on disk.
 */
export function purgeDrafts(storage: Storage): number {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && key.startsWith(PREFIX)) doomed.push(key);
    }
    doomed.forEach((key) => storage.removeItem(key));
    return doomed.length;
}
