import type {IdentityInfo, JoinNotice, ServerView} from "../lib/api";
import {roleBadge} from "./ServerRail";

interface Props {
    server: ServerView;
    activeChannel: string;
    unreadFor: (channel: string) => number;
    me: IdentityInfo | null;
    joinRequests: JoinNotice[];
    onSelectChannel: (name: string) => void;
    onInvite: () => void;
    onAddChannel: () => void;
    onAddMember: () => void;
    onAcceptJoin: (n: JoinNotice) => void;
    onRejectJoin: (n: JoinNotice) => void;
    onLeave: () => void;
}

export function ChannelList({
    server, activeChannel, unreadFor, me, joinRequests, onSelectChannel, onInvite, onAddChannel,
    onAddMember, onAcceptJoin, onRejectJoin, onLeave,
}: Props) {
    const unreadTotal = server.channels.reduce((n, c) => n + unreadFor(c.name), 0);
    const online = server.members.filter((m) => m.peerId === me?.peerId).length;

    return (
        <div className="flex h-full w-[248px] flex-col bg-[#212226]">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#17181c] px-4 shadow-sm">
                <span className="truncate font-semibold text-[#e8eaed]">{server.name}</span>
                <span className="flex items-center gap-1 text-xs font-bold text-[#4ade80]">
                    {unreadTotal > 0 ? unreadTotal : ""}
                    {server.isOwner && (
                        <button onClick={onInvite} title="Copy invite" className="rounded p-0.5 text-[#8a8f98] hover:text-[#4ade80]">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M9 11.24V7.5a3 3 0 1 1 6 0v3.74A5 5 0 1 0 9 11.24zM14 7.5v3.9l1.5 1.35a.75.75 0 0 1 .25.55V15a.75.75 0 0 1-.75.75h-6A.75.75 0 0 1 8.5 15v-1.7c0-.21.09-.4.25-.55L10.25 11.4V7.5A1.75 1.75 0 1 1 14 7.5z" transform="translate(2 2) scale(0.85)"/>
                            </svg>
                        </button>
                    )}
                    {server.isOwner && (
                        <button onClick={onAddChannel} title="Add channel" className="rounded p-0.5 text-[#8a8f98] hover:text-[#4ade80]">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                        </button>
                    )}
                    {server.isOwner && (
                        <button onClick={onAddMember} title="Add member" className="rounded p-0.5 text-[#8a8f98] hover:text-[#4ade80]">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 1a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 1c-3.87 0-7 2.24-7 5v1h14v-1c0-2.76-3.13-5-7-5zm8 1c-1.03 0-2.16.19-3.17.52A6.4 6.4 0 0 1 16 18v2h8v-1c0-2.34-2.54-4.17-5.5-4.17z" opacity="0.85"/>
                            </svg>
                        </button>
                    )}
                    <button onClick={onLeave} title="Leave server" className="rounded p-0.5 text-[#8a8f98] hover:text-red-400">
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                            <path d="M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>
                        </svg>
                    </button>
                </span>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
                {joinRequests.length > 0 && (
                    <div className="mb-2 px-4">
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[#facc15]">
                            Join requests ({joinRequests.length})
                        </div>
                        {joinRequests.map((n) => (
                            <div key={n.peerId} className="mb-1 flex items-center gap-1 rounded bg-[#2b2d31] px-2 py-1">
                                <span className="flex-1 truncate text-xs text-[#a8adb5]">{n.name}</span>
                                <button
                                    onClick={() => onAcceptJoin(n)}
                                    title="Accept"
                                    className="rounded p-0.5 text-[#4ade80] hover:bg-[#3a3d43]"
                                >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                                        <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                                    </svg>
                                </button>
                                <button
                                    onClick={() => onRejectJoin(n)}
                                    title="Decline"
                                    className="rounded p-0.5 text-[#fa3e3e] hover:bg-[#3a3d43]"
                                >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                                        <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="mb-1 px-4 text-[11px] font-bold uppercase tracking-wide text-[#8a8f98]">Text channels</div>
                {server.channels.length === 0 && (
                    <div className="px-4 text-xs text-[#8a8f98]">
                        {server.pending ? "Waiting for the owner's member list…" : "No channels yet"}
                    </div>
                )}
                {server.channels.map((c) => {
                    const active = c.name === activeChannel;
                    const unread = unreadFor(c.name);
                    return (
                        <button
                            key={c.name}
                            onClick={() => onSelectChannel(c.name)}
                            className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm transition-colors ${
                                active
                                    ? "bg-[#3a3d43] text-[#f2f3f5]"
                                    : "text-[#8a8f98] hover:bg-[#2b2d31] hover:text-[#d4d7dc]"
                            }`}
                        >
                            <span className="text-base leading-none">#</span>
                            <span className="flex-1 truncate">{c.name}</span>
                            {unread > 0 && (
                                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#4ade80] px-1 text-[10px] font-bold text-black">
                                    {unread}
                                </span>
                            )}
                        </button>
                    );
                })}
                <div className="mb-1 mt-4 px-4 text-[11px] font-bold uppercase tracking-wide text-[#8a8f98]">
                    Members — {online}/{server.members.length}
                </div>
                {server.members.map((m) => (
                    <div key={m.peerId} className="flex items-center gap-2 px-3 py-1 text-sm text-[#a8adb5]">
                        <span className="relative flex h-5 w-5 items-center justify-center rounded-full bg-[#3a3d43] text-[10px] font-bold text-[#c9cdd3]">
                            {m.name[0].toUpperCase()}
                            {m.peerId === me?.peerId && <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[#212226] bg-[#4ade80]"/>}
                        </span>
                        <span className="flex-1 truncate">
                            {m.name} <span className="text-[#5a5f66]">{roleBadge(m)}</span>
                        </span>
                    </div>
                ))}
            </div>

            <div className="flex h-14 shrink-0 items-center gap-2 bg-[#17181c] px-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#4ade80] to-[#16a34a] text-xs font-bold text-black">
                    {me?.peerIdShort[0].toUpperCase() ?? "Y"}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[#e8eaed]">you</div>
                    <div className="truncate text-[11px] text-[#8a8f98]">{me?.peerIdShort ?? "…"}</div>
                </div>
                <button title={`Fingerprint: ${me?.fingerprint ?? "…"}`} className="text-[#8a8f98] hover:text-[#4ade80]">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                        <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
                    </svg>
                </button>
            </div>
        </div>
    );
}
