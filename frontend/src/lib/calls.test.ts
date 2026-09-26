import {describe, expect, it} from "vitest";
import {decideSignal, type SignalPayload} from "./calls";

const payload = (over: Partial<SignalPayload> = {}): SignalPayload => ({
    peerId: "peer-a",
    callId: "call-1",
    action: "offer",
    sdp: "v=0",
    ...over,
});

describe("call signal negotiation", () => {
    it("rings for an offer when no call is in progress", () => {
        expect(decideSignal(payload(), null)).toEqual({kind: "incoming"});
    });

    /// A second offer must not replace the call already on screen.
    it("ignores a second offer while a call is up", () => {
        expect(decideSignal(payload(), "call-1")).toEqual({kind: "ignore"});
    });

    it("ignores an offer with no sdp", () => {
        expect(decideSignal(payload({sdp: null}), null)).toEqual({kind: "ignore"});
    });

    it("applies an answer for the matching call", () => {
        expect(decideSignal(payload({action: "answer", sdp: "v=0"}), "call-1")).toEqual({kind: "answer"});
    });

    /// A signal for a different call must never touch the current one.
    it("ignores an answer addressed to another call", () => {
        expect(decideSignal(payload({action: "answer", callId: "other"}), "call-1")).toEqual({kind: "ignore"});
    });

    it("ignores an answer that arrives with no session", () => {
        expect(decideSignal(payload({action: "answer"}), null)).toEqual({kind: "ignore"});
    });

    it("applies ice for the matching call and ignores it otherwise", () => {
        expect(decideSignal(payload({action: "ice", candidate: "{}"}), "call-1")).toEqual({kind: "ice"});
        expect(decideSignal(payload({action: "ice", candidate: "{}"}), "other")).toEqual({kind: "ignore"});
        expect(decideSignal(payload({action: "ice", candidate: null}), "call-1")).toEqual({kind: "ignore"});
    });

    it("ends on a hangup for the matching call only", () => {
        expect(decideSignal(payload({action: "hangup"}), "call-1")).toEqual({kind: "hangup"});
        expect(decideSignal(payload({action: "hangup", callId: "other"}), "call-1")).toEqual({kind: "ignore"});
    });

    it("ignores an unknown action outright", () => {
        expect(decideSignal(payload({action: "nonsense"}), "call-1")).toEqual({kind: "ignore"});
        expect(decideSignal(payload({action: "nonsense"}), null)).toEqual({kind: "ignore"});
    });

    /// A caller that has already sent an offer must not also ring itself.
    it("does not ring when our own offer is echoed back mid-session", () => {
        expect(decideSignal(payload(), "call-1")).toEqual({kind: "ignore"});
    });
});
