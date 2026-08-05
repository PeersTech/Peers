import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from "react";
import {
    colorFor, memberName, parseMentions, shortId, type Contact, type Mention, type UiMessage,
} from "../lib/api";

interface Props {
    channelName: string;
    subtitle: string;
    /** Hover text for the subtitle — used for network detail. */
    subtitleTitle?: string;
    messages: UiMessage[];
    members: Contact[];
    myPeerId: string;
    onSend: (text: string) => void;
    /** Returns an avatar data URL for a peer id, or null to show the color dot. */
    avatarFor?: (peerId: string) => string | null;
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
function MentionPill({peerId, member, dim}: {peerId: string; member?: Contact; dim?: boolean}) {
    if (!member || dim) {
        return (
            <span className="rounded bg-surface-4/50 px-1 text-ink-dim">@{shortId(peerId)}</span>
        );
    }
    return (
        <span className="rounded bg-accent/30 px-1 text-accent">
            @{memberName(member)}
        </span>
    );
}

function MentionText({text, members, dim}: {text: string; members: Contact[]; dim?: boolean}) {
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
    members: Contact[];
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
            <div className="relative rounded-lg bg-surface-3 focus-within:ring-1 focus-within:ring-accent/50">
                {/* Back layer: the visual text with inline blue mention pills. */}
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-1.5 text-sm leading-5 text-ink"
                >
                    {value.length === 0 ? (
                        <span className="text-faint">{placeholder}</span>
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
                <span className="text-[10px] text-faint">@ for mention · ctrl+k</span>
                <button onClick={submit} className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white hover:bg-accent-hover">
                    Send
                </button>
            </div>
            {query && candidates.length > 0 && (
                <div className="absolute bottom-full left-4 right-4 mb-2 max-h-48 overflow-y-auto rounded-lg border border-surface-1 bg-surface-2 p-1 shadow-xl">
                    {candidates.map((m, i) => (
                        <button
                            key={m.peerId}
                            onClick={() => insertMention(m.peerId)}
                            onMouseEnter={() => setSel(i)}
                            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                                i === sel ? "bg-surface-4" : ""
                            }`}
                        >
                            <span
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-black"
                                style={{background: colorFor(m.peerId)}}
                            >
                                {memberName(m)[0].toUpperCase()}
                            </span>
                            <span className="flex-1 truncate text-ink">{memberName(m)}</span>
                            <span className="text-[10px] text-faint">{shortId(m.peerId)}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function MessagePane({channelName, subtitle, subtitleTitle, messages, members, myPeerId, onSend, avatarFor}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    /** True when the user is parked at the bottom and wants to follow along.
     *  Scrolling up to read history sets this false, so an incoming message
     *  no longer yanks the view back down. */
    const following = useRef(true);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        const slack = el.scrollHeight - el.scrollTop - el.clientHeight;
        following.current = slack < 80;
    };

    // Follow new messages, and always jump to the bottom when the view swaps.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !following.current) return;
        el.scrollTo({top: el.scrollHeight});
    }, [messages.length, channelName]);

    useEffect(() => {
        following.current = true;
        const el = scrollRef.current;
        el?.scrollTo({top: el.scrollHeight});
    }, [channelName]);

    return (
        <div className="flex h-full flex-1 flex-col bg-surface-1">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-4 shadow-sm">
                <span className="text-lg leading-none text-muted">#</span>
                <span className="font-semibold text-ink">{channelName}</span>
                <span
                    className="ml-auto whitespace-pre-line text-xs text-faint"
                    title={subtitleTitle}
                >
                    {subtitle}
                </span>
            </div>

            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="flex-1 overflow-y-auto px-4 py-3"
            >
                {messages.map((m, i) => {
                    const firstInBlock = i === 0 || messages[i - 1].author !== m.author;
                    const mine = m.mine;
                    const pinged = m.mentionsMe && !mine;
                    return (
                        <div
                            key={m.id}
                            className={`mb-1 flex gap-3 ${mine ? "flex-row-reverse" : ""} ${
                                pinged ? "rounded-lg border-l-2 border-warn bg-accent/10 px-1" : ""
                            }`}
                        >
                            {firstInBlock && (
                                // Plain DMs carry no authorPeer, so there is no
                                // avatar to look up — fall back to the color dot.
                                avatarFor && m.authorPeer ? (
                                    <div className="mt-1 h-8 w-8 shrink-0 overflow-hidden rounded-full">
                                        {avatarFor(m.authorPeer) ? (
                                            <img
                                                src={avatarFor(m.authorPeer) as string}
                                                alt=""
                                                className="h-full w-full object-cover"
                                            />
                                        ) : (
                                            <div className="flex h-full w-full items-center justify-center text-xs font-bold text-black"
                                                 style={{background: m.authorColor}}>
                                                {m.author[0].toUpperCase()}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-black"
                                         style={{background: m.authorColor}}>
                                        {m.author[0].toUpperCase()}
                                    </div>
                                )
                            )}
                            {!firstInBlock && <div className="w-8 shrink-0"/>}
                            <div className={`min-w-0 max-w-[70%] ${mine ? "text-right" : ""}`}>
                                {firstInBlock && (
                                    <div className="mb-0.5 flex items-baseline gap-2">
                                        <span className="text-sm font-semibold" style={{color: m.authorColor}}>{m.author}</span>
                                        <span className="text-[10px] text-faint">{m.time}</span>
                                        {pinged && <span className="text-[10px] font-bold text-warn">@ you</span>}
                                    </div>
                                )}
                                <div className={`inline-block rounded-lg px-3 py-1.5 text-left text-sm ${
                                    mine ? "bg-accent text-white" : "bg-surface-3 text-ink"
                                }`}>
                                    {mine ? <MentionText text={m.text} members={members} dim/> : <MentionText text={m.text} members={members}/>}
                                </div>
                            </div>
                        </div>
                    );
                })}
                {messages.length === 0 && (
                    <div className="flex h-full items-center justify-center text-xs text-faint">
                        No messages yet — say hi with a {channelName ? `#${channelName}` : "channel"} ping.
                    </div>
                )}
            </div>

            <MentionComposer members={members} onSend={onSend} placeholder={`Message #${channelName}`}/>
        </div>
    );
}
