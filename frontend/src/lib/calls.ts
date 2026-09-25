import {useCallback, useEffect, useRef, useState} from "react";
import {onCallSignal, sendCallSignal} from "./api";

export interface IncomingCall {
    peerId: string;
    callId: string;
    sdp: string;
}

export interface ActiveCall {
    peerId: string;
    callId: string;
    localStream: MediaStream;
    remoteStream: MediaStream | null;
}

interface CallSession extends ActiveCall {
    pc: RTCPeerConnection;
}

const stunUrl = (import.meta.env.VITE_STUN_URL as string | undefined) ?? "stun:stun.l.google.com:19302";

/** Small WebRTC call controller. Signaling is E2E sealed by the backend;
 *  media stays peer-to-peer and is never published to a relay topic. */
export function useCall() {
    const [incoming, setIncoming] = useState<IncomingCall | null>(null);
    const [active, setActive] = useState<ActiveCall | null>(null);
    const [muted, setMuted] = useState(false);
    const [cameraOff, setCameraOff] = useState(false);
    const session = useRef<CallSession | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);

    const cleanup = useCallback(() => {
        const current = session.current;
        session.current = null;
        if (current) {
            current.localStream.getTracks().forEach((track) => track.stop());
            current.pc.close();
        }
        setActive(null);
        setMuted(false);
        setCameraOff(false);
    }, []);

    const makeSession = useCallback(async (peerId: string, callId: string) => {
        const localStream = await navigator.mediaDevices.getUserMedia({audio: true, video: true});
        const pc = new RTCPeerConnection({iceServers: [{urls: stunUrl}]});
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        const next: CallSession = {peerId, callId, localStream, remoteStream: null, pc};
        session.current = next;
        setActive({peerId, callId, localStream, remoteStream: null});
        pc.ontrack = (event) => {
            const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
            setActive((current) => current && current.callId === callId ? {...current, remoteStream} : current);
        };
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                void sendCallSignal(peerId, callId, "ice", undefined, JSON.stringify(event.candidate.toJSON())).catch(() => {});
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "closed") cleanup();
        };
        return next;
    }, [cleanup]);

    const signal = useCallback((peerId: string, callId: string, action: "offer" | "answer" | "ice" | "hangup", sdp?: string, candidate?: string) => {
        void sendCallSignal(peerId, callId, action, sdp, candidate).catch(() => {});
    }, []);

    const startCall = useCallback(async (peerId: string) => {
        const callId = crypto.randomUUID();
        const next = await makeSession(peerId, callId);
        const offer = await next.pc.createOffer();
        await next.pc.setLocalDescription(offer);
        signal(peerId, callId, "offer", offer.sdp ?? undefined);
    }, [makeSession, signal]);

    const acceptCall = useCallback(async () => {
        if (!incoming) return;
        const {peerId, callId, sdp} = incoming;
        setIncoming(null);
        const next = await makeSession(peerId, callId);
        await next.pc.setRemoteDescription({type: "offer", sdp});
        const answer = await next.pc.createAnswer();
        await next.pc.setLocalDescription(answer);
        signal(peerId, callId, "answer", answer.sdp ?? undefined);
    }, [incoming, makeSession, signal]);

    const rejectCall = useCallback(() => {
        if (!incoming) return;
        signal(incoming.peerId, incoming.callId, "hangup");
        setIncoming(null);
    }, [incoming, signal]);

    const endCall = useCallback(() => {
        const current = session.current;
        if (current) signal(current.peerId, current.callId, "hangup");
        cleanup();
    }, [cleanup, signal]);

    const toggleMute = useCallback(() => {
        const current = session.current;
        if (!current) return;
        const next = !muted;
        current.localStream.getAudioTracks().forEach((track) => { track.enabled = !next; });
        setMuted(next);
    }, [muted]);

    const toggleCamera = useCallback(() => {
        const current = session.current;
        if (!current) return;
        const next = !cameraOff;
        current.localStream.getVideoTracks().forEach((track) => { track.enabled = !next; });
        setCameraOff(next);
    }, [cameraOff]);

    useEffect(() => {
        let cancelled = false;
        const dispose = onCallSignal((payload) => {
            if (payload.action === "offer" && payload.sdp && !session.current) {
                setIncoming({peerId: payload.peerId, callId: payload.callId, sdp: payload.sdp});
            } else if (payload.action === "answer" && session.current?.callId === payload.callId && payload.sdp) {
                void session.current.pc.setRemoteDescription({type: "answer", sdp: payload.sdp});
            } else if (payload.action === "ice" && session.current?.callId === payload.callId && payload.candidate) {
                try {
                    void session.current.pc.addIceCandidate(JSON.parse(payload.candidate));
                } catch {
                    // Ignore malformed candidates from an incompatible peer.
                }
            } else if (payload.action === "hangup" && session.current?.callId === payload.callId) {
                cleanup();
            }
        });
        void dispose.then((unlisten) => {
            if (cancelled) unlisten();
            else unlistenRef.current = unlisten;
        });
        return () => {
            cancelled = true;
            unlistenRef.current?.();
            unlistenRef.current = null;
        };
    }, [cleanup]);

    useEffect(() => cleanup, [cleanup]);

    return {incoming, active, muted, cameraOff, startCall, acceptCall, rejectCall, endCall, toggleMute, toggleCamera};
}
