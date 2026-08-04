import {useMemo, useRef, useState, type KeyboardEvent} from "react";
import {
    memberName, parseMentions, shortId, type Member, type Mention, type UiMessage,
} from "../lib/api";

interface Props {
    channelName: string;
    subtitle: string;
    messages: UiMessage[];
    members: Member[];
    myPeerId: string;
    onSend: (text: string) => void;
}

function splitText(text: string, mentions: Mention[]) {
    const segs: {text: string; mention?: Mention}[] = [];
    let last = 0;
    for (const m of mentions) {
        if (m.start > last) segs.push({text: text.slice(last, m.start)});
        segs.push({text: text.slice(m.start, m.end), mention: m});
        last = m.end;
    }
    if (last < text.length) segs.push({text: text.slice(last)});
    return segs;
}

/** A rendered @mention. Member → blue ping pill; non-member → gray (not a ping). */
function MentionPill({peerId, member, dim}: {peerId: string; member?: Member; dim?: boolean}) {
    if (!member || dim) {
        return (
            <span className="rounded bg-[#4f545c]/50 px-1 text-[#b5bac1]">@{shortId(peerId)}</span>
        );
    }
    return (
        <span className="rounded bg-[#5865f2]/30 px-1 text-[#c0c7ff]">
            @{memberName(member)}
        </span>
    );
}

function MentionText({text, members, dim}: {text: string; members: Member[]; dim?: boolean}) {
    const mentions = useMemo(() => parseMentions(text, members), [text, members]);
    const segs = useMemo(() => splitText(text, mentions), [text, mentions]);
    return (
        <>
            {segs.map((s, i) =>
                s.mention ? (
                    <MentionPill key={i} peerId={s.mention.peerId} member={s.mention.member} dim={dim}/>
                ) : (
                    <span key={i}>{s.text}</span>
                ),
            )}
        </>
    );
}

/** Composer with @-autocomplete. The visible layer renders mention pills
 *  inline (the blue box) while a transparent textarea drives the caret. */
function MentionComposer({
    members,
    onSend,
    placeholder,
}: {
    members: Member[];
    onSend: (text: string) => void;
    placeholder: string;
}) {
    const [value, setValue] = useState("");
    const [query, setQuery] = useState<{at: number; term: string} | null>(null);
    const [sel, setSel] = useState(0);
    const taRef = useRef<HTMLTextAreaElement>(null);

    const mentions = useMemo(() => parseMentions(value, members), [value, members]);
    const segs = useMemo(() => splitText(value, mentions), [value, mentions]);

    const candidates = useMemo(() => {
        if (!query) return [];
        const t = query.term.toLowerCase();
        return members.filter(
            (m) =>
                memberName(m).toLowerCase().includes(t) ||
                m.peerId.toLowerCase().includes(t.toLowerCase()),
        );
    }, [query, members]);

    const update = (v: string, caretPos: number) => {
        setValue(v);
        const before = v.slice(0, caretPos);
        const m = before.match(/@([0-9A-Za-z]*)$/);
        if (m) {
            setQuery({at: caretPos - m[0].length, term: m[1]});
            setSel(0);
        } else {
            setQuery(null);
        }
    };

    const insertMention = (peerId: string) => {
        if (!query) return;
        const next =
            value.slice(0, query.at) +
            `@${peerId} ` +
            value.slice(query.at + query.term.length + 1);
        setValue(next);
        setQuery(null);
        taRef.current?.focus();
    };

    const submit = () => {
        const t = value.trim();
        if (!t) return;
        onSend(t);
        setValue("");
        setQuery(null);
        if (taRef.current) taRef.current.style.height = "";
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (query && candidates.length > 0) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => (s + 1) % candidates.length);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => (s - 1 + candidates.length) % candidates.length);
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertMention(candidates[sel].peerId);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setQuery(null);
                return;
            }
        }
        if (e.key === "Enter") {
            e.preventDefault();
            submit();
        }
        if (e.key === "Escape") {
            setValue("");
            setQuery(null);
        }
    };

    const autoHeight = (ta: HTMLTextAreaElement) => {
        ta.style.height = "";
        ta.style.height = `${ta.scrollHeight}px`;
    };

    return (
        <div className="relative shrink-0 px-4 pb-4 pt-1">
            <div className="relative rounded-lg bg-[#383a40] focus-within:ring-1 focus-within:ring-[#5865f2]/50">
                {/* Back layer: the visual text with inline blue mention pills. */}
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-1.5 text-sm leading-5 text-[#f2f3f5]"
                >
                    {value.length === 0 ? (
                        <span className="text-[#80848e]">{placeholder}</span>
                    ) : (
                        segs.map((s, i) =>
                            s.mention ? (
                                <MentionPill key={i} peerId={s.mention.peerId} member={s.mention.member}/>
                            ) : (
                                <span key={i} className="whitespace-pre-wrap break-words">{s.text}</span>
                            ),
                        )
                    )}
                </div>
                {/* Transparent textarea: drives typing, caret and layout height. */}
                <textarea
                    ref={taRef}
                    value={value}
                    rows={1}
                    onChange={(e) => {
                        update(e.target.value, e.target.selectionStart ?? e.target.value.length);
                        autoHeight(e.target);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder=""
                    className="block w-full resize-none overflow-hidden bg-transparent px-3 py-1.5 text-sm leading-5 text-transparent caret-white outline-none"
                />
            </div>
            <div className="mt-1 flex items-center justify-between">
                <span className="text-[10px] text-[#80848e]">@ for mention · ctrl+k</span>
                <button onClick={submit} className="rounded-md bg-[#5865f2] px-3 py-1 text-sm font-semibold text-white hover:bg-[#4752c4]">
                    Send
                </button>
            </div>
            {query && candidates.length > 0 && (
                <div className="absolute bottom-full left-4 right-4 mb-2 max-h-48 overflow-y-auto rounded-lg border border-[#1e1f22] bg-[#2b2d31] p-1 shadow-xl">
                    {candidates.map((m, i) => (
                        <button
                            key={m.peerId}
                            onClick={() => insertMention(m.peerId)}
                            onMouseEnter={() => setSel(i)}
                            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                                i === sel ? "bg-[#404249]" : ""
                            }`}
                        >
                            <span
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-black"
                                style={{background: hashColor(m.peerId)}}
                            >
                                {memberName(m)[0].toUpperCase()}
                            </span>
                            <span className="flex-1 truncate text-[#f2f3f5]">{memberName(m)}</span>
                            <span className="text-[10px] text-[#80848e]">{shortId(m.peerId)}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function hashColor(s: string) {
    const palette = ["#5865f2", "#23a55a", "#eb459e", "#f0b232", "#faa61a", "#b18cff", "#1abc9c", "#f23f43"];
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
}

export function MessagePane({channelName, subtitle, messages, members, myPeerId, onSend}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);

    // Scroll when messages change or the view swaps.
    const [prevLen, setPrevLen] = useState(0);
    if (messages.length !== prevLen) {
        setPrevLen(messages.length);
        setTimeout(() => scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight}), 0);
    }
    useEffectScroll(scrollRef);

    return (
        <div className="flex h-full flex-1 flex-col bg-[#313338]">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[#26272c] px-4 shadow-sm">
                <span className="text-lg leading-none text-[#949ba4]">#</span>
                <span className="font-semibold text-[#f2f3f5]">{channelName}</span>
                <span className="ml-auto text-xs text-[#80848e]">{subtitle}</span>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
                {messages.map((m, i) => {
                    const firstInBlock = i === 0 || messages[i - 1].author !== m.author;
                    const mine = m.mine;
                    const pinged = m.mentionsMe && !mine;
                    return (
                        <div
                            key={m.id}
                            className={`mb-1 flex gap-3 ${mine ? "flex-row-reverse" : ""} ${
                                pinged ? "rounded-lg border-l-2 border-[#f0b232] bg-[#5865f2]/10 px-1" : ""
                            }`}
                        >
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
                                        <span className="text-[10px] text-[#80848e]">{m.time}</span>
                                        {pinged && <span className="text-[10px] font-bold text-[#f0b232]">@ you</span>}
                                    </div>
                                )}
                                <div className={`inline-block rounded-lg px-3 py-1.5 text-left text-sm ${
                                    mine ? "bg-[#5865f2] text-white" : "bg-[#383a40] text-[#f2f3f5]"
                                }`}>
                                    {mine ? <MentionText text={m.text} members={members} dim/> : <MentionText text={m.text} members={members}/>}
                                </div>
                            </div>
                        </div>
                    );
                })}
                {messages.length === 0 && (
                    <div className="flex h-full items-center justify-center text-xs text-[#80848e]">
                        No messages yet — say hi with a {channelName ? `#${channelName}` : "channel"} ping.
                    </div>
                )}
            </div>

            <MentionComposer members={members} onSend={onSend} placeholder={`Message #${channelName}`}/>
        </div>
    );
}

function useEffectScroll(ref: {current: HTMLDivElement | null}) {
    useMemo(() => {
        ref.current?.scrollTo({top: ref.current.scrollHeight});
    }, []);
}
