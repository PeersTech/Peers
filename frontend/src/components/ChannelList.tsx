import type {Server} from "../data/mock";
import {roleBadge} from "./ServerRail";

interface Props {
    server: Server;
    activeChannel: string;
    onSelectChannel: (id: string) => void;
    onSelectDm: (id: string) => void;
}

export function ChannelList({server, activeChannel, onSelectChannel}: Props) {
    const unreadTotal = server.channels.reduce((n, c) => n + c.unread, 0);
    const online = server.members.filter((m) => m.online).length;

    return (
        <div className="flex h-full w-[248px] flex-col bg-[#212226]">
            <div className="flex h-12 shrink-0 cursor-pointer items-center justify-between border-b border-[#17181c] px-4 shadow-sm">
                <span className="font-semibold text-[#e8eaed]">{server.name}</span>
                <span className="text-xs font-bold text-[#4ade80]">{unreadTotal > 0 ? unreadTotal : ""}</span>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
                <div className="mb-1 px-4 text-[11px] font-bold uppercase tracking-wide text-[#8a8f98]">Text channels</div>
                {server.channels.map((c) => {
                    const active = c.id === activeChannel;
                    return (
                        <button
                            key={c.id}
                            onClick={() => onSelectChannel(c.id)}
                            className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm transition-colors ${
                                active
                                    ? "bg-[#3a3d43] text-[#f2f3f5]"
                                    : "text-[#8a8f98] hover:bg-[#2b2d31] hover:text-[#d4d7dc]"
                            }`}
                        >
                            <span className="text-base leading-none">#</span>
                            <span className="flex-1 truncate">{c.name}</span>
                            {c.unread > 0 && (
                                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#4ade80] px-1 text-[10px] font-bold text-black">
                                    {c.unread}
                                </span>
                            )}
                        </button>
                    );
                })}
                <div className="mb-1 mt-4 px-4 text-[11px] font-bold uppercase tracking-wide text-[#8a8f98]">
                    Members — {online}/{server.members.length}
                </div>
                {server.members.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-3 py-1 text-sm text-[#a8adb5]">
                        <span className="relative flex h-5 w-5 items-center justify-center rounded-full bg-[#3a3d43] text-[10px] font-bold text-[#c9cdd3]">
                            {m.name[0].toUpperCase()}
                            {m.online && <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[#212226] bg-[#4ade80]"/>}
                        </span>
                        <span className="flex-1 truncate">
                            {m.name} <span className="text-[#5a5f66]">{roleBadge(m)}</span>
                        </span>
                    </div>
                ))}
            </div>

            <div className="flex h-14 shrink-0 items-center gap-2 bg-[#17181c] px-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#4ade80] to-[#16a34a] text-xs font-bold text-black">Y</div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[#e8eaed]">you</div>
                    <div className="truncate text-[11px] text-[#8a8f98]">12D3Koo…m7x9</div>
                </div>
                <button title="Verify fingerprint" className="text-[#8a8f98] hover:text-[#4ade80]">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                        <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
                    </svg>
                </button>
            </div>
        </div>
    );
}
