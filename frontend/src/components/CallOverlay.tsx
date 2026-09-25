import type {ActiveCall, IncomingCall} from "../lib/calls";

interface Props {
    incoming: IncomingCall | null;
    active: ActiveCall | null;
    muted: boolean;
    cameraOff: boolean;
    onAccept: () => void;
    onReject: () => void;
    onEnd: () => void;
    onToggleMute: () => void;
    onToggleCamera: () => void;
}

function StreamVideo({stream, muted, className}: {stream: MediaStream | null; muted?: boolean; className: string}) {
    return <video ref={(node) => { if (node && stream && node.srcObject !== stream) node.srcObject = stream; }} autoPlay playsInline muted={muted} className={className}/>;
}

export function CallOverlay({incoming, active, muted, cameraOff, onAccept, onReject, onEnd, onToggleMute, onToggleCamera}: Props) {
    if (!incoming && !active) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" role="dialog" aria-label="Call">
            <div className="w-full max-w-3xl rounded-xl border border-edge bg-surface-1 p-4 shadow-2xl">
                {incoming && !active && (
                    <div className="flex flex-col items-center gap-4 py-12 text-center">
                        <div className="text-lg font-semibold text-ink">Incoming call</div>
                        <div className="text-sm text-muted">A peer is calling you.</div>
                        <div className="flex gap-3">
                            <button onClick={onReject} className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white">Decline</button>
                            <button onClick={onAccept} className="rounded-lg bg-online px-4 py-2 text-sm font-semibold text-black">Accept</button>
                        </div>
                    </div>
                )}
                {active && (
                    <div className="grid gap-3 md:grid-cols-2">
                        <div className="relative overflow-hidden rounded-lg bg-black">
                            <StreamVideo stream={active.localStream} muted className="aspect-video w-full object-cover"/>
                            {cameraOff && <div className="absolute inset-0 flex items-center justify-center text-xs text-white">Camera off</div>}
                            <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[10px] text-white">You</div>
                        </div>
                        <div className="relative overflow-hidden rounded-lg bg-black">
                            {active.remoteStream ? <StreamVideo stream={active.remoteStream} className="aspect-video w-full object-cover"/> : <div className="flex aspect-video items-center justify-center text-xs text-white">Connecting…</div>}
                        </div>
                        <div className="flex justify-center gap-2 md:col-span-2">
                            <button onClick={onToggleMute} className="rounded-lg bg-surface-3 px-3 py-2 text-xs text-ink hover:bg-surface-4">{muted ? "Unmute" : "Mute"}</button>
                            <button onClick={onToggleCamera} className="rounded-lg bg-surface-3 px-3 py-2 text-xs text-ink hover:bg-surface-4">{cameraOff ? "Camera on" : "Camera off"}</button>
                            <button onClick={onEnd} className="rounded-lg bg-danger px-3 py-2 text-xs font-semibold text-white">End call</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
