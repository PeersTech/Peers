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

export interface IceConfig {
    urls: string;
    username?: string;
    credential?: string;
}

/**
 * Builds the ICE server list from build-time configuration.
 *
 * TURN is only included when a URL, username, and credential are all present:
 * a half-configured TURN entry makes ICE fail outright in some implementations
 * rather than falling back to STUN, so an incomplete config is ignored.
 */
export function buildIceServers(config: {
    stun?: string;
    turnUrl?: string;
    turnUsername?: string;
    turnCredential?: string;
}): RTCIceServer[] {
    const servers: RTCIceServer[] = [];
    if (config.stun) servers.push({urls: config.stun});
    const {turnUrl, turnUsername, turnCredential} = config;
    if (turnUrl && turnUsername && turnCredential) {
        servers.push({urls: turnUrl, username: turnUsername, credential: turnCredential});
    }
    return servers;
}

function configuredIceServers(): RTCIceServer[] {
    return buildIceServers({
        stun: stunUrl,
        turnUrl: import.meta.env.VITE_TURN_URL as string | undefined,
        turnUsername: import.meta.env.VITE_TURN_USERNAME as string | undefined,
        turnCredential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    });
}

export interface SignalPayload {
    peerId: string;
    callId: string;
    action: string;
    sdp?: string | null;
    candidate?: string | null;
}

export type SignalDecision =
    | {kind: "ignore"}
    | {kind: "incoming"}
    | {kind: "answer"}
    | {kind: "ice"}
    | {kind: "hangup"};

/**
 * Pure negotiation rules for an inbound signaling message.
 *
 * Every branch requires a matching call id once a session exists, so a stale
 * or hostile signal cannot disturb a call already in progress. A second offer
 * while a call is up is ignored rather than replacing the current one.
 */
export function decideSignal(payload: SignalPayload, activeCallId: string | null): SignalDecision {
    const inSession = activeCallId !== null && activeCallId === payload.callId;
    if (payload.action === "offer") {
        return payload.sdp && activeCallId === null ? {kind: "incoming"} : {kind: "ignore"};
    }
    if (!inSession) return {kind: "ignore"};
    if (payload.action === "answer") return payload.sdp ? {kind: "answer"} : {kind: "ignore"};
    if (payload.action === "ice") return payload.candidate ? {kind: "ice"} : {kind: "ignore"};
    if (payload.action === "hangup") return {kind: "hangup"};
    return {kind: "ignore"};
}

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
        const pc = new RTCPeerConnection({iceServers: configuredIceServers()});
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
            const decision = decideSignal(payload, session.current?.callId ?? null);
            switch (decision.kind) {
                case "incoming":
                    setIncoming({peerId: payload.peerId, callId: payload.callId, sdp: payload.sdp!});
                    break;
                case "answer":
                    void session.current?.pc.setRemoteDescription({type: "answer", sdp: payload.sdp!});
                    break;
                case "ice":
                    try {
                        void session.current?.pc.addIceCandidate(JSON.parse(payload.candidate!));
                    } catch {
                        // Ignore malformed candidates from an incompatible peer.
                    }
                    break;
                case "hangup":
                    cleanup();
                    break;
                default:
                    break;
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
