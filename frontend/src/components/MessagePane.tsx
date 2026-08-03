import {useEffect, useRef, useState} from "react";
import type {UiMessage} from "../lib/api";

interface Props {
    channelName: string;
    subtitle: string;
    messages: UiMessage[];
    onSend: (text: string) => void;
}

export function MessagePane({channelName, subtitle, messages, onSend}: Props) {
    const [text, setText] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight});
    }, [messages.length, channelName]);

    const submit = () => {
        const t = text.trim();
        if (!t) return;
        onSend(t);
        setText("");
    };

    return (
        <div className="flex h-full flex-1 flex-col bg-[#26272c]">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[#1e1f22] px-4 shadow-sm">
                <span className="text-lg leading-none text-[#8a8f98]">#</span>
                <span className="font-semibold text-[#e8eaed]">{channelName}</span>
                <span className="ml-auto text-xs text-[#5a5f66]">{subtitle}</span>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
                {messages.map((m, i) => {
                    const firstInBlock = i === 0 || messages[i - 1].author !== m.author;
                    const mine = m.mine;
                    return (
                        <div key={m.id} className={`mb-1 flex gap-3 ${mine ? "flex-row-reverse" : ""}`}>
                            {firstInBlock && (
                                <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-black"
                                     style={{background: m.authorColor}}>
                                    {m.author[0].toUpperCase()}
                                </div>
                            )}
                            {!firstInBlock && <div className="w-8 shrink-0"/>}
                            <div className={`min-w-0 max-w-[70%] ${mine ? "text-right" : ""}`}>
                                {firstInBlock && (
                                    <div className="mb-0.5 flex items-baseline gap-2">
                                        <span className="text-sm font-semibold" style={{color: m.authorColor}}>{m.author}</span>
                                        <span className="text-[10px] text-[#6d7278]">{m.time}</span>
                                    </div>
                                )}
                                <div className={`inline-block rounded-lg px-3 py-1.5 text-left text-sm text-[#e8eaed] ${
                                    mine ? "bg-[#1f8b4c]/30" : "bg-[#31333a]"
                                }`}>
                                    {m.text}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="shrink-0 px-4 pb-4 pt-1">
                <div className="flex items-center gap-2 rounded-lg bg-[#31333a] px-3 py-1.5 focus-within:ring-1 focus-within:ring-[#4ade80]/50">
                    <input
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") submit();
                            if (e.key === "Escape") setText("");
                        }}
                        placeholder={`Message #${channelName}`}
                        className="flex-1 bg-transparent text-sm text-[#e8eaed] placeholder-[#6d7278] outline-none"
                    />
                    <span className="text-[10px] text-[#5a5f66]">ctrl+k</span>
                    <button onClick={submit} className="rounded-md bg-[#4ade80] px-3 py-1 text-sm font-semibold text-black hover:bg-[#86efac]">
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
