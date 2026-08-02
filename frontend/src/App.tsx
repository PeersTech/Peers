import {useEffect, useState} from 'react';
import {servers, dms, messages, dmMessages, type Message} from './data/mock';
import {ServerRail} from './components/ServerRail';
import {ChannelList} from './components/ChannelList';
import {MessagePane} from './components/MessagePane';

export default function App() {
    const [activeServer, setActiveServer] = useState<string>(servers[0].id);
    const [activeDm, setActiveDm] = useState<string | null>(null);
    const [activeChannel, setActiveChannel] = useState<string>(servers[0].channels[0].id);
    const [channelHistory, setChannelHistory] = useState<Record<string, Message[]>>(messages);
    const [dmHistory, setDmHistory] = useState<Record<string, Message[]>>(dmMessages);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                const name = prompt("Jump to channel: /general");
                if (!name) return;
                const target = servers.flatMap((s) => s.channels.map((c) => ({s, c}))).find(({c}) => c.name === name.replace("/", ""));
                if (target) {
                    setActiveServer(target.s.id);
                    setActiveDm(null);
                    setActiveChannel(target.c.id);
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const select = (id: string) => {
        if (id === "__dms__") {
            setActiveDm("dm-alice");
            return;
        }
        setActiveDm(null);
        setActiveServer(id);
        const srv = servers.find((s) => s.id === id)!;
        setActiveChannel(srv.channels[0].id);
    };

    const send = (text: string) => {
        const msg: Message = {
            id: crypto.randomUUID(),
            author: "you",
            authorColor: "#f472b6",
            time: new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}),
            text,
        };
        if (activeDm) {
            setDmHistory((h) => ({...h, [activeDm]: [...(h[activeDm] ?? []), msg]}));
        } else {
            setChannelHistory((h) => ({...h, [activeChannel]: [...(h[activeChannel] ?? []), msg]}));
        }
    };

    const server = servers.find((s) => s.id === activeServer)!;
    const dm = dms.find((d) => d.id === activeDm);
    const paneMessages = dm ? dmHistory[dm.id] ?? [] : channelHistory[activeChannel] ?? [];
    const paneName = dm ? dm.name : server.channels.find((c) => c.id === activeChannel)?.name ?? "";

    return (
        <div className="flex h-full w-full bg-[#0b0d10] text-[#e8eaed]">
            <ServerRail
                servers={servers}
                dms={dms}
                activeServer={activeDm ? null : activeServer}
                activeDm={activeDm}
                onSelect={select}
            />
            {dm ? (
                <div className="flex h-full w-[248px] flex-col bg-[#212226]">
                    <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#17181c] px-4">
                        <span className="font-semibold">Direct messages</span>
                        <span className="flex items-center gap-1 text-xs text-[#4ade80]">
                            <span className="h-2 w-2 rounded-full bg-[#4ade80]"/> online
                        </span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                        {dms.map((d) => (
                            <button
                                key={d.id}
                                onClick={() => setActiveDm(d.id)}
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                                    d.id === activeDm ? "bg-[#3a3d43] text-[#f2f3f5]" : "text-[#a8adb5] hover:bg-[#2b2d31]"
                                }`}
                            >
                                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#3a3d43] text-[10px] font-bold">
                                    {d.name[0].toUpperCase()}
                                </span>
                                <span className="flex-1 truncate">{d.name}</span>
                                {d.unread > 0 && (
                                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#4ade80] px-1 text-[10px] font-bold text-black">{d.unread}</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                <ChannelList
                    server={server}
                    activeChannel={activeChannel}
                    onSelectChannel={setActiveChannel}
                    onSelectDm={() => {}}
                />
            )}
            <MessagePane channelName={paneName} messages={paneMessages} onSend={send}/>
        </div>
    );
}
