import {useEffect, useRef, type ReactNode} from 'react';
import {X} from 'lucide-react';

interface ModalProps {
    open: boolean;
    title: string;
    description?: string;
    children: ReactNode;
    onClose: () => void;
    className?: string;
    closeLabel?: string;
}

const FOCUSABLE = [
    'button:not([disabled])',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[href]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Shared accessible modal shell used by dialogs and feature modals. */
export function Modal({
    open,
    title,
    description,
    children,
    onClose,
    className = 'w-[28rem]',
    closeLabel = 'Close dialog',
}: ModalProps) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const previouslyFocused = document.activeElement as HTMLElement | null;
        const panel = panelRef.current;
        const first = panel?.querySelector<HTMLElement>('[data-autofocus], ' + FOCUSABLE);
        window.setTimeout(() => first?.focus(), 0);

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab' || !panel) return;

            const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
            if (focusable.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }
            const firstItem = focusable[0];
            const lastItem = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === firstItem) {
                event.preventDefault();
                lastItem.focus();
            } else if (!event.shiftKey && document.activeElement === lastItem) {
                event.preventDefault();
                firstItem.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            previouslyFocused?.focus();
        };
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-title"
                aria-describedby={description ? 'modal-description' : undefined}
                tabIndex={-1}
                className={`${className} max-h-[min(42rem,calc(100vh-2rem))] max-w-full overflow-y-auto rounded-lg border border-edge bg-surface-2 shadow-2xl outline-none`}
            >
                <div className="sticky top-0 z-10 flex min-h-14 items-start justify-between gap-4 border-b border-edge bg-surface-2 px-5 py-4">
                    <div className="min-w-0">
                        <h2 id="modal-title" className="text-base font-bold text-ink">{title}</h2>
                        {description && (
                            <p id="modal-description" className="mt-1 text-xs leading-5 text-muted">{description}</p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        title={closeLabel}
                        aria-label={closeLabel}
                    >
                        <X size={17}/>
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
