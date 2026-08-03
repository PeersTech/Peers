import type {ServerView} from "../lib/api";

interface Props {
    servers: ServerView[];
    dms: {id: string; name: string; unread: number}[];
    activeServer: string | null;
    activeDm: string | null;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onJoin: () => void;
    serverHasUnread: (id: string) => boolean;
    you: string;
}

const roleColor = (role: string) =>
    role === "owner" ? "#4ade80" : role === "admin" ? "#60a5fa" : "#a1a1aa";

export function ServerRail({servers, dms, activeServer, activeDm, onSelect, onCreate, onJoin, serverHasUnread, you}: Props) {
    const dmActive = activeDm !== null;
    const dmUnread = dms.reduce((n, d) => n + d.unread, 0);

    return (
        <div className="flex h-full w-[68px] flex-col items-center gap-2 bg-[#17181c] py-3">
            <button
                onClick={() => onSelect("__dms__")}
                className={`flex h-11 w-11 items-center justify-center rounded-2xl text-lg font-bold transition-all hover:rounded-xl ${
                    dmActive ? "bg-[#4ade80] text-black" : "bg-[#212226] text-[#b9c0c9] hover:bg-[#4ade80]"
                }`}
                title="Direct messages"
            >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.65-.1 2.45-.3l4.7 1.68a.75.75 0 0 0 1-.9l-.92-3.4A9.9 9.9 0 0 0 22 12c0-5.52-4.48-10-10-10zm-3 11a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>
                </svg>
                {dmUnread > 0 && (
                    <span className="absolute -mt-6 ml-7 rounded-full bg-[#fa3e3e] px-1 text-[10px] font-bold text-white">{dmUnread}</span>
                )}
            </button>
            <div className="my-1 h-px w-8 bg-[#2b2d31]"/>
            {servers.map((s) => {
                const active = activeServer === s.id;
                return (
                    <button
                        key={s.id}
                        onClick={() => onSelect(s.id)}
                        className={`relative flex h-11 w-11 items-center justify-center rounded-2xl text-base font-bold transition-all hover:rounded-xl ${
                            active ? "bg-[#4ade80] text-black" : "bg-[#212226] text-[#b9c0c9] hover:bg-[#3a3d43]"
                        }`}
                        title={s.name + (s.pending ? " (joining…)" : "")}
                    >
                        {s.name.slice(0, 2).toUpperCase()}
                        {active && <span className="absolute -left-3 h-6 w-1 rounded-full bg-white"/>}
                        {!active && serverHasUnread(s.id) && (
                            <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full border-2 border-[#17181c] bg-[#4ade80]"/>
                        )}
                    </button>
                );
            })}
            <div className="mt-auto flex flex-col items-center gap-2">
                <button
                    onClick={onCreate}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#212226] text-2xl font-light text-[#4ade80] hover:rounded-xl"
                    title="Create server"
                >
                    +
                </button>
                <button
                    onClick={onJoin}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#212226] text-xl font-bold text-[#60a5fa] hover:rounded-xl"
                    title="Join with an invite"
                >
                    ↓
                </button>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#4ade80] to-[#16a34a] text-sm font-bold text-black"
                 title="You">
                {you[0].toUpperCase()}
            </div>
        </div>
    );
}

export function roleBadge(member: {role: string}) {
    if (member.role === "owner") return <span className="text-[10px]" style={{color: roleColor("owner")}}>●</span>;
    if (member.role === "admin") return <span className="text-[10px]" style={{color: roleColor("admin")}}>◆</span>;
    return null;
}
