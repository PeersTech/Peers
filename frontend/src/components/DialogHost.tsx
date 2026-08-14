import {useEffect, useState, useSyncExternalStore, type FormEvent} from 'react';
import {AlertTriangle, Copy} from 'lucide-react';
import {copyText} from '../lib/api';
import type {DialogController} from '../lib/dialogs';
import {Modal} from './Modal';

export function DialogHost({controller}: {controller: DialogController}) {
    const request = useSyncExternalStore(controller.subscribe, controller.getCurrent, controller.getCurrent);
    const [value, setValue] = useState('');
    const [validationError, setValidationError] = useState<string | null>(null);
    const [copyFailed, setCopyFailed] = useState(false);

    useEffect(() => {
        setValue(request?.kind === 'prompt' ? request.initial ?? '' : '');
        setValidationError(null);
        setCopyFailed(false);
    }, [request?.id]);

    if (!request) return null;

    if (request.kind === 'confirm') {
        return (
            <Modal
                open
                title={request.title}
                description={request.body}
                onClose={controller.cancelCurrent}
                className="w-[26rem]"
            >
                <div className="flex items-start gap-3 px-5 py-5">
                    {request.destructive && (
                        <AlertTriangle className="mt-0.5 shrink-0 text-danger" size={19}/>
                    )}
                    <p className="text-sm leading-6 text-ink-dim">
                        {request.body ?? 'This action cannot be undone.'}
                    </p>
                </div>
                <div className="flex justify-end gap-2 border-t border-edge bg-surface-1/40 px-5 py-4">
                    <button
                        type="button"
                        onClick={controller.cancelCurrent}
                        className="rounded-md px-3 py-2 text-sm font-semibold text-muted hover:bg-surface-3 hover:text-ink"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        data-autofocus
                        onClick={() => controller.resolveCurrent(true)}
                        className={`rounded-md px-4 py-2 text-sm font-semibold ${
                            request.destructive
                                ? 'bg-danger text-white hover:brightness-110'
                                : 'bg-accent text-white hover:bg-accent-hover'
                        }`}
                    >
                        {request.confirmLabel ?? 'Confirm'}
                    </button>
                </div>
            </Modal>
        );
    }

    if (request.kind === 'text') {
        return (
            <Modal
                open
                title={request.title}
                description={request.body}
                onClose={controller.cancelCurrent}
                className="w-[36rem]"
            >
                <div className="px-5 py-5">
                    <textarea
                        data-autofocus
                        readOnly
                        value={request.value}
                        rows={10}
                        onFocus={(event) => event.currentTarget.select()}
                        className="selectable w-full resize-y rounded-md border border-edge bg-surface-1 px-3 py-2 font-mono text-xs leading-5 text-ink outline-none focus:border-accent"
                    />
                    {copyFailed && (
                        <p className="mt-2 text-xs text-warn">Clipboard access is unavailable. The text is selected for manual copying.</p>
                    )}
                </div>
                <div className="flex justify-end gap-2 border-t border-edge bg-surface-1/40 px-5 py-4">
                    <button
                        type="button"
                        onClick={() => controller.resolveCurrent(undefined)}
                        className="rounded-md px-3 py-2 text-sm font-semibold text-muted hover:bg-surface-3 hover:text-ink"
                    >
                        Done
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            void copyText(request.value).then((copied) => setCopyFailed(!copied));
                        }}
                        className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
                    >
                        <Copy size={15}/>
                        Copy
                    </button>
                </div>
            </Modal>
        );
    }

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const error = request.validate?.(value) ?? null;
        if (error) {
            setValidationError(error);
            return;
        }
        controller.resolveCurrent(value);
    };

    const inputClass = `w-full rounded-md border bg-surface-1 px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent ${
        validationError ? 'border-danger' : 'border-edge'
    } ${request.mono ? 'font-mono' : ''}`;

    return (
        <Modal
            open
            title={request.title}
            description={request.body}
            onClose={controller.cancelCurrent}
            className={request.multiline ? 'w-[34rem]' : 'w-[26rem]'}
        >
            <form onSubmit={submit}>
                <div className="px-5 py-5">
                    {request.label && (
                        <label htmlFor="dialog-value" className="mb-1.5 block text-xs font-semibold text-muted">
                            {request.label}
                        </label>
                    )}
                    {request.multiline ? (
                        <textarea
                            id="dialog-value"
                            data-autofocus
                            value={value}
                            rows={8}
                            placeholder={request.placeholder}
                            onChange={(event) => {
                                setValue(event.target.value);
                                setValidationError(null);
                            }}
                            className={`${inputClass} resize-y leading-5`}
                        />
                    ) : (
                        <input
                            id="dialog-value"
                            data-autofocus
                            value={value}
                            placeholder={request.placeholder}
                            onChange={(event) => {
                                setValue(event.target.value);
                                setValidationError(null);
                            }}
                            className={inputClass}
                        />
                    )}
                    {validationError && <p className="mt-2 text-xs text-danger">{validationError}</p>}
                </div>
                <div className="flex justify-end gap-2 border-t border-edge bg-surface-1/40 px-5 py-4">
                    <button
                        type="button"
                        onClick={controller.cancelCurrent}
                        className="rounded-md px-3 py-2 text-sm font-semibold text-muted hover:bg-surface-3 hover:text-ink"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
                    >
                        {request.confirmLabel ?? 'Continue'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
