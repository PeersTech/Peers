import {THEME, type ServerView} from "../lib/api";

interface Props {
    servers: ServerView[];
    dms: {id: string; name: string; unread: number}[];
    activeServer: string | null;
    activeDm: string | null;
    plazaActive: boolean;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onJoin: () => void;
    serverHasUnread: (id: string) => boolean;
    you: string;
    youFull: string;
    onCopyYou: () => void;
    onOpenSettings: () => void;
    onAddFriend: () => void;
}

const roleColor = (role: string) =>
    role === "owner" ? THEME.online : role === "admin" ? THEME.accent : THEME.muted;

export function ServerRail({servers, dms, activeServer, activeDm, plazaActive, onSelect, onCreate, onJoin, serverHasUnread, you, youFull, onCopyYou, onOpenSettings, onAddFriend}: Props) {
    const dmActive = activeDm !== null;
    const dmUnread = dms.reduce((n, d) => n + d.unread, 0);

    return (
        <div className="flex h-full w-[68px] flex-col items-center gap-2 bg-surface-1 py-3">
            <button
                onClick={() => onSelect("__dms__")}
                className={`flex h-11 w-11 items-center justify-center rounded-2xl text-lg font-bold transition-all hover:rounded-xl ${
                    dmActive ? "bg-accent text-white" : "bg-surface-2 text-ink hover:bg-accent hover:text-white"
                }`}
                title="Direct messages"
                aria-label="Direct messages"
            >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.65-.1 2.45-.3l4.7 1.68a.75.75 0 0 0 1-.9l-.92-3.4A9.9 9.9 0 0 0 22 12c0-5.52-4.48-10-10-10zm-3 11a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>
                </svg>
                {dmUnread > 0 && (
                    <span className="absolute -mt-6 ml-7 rounded-full bg-danger px-1 text-[10px] font-bold text-white">{dmUnread}</span>
                )}
            </button>
            <button
                onClick={() => onSelect("__plaza__")}
                className={`flex h-11 w-11 items-center justify-center rounded-2xl transition-all hover:rounded-xl ${
                    plazaActive ? "bg-accent text-white" : "bg-surface-2 text-accent hover:bg-accent hover:text-white"
                }`}
                title="Plaza — public channel"
                aria-label="Plaza — public channel"
            >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                    <path d="M12 2a5 5 0 0 0-5 5c0 .6.1 1.2.3 1.7A4.5 4.5 0 0 0 3 13v2a1 1 0 0 0 1 1h2.2a6 6 0 0 0 11.6 0H20a1 1 0 0 0 1-1v-2a4.5 4.5 0 0 0-4.3-4.3c.2-.5.3-1.1.3-1.7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3c0 .4-.1.8-.2 1.1l-.3.9h-5l-.3-.9A3 3 0 0 1 9 7a3 3 0 0 1 3-3z"/>
                </svg>
            </button>
            <div className="my-1 h-px w-8 bg-surface-3"/>
            {servers.map((s) => {
                const active = activeServer === s.id;
                return (
                    <button
                        key={s.id}
                        onClick={() => onSelect(s.id)}
                        className={`relative flex h-11 w-11 items-center justify-center rounded-2xl text-base font-bold transition-all hover:rounded-xl ${
                            active ? "bg-accent text-white" : "bg-surface-2 text-ink hover:bg-surface-4"
                        }`}
                        title={s.name + (s.pending ? " (joining…)" : "")}
                        aria-label={s.name + (s.pending ? " (joining…)" : "")}
                    >
                        {s.name.slice(0, 2).toUpperCase()}
                        {active && <span className="absolute -left-3 h-6 w-1 rounded-full bg-white"/>}
                        {!active && serverHasUnread(s.id) && (
                            <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full border-2 border-surface-1 bg-online"/>
                        )}
                    </button>
                );
            })}
            <div className="mt-auto flex flex-col items-center gap-2">
                <button
                    onClick={onAddFriend}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-2 text-accent hover:rounded-xl hover:bg-surface-3"
                    title="Add a friend by code"
                >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                        <path d="M15 14c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm0-2a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 10V7H3v3H0v2h3v3h2v-3h3v-2H5z"/>
                    </svg>
                </button>
                <button
                    onClick={onCreate}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-2 text-2xl font-light text-online hover:rounded-xl"
                    title="Create server"
                >
                    +
                </button>
                <button
                    onClick={onJoin}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-2 text-xl font-bold text-accent hover:rounded-xl"
                    title="Join with an invite"
                >
                    ↓
                </button>
            </div>
            <button
                onClick={onOpenSettings}
                title="Profile & settings"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-ink-dim hover:bg-surface-3 hover:text-ink"
            >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                    <path d="M19.14 12.94a7.5 7.5 0 0 0 .05-.94c0-.32-.02-.63-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.4 7.4 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 9.78a.5.5 0 0 0 .12.64l2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.33.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.24.42.5.42h3.84c.26 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.2.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>
                </svg>
            </button>
            <button
                onClick={onCopyYou}
                title={`You · ${youFull || "…"} — click to copy`}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-online to-online text-sm font-bold text-black hover:opacity-90"
            >
                {you[0].toUpperCase()}
            </button>
        </div>
    );
}

export function roleBadge(member: {role: string}) {
    if (member.role === "owner") return <span className="text-[10px]" style={{color: roleColor("owner")}}>●</span>;
    if (member.role === "admin") return <span className="text-[10px]" style={{color: roleColor("admin")}}>◆</span>;
    return null;
}
