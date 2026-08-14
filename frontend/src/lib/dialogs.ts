export interface ConfirmDialogOptions {
    title: string;
    body?: string;
    confirmLabel?: string;
    destructive?: boolean;
}

export interface PromptDialogOptions {
    title: string;
    body?: string;
    label?: string;
    placeholder?: string;
    initial?: string;
    confirmLabel?: string;
    multiline?: boolean;
    mono?: boolean;
    validate?: (value: string) => string | null;
}

export interface TextDialogOptions {
    title: string;
    body?: string;
    value: string;
}

export type DialogRequest =
    | ({id: number; kind: 'confirm'} & ConfirmDialogOptions)
    | ({id: number; kind: 'prompt'} & PromptDialogOptions)
    | ({id: number; kind: 'text'} & TextDialogOptions);

type DialogResult = boolean | string | null | undefined;

interface PendingDialog {
    request: DialogRequest;
    resolve: (value: DialogResult) => void;
}

/** A small FIFO controller kept separate from React so queue semantics are testable. */
export class DialogController {
    private queue: PendingDialog[] = [];
    private listeners = new Set<() => void>();
    private nextId = 1;

    getCurrent = (): DialogRequest | null => this.queue[0]?.request ?? null;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    confirm = (options: ConfirmDialogOptions): Promise<boolean> =>
        this.enqueue<boolean>({id: this.nextId++, kind: 'confirm', ...options});

    prompt = (options: PromptDialogOptions): Promise<string | null> =>
        this.enqueue<string | null>({id: this.nextId++, kind: 'prompt', ...options});

    showText = (options: TextDialogOptions): Promise<void> =>
        this.enqueue<void>({id: this.nextId++, kind: 'text', ...options});

    resolveCurrent = (value: DialogResult): void => {
        const pending = this.queue.shift();
        if (!pending) return;
        pending.resolve(value);
        this.emit();
    };

    cancelCurrent = (): void => {
        const current = this.getCurrent();
        if (!current) return;
        this.resolveCurrent(current.kind === 'confirm' ? false : current.kind === 'prompt' ? null : undefined);
    };

    destroy = (): void => {
        while (this.queue.length > 0) {
            const pending = this.queue.shift();
            if (!pending) break;
            pending.resolve(
                pending.request.kind === 'confirm'
                    ? false
                    : pending.request.kind === 'prompt'
                      ? null
                      : undefined,
            );
        }
        this.emit();
        this.listeners.clear();
    };

    private enqueue<T>(request: DialogRequest): Promise<T> {
        return new Promise<T>((resolve) => {
            this.queue.push({request, resolve: resolve as (value: DialogResult) => void});
            this.emit();
        });
    }

    private emit(): void {
        this.listeners.forEach((listener) => listener());
    }
}

export const validateRequired = (label: string, max = 80) => (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return `${label} is required`;
    if (trimmed.length > max) return `${label} must be ${max} characters or fewer`;
    return null;
};

export const validatePeerId = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return 'Peer ID is required';
    if (trimmed.length < 40 || trimmed.length > 64) return 'Enter the full peer ID';
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) return 'Peer ID contains invalid characters';
    return null;
};

export const validateJson = (label: string) => (value: string): string | null => {
    if (!value.trim()) return `${label} is required`;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return `${label} must be a JSON object`;
        }
        return null;
    } catch {
        return `${label} is not valid JSON`;
    }
};

export const validateChannelName = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return 'Channel name is required';
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(trimmed)) {
        return 'Use 1-32 lowercase letters, numbers, hyphens, or underscores';
    }
    return null;
};
