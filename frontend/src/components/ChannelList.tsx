import type {IdentityInfo, JoinNotice, ServerView} from "../lib/api";
import {roleBadge} from "./ServerRail";

interface Props {
    server: ServerView;
    activeChannel: string;
    unreadFor: (channel: string) => number;
    me: IdentityInfo | null;
    joinRequests: JoinNotice[];
    online: Set<string>;
    onSelectChannel: (name: string) => void;
    onInvite: () => void;
    onAddChannel: () => void;
    onAddMember: () => void;
    onAcceptJoin: (n: JoinNotice) => void;
    onRejectJoin: (n: JoinNotice) => void;
    onLeave: () => void;
    onRename: () => void;
    onRotateKey: () => void;
    onKickMember: (peerId: string) => void;
    onPromoteMember: (peerId: string, role: "admin" | "member") => void;
    onExportSnapshot: () => void;
    onImportSnapshot: () => void;
}

export function ChannelList({
    server, activeChannel, unreadFor, me, joinRequests, online, onSelectChannel, onInvite,
    onAddChannel, onAddMember, onAcceptJoin, onRejectJoin, onLeave, onRename, onRotateKey,
    onKickMember, onPromoteMember, onExportSnapshot, onImportSnapshot,
}: Props) {
    const unreadTotal = server.channels.reduce((n, c) => n + unreadFor(c.name), 0);
    const onlineCount = server.members.filter((m) => online.has(m.peerId)).length;
    const manage = server.isOwner;

    return (
        <div className="flex h-full w-[248px] flex-col bg-surface-2">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-surface-1 px-4 shadow-sm">
                <span className="truncate font-semibold text-ink">{server.name}</span>
                <span className="flex items-center gap-1 text-xs font-bold text-online">
                    {unreadTotal > 0 ? unreadTotal : ""}
                    {manage && (
                        <button onClick={onInvite} title="Copy invite" className="rounded p-0.5 text-muted hover:text-white">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M9 11.24V7.5a3 3 0 1 1 6 0v3.74A5 5 0 1 0 9 11.24zM14 7.5v3.9l1.5 1.35a.75.75 0 0 1 .25.55V15a.75.75 0 0 1-.75.75h-6A.75.75 0 0 1 8.5 15v-1.7c0-.21.09-.4.25-.55L10.25 11.4V7.5A1.75 1.75 0 1 1 14 7.5z" transform="translate(2 2) scale(0.85)"/>
                            </svg>
                        </button>
                    )}
                    {manage && (
                        <button onClick={onRename} title="Rename server" className="rounded p-0.5 text-muted hover:text-white">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                            </svg>
                        </button>
                    )}
                    {manage && (
                        <button onClick={onRotateKey} title="Rotate signing key" className="rounded p-0.5 text-muted hover:text-warn">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z"/>
                            </svg>
                        </button>
                    )}
                    {manage && (
                        <button onClick={onExportSnapshot} title="Export signed history snapshot" className="rounded p-0.5 text-muted hover:text-white">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                        </button>
                    )}
                    {manage && (
                        <button onClick={onImportSnapshot} title="Import signed history snapshot" className="rounded p-0.5 text-muted hover:text-white">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                            </svg>
                        </button>
                    )}
                    {manage && (
                        <button onClick={onAddChannel} title="Add channel" className="rounded p-0.5 text-muted hover:text-white">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                        </button>
                    )}
                    {manage && (
                        <button onClick={onAddMember} title="Add member" className="rounded p-0.5 text-muted hover:text-white">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 1a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 1c-3.87 0-7 2.24-7 5v1h14v-1c0-2.76-3.13-5-7-5zm8 1c-1.03 0-2.16.19-3.17.52A6.4 6.4 0 0 1 16 18v2h8v-1c0-2.34-2.54-4.17-5.5-4.17z" opacity="0.85"/>
                            </svg>
                        </button>
                    )}
                    <button onClick={onLeave} title="Leave server" className="rounded p-0.5 text-muted hover:text-red-400">
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                            <path d="M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>
                        </svg>
                    </button>
                </span>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
                {joinRequests.length > 0 && (
                    <div className="mb-2 px-4">
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-warn">
                            Join requests ({joinRequests.length})
                        </div>
                        {joinRequests.map((n) => (
                            <div key={n.peerId} className="mb-1 flex items-center gap-1 rounded bg-surface-3 px-2 py-1">
                                <span className="flex-1 truncate text-xs text-ink-dim">{n.name}</span>
                                <button
                                    onClick={() => onAcceptJoin(n)}
                                    title="Accept"
                                    className="rounded p-0.5 text-online hover:bg-surface-4"
                                >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                                        <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                                    </svg>
                                </button>
                                <button
                                    onClick={() => onRejectJoin(n)}
                                    title="Decline"
                                    className="rounded p-0.5 text-danger hover:bg-surface-4"
                                >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                                        <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="mb-1 px-4 text-[11px] font-bold uppercase tracking-wide text-muted">Text channels</div>
                {server.channels.length === 0 && (
                    <div className="px-4 text-xs text-muted">
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
                                    ? "bg-surface-4 text-ink"
                                    : "text-muted hover:bg-surface-3 hover:text-ink"
                            }`}
                        >
                            <span className="text-base leading-none">#</span>
                            <span className="flex-1 truncate">{c.name}</span>
                            {unread > 0 && (
                                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
                                    {unread}
                                </span>
                            )}
                        </button>
                    );
                })}
                <div className="mb-1 mt-4 px-4 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Members — {onlineCount}/{server.members.length}
                </div>
                {server.members.map((m) => {
                    const isOnline = online.has(m.peerId);
                    const canManage = manage && m.peerId !== me?.peerId;
                    return (
                        <div key={m.peerId} className="group flex items-center gap-2 px-3 py-1 text-sm text-ink-dim">
                            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-4 text-[10px] font-bold text-ink">
                                {m.name[0].toUpperCase()}
                                <span className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-surface-2 ${isOnline ? "bg-online" : "bg-faint"}`}/>
                            </span>
                            <span className="flex-1 truncate">
                                {m.name} <span className="text-faint">{roleBadge(m)}</span>
                            </span>
                            {canManage && (
                                <span className="hidden items-center gap-0.5 group-hover:flex">
                                    {m.role !== "admin" && (
                                        <button onClick={() => onPromoteMember(m.peerId, "admin")} title="Make admin" className="rounded p-0.5 text-muted hover:text-accent">
                                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                                                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                                            </svg>
                                        </button>
                                    )}
                                    {m.role === "admin" && (
                                        <button onClick={() => onPromoteMember(m.peerId, "member")} title="Demote to member" className="rounded p-0.5 text-muted hover:text-warn">
                                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                                                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                                            </svg>
                                        </button>
                                    )}
                                    <button onClick={() => onKickMember(m.peerId)} title="Remove member" className="rounded p-0.5 text-muted hover:text-danger">
                                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                                            <path d="M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>
                                        </svg>
                                    </button>
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>


        </div>
    );
}
