import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from "react";
import {
    bytesToBase64, colorFor, memberName, parseMentions, shortId, type Contact, type Mention, type ServerMessageKind,
    type UiMessage,
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
    onReply: (text: string, target: UiMessage) => void;
    onAction: (
        kind: Exclude<ServerMessageKind, "chat" | "">,
        target: UiMessage,
        text?: string,
        reaction?: string,
    ) => void;
    actionsEnabled?: boolean;
    attachmentsEnabled?: boolean;
    onAttach: (file: File) => void;
    onDownloadAttachment: (hash: string, name: string) => void;
    onStartCall?: () => void;
    getAttachmentData?: (hash: string) => number[] | undefined;
    uploadingAttachment?: string | null;
    outboxPending?: number;
    onRetryOutbox?: () => void;
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
    replyTo,
    onCancelReply,
    draftKey,
    onAttach,
    canAttach,
    uploadingAttachment,
}: {
    members: Contact[];
    onSend: (text: string) => void;
    placeholder: string;
    replyTo?: UiMessage;
    onCancelReply: () => void;
    draftKey: string;
    onAttach: (file: File) => void;
    canAttach: boolean;
    uploadingAttachment?: string | null;
}) {
    const [value, setValue] = useState("");
    const [query, setQuery] = useState<{at: number; term: string} | null>(null);
    const [sel, setSel] = useState(0);
    const taRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        try {
            setValue(window.localStorage.getItem(`peers-draft:${draftKey}`) ?? "");
        } catch {
            setValue("");
        }
        setQuery(null);
    }, [draftKey]);

    useEffect(() => {
        try {
            if (value) window.localStorage.setItem(`peers-draft:${draftKey}`, value);
            else window.localStorage.removeItem(`peers-draft:${draftKey}`);
        } catch {
            // Draft persistence is best effort.
        }
    }, [draftKey, value]);

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
            {replyTo && (
                <div className="mb-1 flex items-center gap-2 rounded-md border-l-2 border-accent bg-surface-3 px-2 py-1 text-xs text-muted">
                    <span className="shrink-0 text-faint">Replying to {replyTo.author}</span>
                    <span className="min-w-0 flex-1 truncate">{replyTo.text}</span>
                    <button onClick={onCancelReply} className="text-faint hover:text-ink" title="Cancel reply">×</button>
                </div>
            )}
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
                <div className="flex items-center gap-1">
                    {uploadingAttachment && (
                        <span className="max-w-[15rem] truncate px-2 py-1 text-[10px] text-faint" title={uploadingAttachment}>
                            Uploading {uploadingAttachment}…
                        </span>
                    )}
                    {canAttach && !uploadingAttachment && (
                        <label className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-4 hover:text-ink" title="Attach a file (up to 8 MiB in DMs and groups; 64 KiB in channels)">
                            Attach
                            <input
                                type="file"
                                className="hidden"
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    if (file) onAttach(file);
                                    event.target.value = "";
                                }}
                            />
                        </label>
                    )}
                    <button onClick={submit} className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white hover:bg-accent-hover">
                        Send
                    </button>
                </div>
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

export function MessagePane({
    channelName, subtitle, subtitleTitle, messages, members, myPeerId, onSend, onReply, onAction, actionsEnabled, attachmentsEnabled, onAttach, onDownloadAttachment, onStartCall, getAttachmentData, uploadingAttachment, outboxPending = 0, onRetryOutbox, avatarFor,
}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const canAct = actionsEnabled ?? false;
    const canAttach = attachmentsEnabled ?? false;
    const searchRef = useRef<HTMLInputElement>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [replyTo, setReplyTo] = useState<UiMessage | undefined>();
    const [editing, setEditing] = useState<{id: string; value: string} | null>(null);
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

    useEffect(() => {
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setSearchOpen(true);
                requestAnimationFrame(() => searchRef.current?.focus());
            }
            if (event.key === "Escape" && searchOpen) {
                setSearchQuery("");
                setSearchOpen(false);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [searchOpen]);

    const displayedMessages = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return messages;
        return messages.filter((message) =>
            `${message.text} ${message.attachmentName ?? ""}`.toLowerCase().includes(query),
        );
    }, [messages, searchQuery]);

    const closeSearch = () => {
        setSearchQuery("");
        setSearchOpen(false);
    };

    const submit = (text: string) => {
        if (replyTo) {
            onReply(text, replyTo);
            setReplyTo(undefined);
        } else {
            onSend(text);
        }
    };

    // Follow new messages, and always jump to the bottom when the view swaps.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !following.current) return;
        el.scrollTo({top: el.scrollHeight});
    }, [displayedMessages.length, channelName]);

    useEffect(() => {
        following.current = true;
        setReplyTo(undefined);
        setEditing(null);
        const el = scrollRef.current;
        el?.scrollTo({top: el.scrollHeight});
    }, [channelName]);

    return (
        <div className="flex h-full flex-1 flex-col bg-surface-1">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-4 shadow-sm">
                <span className="text-lg leading-none text-muted">#</span>
                <span className="font-semibold text-ink">{channelName}</span>
                {outboxPending > 0 && onRetryOutbox && (
                    <button
                        type="button"
                        onClick={onRetryOutbox}
                        title="Retry queued messages"
                        className="whitespace-nowrap rounded bg-warn/15 px-2 py-1 text-[10px] font-semibold text-warn hover:bg-warn/25"
                    >
                        Retry {outboxPending} queued
                    </button>
                )}
                {searchOpen && (
                    <div className="ml-3 flex min-w-0 flex-1 items-center gap-2">
                        <input
                            ref={searchRef}
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="Search this conversation"
                            aria-label="Search this conversation"
                            className="min-w-0 flex-1 rounded-md border border-edge bg-surface-3 px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                        />
                        <span className="whitespace-nowrap text-[10px] text-faint">
                            {searchQuery.trim()
                                ? `${displayedMessages.length} result${displayedMessages.length === 1 ? "" : "s"}`
                                : "Esc to close"}
                        </span>
                        <button
                            onClick={closeSearch}
                            title="Close search"
                            className="rounded p-1 text-muted hover:bg-surface-3 hover:text-ink"
                        >
                            ×
                        </button>
                    </div>
                )}
                {onStartCall && (
                    <button
                        type="button"
                        onClick={onStartCall}
                        title="Start a video call"
                        className="rounded p-1 text-muted hover:bg-surface-3 hover:text-ink"
                    >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M15 10l4.6-2.3A1 1 0 0 1 21 8.5v7a1 1 0 0 1-1.4.9L15 14" strokeLinecap="round" strokeLinejoin="round"/>
                            <rect x="3" y="6" width="12" height="12" rx="2"/>
                        </svg>
                    </button>
                )}
                {!searchOpen && (
                    <button
                        onClick={() => {
                            setSearchOpen(true);
                            requestAnimationFrame(() => searchRef.current?.focus());
                        }}
                        title="Search (Ctrl+K)"
                        className="ml-auto rounded p-1 text-muted hover:bg-surface-3 hover:text-ink"
                    >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="6" />
                            <path d="m16 16 4 4" strokeLinecap="round" />
                        </svg>
                    </button>
                )}
                <span
                    className={`whitespace-pre-line text-xs text-faint ${searchOpen ? "ml-2" : "ml-auto"}`}
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
                {displayedMessages.map((m, i) => {
                    const firstInBlock = i === 0 || displayedMessages[i - 1].author !== m.author;
                    const mine = m.mine;
                    const pinged = m.mentionsMe && !mine;
                    const attachmentData = m.attachmentHash && m.attachmentMime?.startsWith("image/")
                        ? getAttachmentData?.(m.attachmentHash)
                        : undefined;
                    const preview = attachmentData
                        ? `data:${m.attachmentMime};base64,${bytesToBase64(attachmentData)}`
                        : undefined;
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
                            <div className={`group relative min-w-0 max-w-[70%] ${mine ? "text-right" : ""}`}>
                                {firstInBlock && (
                                    <div className="mb-0.5 flex items-baseline gap-2">
                                        <span className="text-sm font-semibold" style={{color: m.authorColor}}>{m.author}</span>
                                        <span className="text-[10px] text-faint">{m.time}</span>
                                        {pinged && <span className="text-[10px] font-bold text-warn">@ you</span>}
                                        {m.edited && <span className="text-[10px] text-faint">edited</span>}
                                        {mine && m.delivery && <span className="text-[10px] text-faint">{m.delivery}</span>}
                                        {mine && m.read && <span className="text-[10px] text-faint">read</span>}
                                    </div>
                                )}
                                {m.pinned && <div className="mb-1 text-[10px] font-bold text-accent">Pinned</div>}
                                {m.replyText && (
                                    <div className="mb-1 border-l-2 border-accent pl-2 text-left text-[11px] text-muted">
                                        Replying to {m.author}: {m.replyText}
                                    </div>
                                )}
                                <div className="relative inline-block max-w-full text-left">
                                    {editing?.id === m.id ? (
                                        <div className="min-w-64 rounded-lg bg-surface-3 p-2">
                                            <textarea
                                                value={editing.value}
                                                onChange={(event) => setEditing({id: m.id, value: event.target.value})}
                                                rows={3}
                                                autoFocus
                                                className="w-full resize-none rounded bg-surface-1 p-2 text-sm text-ink outline-none"
                                            />
                                            <div className="mt-1 flex justify-end gap-1 text-xs">
                                                <button onClick={() => setEditing(null)} className="rounded px-2 py-1 text-muted hover:bg-surface-4">Cancel</button>
                                                <button
                                                    onClick={() => {
                                                        onAction("edit", m, editing.value);
                                                        setEditing(null);
                                                    }}
                                                    className="rounded bg-accent px-2 py-1 font-semibold text-white"
                                                >Save</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className={`inline-block max-w-full rounded-lg px-3 py-1.5 text-left text-sm ${
                                            mine ? "bg-accent text-white" : "bg-surface-3 text-ink"
                                        }`}>
                                            {mine ? <MentionText text={m.text} members={members} dim/> : <MentionText text={m.text} members={members}/>}
                                            {m.attachmentHash && (
                                                <button
                                                    onClick={() => onDownloadAttachment(m.attachmentHash as string, m.attachmentName || "attachment")}
                                                    title={`${m.attachmentName || "attachment"} · ${m.attachmentEncrypted ? "E2E encrypted attachment" : "DHT attachment; not E2E encrypted"}`}
                                                    className="mt-2 flex w-full items-center gap-2 rounded border border-white/20 bg-black/10 px-2 py-1 text-left text-xs hover:bg-black/20"
                                                >
                                                    {preview ? (
                                                        <img src={preview} alt={m.attachmentName || "image attachment"} className="max-h-48 max-w-full rounded object-contain" />
                                                    ) : (
                                                        <span>▧</span>
                                                    )}
                                                    <span className="min-w-0 flex-1 truncate">{m.attachmentName || "attachment"}</span>
                                                    <span className="opacity-70">{m.attachmentEncrypted ? "E2E encrypted" : "DHT · not E2E"}</span>
                                                    <span className="opacity-70">{m.attachmentSize ? `${Math.ceil((m.attachmentSize || 0) / 1024)} KiB` : ""}</span>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {canAct && (
                                        <div className={`absolute -top-7 z-10 flex gap-0.5 rounded bg-surface-2 p-0.5 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 ${mine ? "right-0" : "left-0"}`}>
                                            <button onClick={() => setReplyTo(m)} title="Reply" className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface-4 hover:text-ink">↩</button>
                                            <button onClick={() => onAction("reaction", m, "", "👍")} title="React" className="rounded px-1.5 py-0.5 text-xs hover:bg-surface-4">👍</button>
                                            {m.mine && (
                                                <>
                                                    <button onClick={() => setEditing({id: m.id, value: m.text})} title="Edit" className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface-4 hover:text-ink">✎</button>
                                                    <button onClick={() => onAction("delete", m)} title="Delete" className="rounded px-1.5 py-0.5 text-xs text-danger hover:bg-surface-4">×</button>
                                                </>
                                            )}
                                            <button onClick={() => onAction(m.pinned ? "unpin" : "pin", m)} title={m.pinned ? "Unpin" : "Pin"} className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface-4 hover:text-ink">⌖</button>
                                        </div>
                                    )}
                                </div>
                                {m.reactions && Object.keys(m.reactions).length > 0 && (
                                    <div className="mt-1 flex flex-wrap justify-end gap-1">
                                        {Object.entries(m.reactions).map(([reaction, count]) => (
                                            <button
                                                key={reaction}
                                                onClick={() => onAction("reaction", m, "", reaction)}
                                                className={`rounded-full border px-1.5 py-0.5 text-[10px] ${m.myReaction === reaction ? "border-accent bg-accent/20 text-accent" : "border-edge text-muted"}`}
                                            >{reaction} {count}</button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
                {displayedMessages.length === 0 && (
                    <div className="flex h-full items-center justify-center text-xs text-faint">
                        {searchQuery.trim()
                            ? "No messages match your search."
                            : `No messages yet — say hi with a ${channelName ? `#${channelName}` : "channel"} ping.`}
                    </div>
                )}
            </div>

            <MentionComposer
                members={members}
                onSend={submit}
                placeholder={`Message #${channelName}`}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(undefined)}
                draftKey={channelName}
                onAttach={onAttach}
                canAttach={canAttach}
                uploadingAttachment={uploadingAttachment}
            />
        </div>
    );
}
