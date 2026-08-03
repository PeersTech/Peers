import {useEffect, useRef, useState, type FormEvent} from 'react';
import type {UnlistenFn} from '@tauri-apps/api/event';
import {
    addMember, colorFor, createInvite, createServer, hasIdentity, initIdentity, isUnlocked,
    joinServer, leaveServer, listServers, lock, onJoinRequest, onNodeMessage, onServerError,
    onServerList, onServerMessage, peerName, publish, publishChannel, setChannel, shortId,
    subscribe, subscribeChannel, timeFor, unlock,
    type IdentityInfo, type JoinNotice, type ServerView, type UiMessage,
} from './lib/api';
import {ServerRail} from './components/ServerRail';
import {ChannelList} from './components/ChannelList';
import {MessagePane} from './components/MessagePane';

export interface DM {
    id: string;
    name: string;
    unread: number;
}

type Phase = 'boot' | 'onboarding' | 'locked' | 'ready';

export default function App() {
    const [phase, setPhase] = useState<Phase>('boot');
    const [me, setMe] = useState<IdentityInfo | null>(null);
    const [servers, setServers] = useState<Record<string, ServerView>>({});
    const [dms, setDms] = useState<DM[]>([]);
    const [dmOpen, setDmOpen] = useState(false);
    const [activeServer, setActiveServer] = useState<string | null>(null);
    const [activeDm, setActiveDm] = useState<string | null>(null);
    const [activeChannel, setActiveChannel] = useState<string | null>(null);
    const [history, setHistory] = useState<Record<string, UiMessage[]>>({});
    const [unread, setUnread] = useState<Record<string, number>>({});
    const [error, setError] = useState<string | null>(null);
    const [joinRequests, setJoinRequests] = useState<JoinNotice[]>([]);
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const [busy, setBusy] = useState(false);
    const booted = useRef(false);

    const live = useRef({me: null as IdentityInfo | null, servers: {} as Record<string, ServerView>});
    useEffect(() => {
        live.current = {me, servers};
    }, [me, servers]);

    const activeRef = useRef({server: null as string | null, channel: null as string | null, dm: null as string | null});
    useEffect(() => {
        activeRef.current = {server: activeServer, channel: activeChannel, dm: activeDm};
    }, [activeServer, activeChannel, activeDm]);

    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), 6000);
        return () => clearTimeout(t);
    }, [error]);

    const refreshServers = async () => {
        try {
            const list = await listServers();
            const map: Record<string, ServerView> = {};
            for (const v of list) map[v.id] = v;
            setServers((old) => ({...old, ...map}));
        } catch (e) {
            setError(String(e));
        }
    };

    useEffect(() => {
        if (booted.current) return;
        booted.current = true;
        void (async () => {
            try {
                if (!(await hasIdentity())) {
                    setPhase('onboarding');
                    return;
                }
                if (!(await isUnlocked())) {
                    setPhase('locked');
                    return;
                }
                setPhase('ready');
                await refreshServers();
            } catch (e) {
                setError(String(e));
                setPhase('locked');
            }
        })();
    }, []);

    useEffect(() => {
        const offs: UnlistenFn[] = [];
        let cancelled = false;
        const track = (p: Promise<UnlistenFn>) => {
            void p.then((u) => {
                if (cancelled) u();
                else offs.push(u);
            });
        };
        track(
            onServerList((v) => setServers((old) => ({...old, [v.id]: v}))),
        );
        track(
            onServerMessage((m) => {
                const key = `${m.serverId}/${m.channel}`;
                const members = live.current.servers[m.serverId]?.members ?? [];
                const msg: UiMessage = {
                    id: crypto.randomUUID(),
                    author: peerName(m.from, members),
                    authorColor: colorFor(m.from),
                    time: timeFor(m.ts),
                    text: m.text,
                    mine: live.current.me?.peerId === m.from,
                };
                setHistory((h) => ({...h, [key]: [...(h[key] ?? []), msg]}));
                const act = activeRef.current;
                if (act.server !== m.serverId || act.channel !== m.channel) {
                    setUnread((u) => ({...u, [key]: (u[key] ?? 0) + 1}));
                }
            }),
        );
        track(onServerError((e) => setError(`${e.serverId}: ${e.error}`)));
        track(
            onNodeMessage((m) => {
                const chan = m.channel.replace(/^peers\/v1\/ch\//, '');
                setDms((old) =>
                    old.some((d) => d.id === chan) ? old : [...old, {id: chan, name: shortId(chan), unread: 0}],
                );
                if (m.text !== undefined) {
                    const key = `dm:${chan}`;
                    const msg: UiMessage = {
                        id: crypto.randomUUID(),
                        author: shortId(m.from),
                        authorColor: colorFor(m.from),
                        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
                        text: m.text,
                        mine: live.current.me?.peerId === m.from,
                    };
                    setHistory((h) => ({...h, [key]: [...(h[key] ?? []), msg]}));
                    if (activeRef.current.dm !== chan) {
                        setUnread((u) => ({...u, [key]: (u[key] ?? 0) + 1}));
                        setDms((old) => old.map((d) => (d.id === chan ? {...d, unread: d.unread + 1} : d)));
                    }
                } else if (m.error) {
                    setError(m.error);
                }
            }),
        );
        track(
            onJoinRequest((n) =>
                setJoinRequests((old) =>
                    old.some((x) => x.peerId === n.peerId && x.serverId === n.serverId) ? old : [...old, n],
                ),
            ),
        );
        return () => {
            cancelled = true;
            offs.forEach((u) => u());
        };
    }, []);

    const jumpTo = (serverId: string, channel: string) => {
        setActiveServer(serverId);
        setActiveDm(null);
        setDmOpen(false);
        setActiveChannel(channel);
        void subscribeChannel(serverId, channel).catch((e) => setError(String(e)));
    };

    const selectServer = async (id: string) => {
        const v = live.current.servers[id];
        if (v && v.channels.length > 0) {
            jumpTo(id, v.channels[0].name);
        } else {
            setActiveServer(id);
            setActiveDm(null);
            setDmOpen(false);
            setActiveChannel(null);
        }
    };

    const select = (id: string) => {
        if (id === '__dms__') {
            setDmOpen(true);
            setActiveServer(null);
            setActiveChannel(null);
            if (dms.length > 0) setActiveDm(dms[0].id);
            return;
        }
        void selectServer(id);
    };

    const selectChannel = (name: string) => {
        setActiveChannel(name);
        if (activeServer) void subscribeChannel(activeServer, name).catch((e) => setError(String(e)));
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                const name = prompt('Jump to channel: /general');
                if (!name) return;
                const q = name.replace('/', '');
                for (const v of Object.values(live.current.servers)) {
                    const c = v.channels.find((ch) => ch.name === q);
                    if (c) {
                        jumpTo(v.id, c.name);
                        return;
                    }
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const send = (text: string) => {
        const t = text.trim();
        if (!t) return;
        const msg: UiMessage = {
            id: crypto.randomUUID(),
            author: me?.peerIdShort ?? 'you',
            authorColor: '#4ade80',
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
            text: t,
            mine: true,
        };
        if (activeDm) {
            const key = `dm:${activeDm}`;
            setHistory((h) => ({...h, [key]: [...(h[key] ?? []), msg]}));
            void publish(activeDm, t).catch((e) => setError(String(e)));
        } else if (activeServer && activeChannel) {
            const key = `${activeServer}/${activeChannel}`;
            setHistory((h) => ({...h, [key]: [...(h[key] ?? []), msg]}));
            void publishChannel(activeServer, activeChannel, t).catch((e) => setError(String(e)));
        }
    };

    const createSrv = async () => {
        const name = prompt('Server name');
        if (!name?.trim()) return;
        try {
            const v = await createServer(name.trim());
            setServers((old) => ({...old, [v.id]: v}));
            await selectServer(v.id);
        } catch (e) {
            setError(String(e));
        }
    };

    const join = async () => {
        const j = prompt('Paste the invite JSON');
        if (!j?.trim()) return;
        try {
            const v = await joinServer(j.trim());
            setServers((old) => ({...old, [v.id]: v}));
            await selectServer(v.id);
        } catch (e) {
            setError(String(e));
        }
    };

    const copyInvite = async (serverId: string) => {
        try {
            const json = await createInvite(serverId);
            try {
                await navigator.clipboard.writeText(json);
            } catch {
                window.prompt('Invite JSON (copy manually):', json);
            }
        } catch (e) {
            setError(String(e));
        }
    };

    const addChannel = async (serverId: string) => {
        const name = prompt('Channel name');
        if (!name?.trim()) return;
        try {
            const v = await setChannel(serverId, name.trim(), '', 'member', 'member');
            setServers((old) => ({...old, [v.id]: v}));
        } catch (e) {
            setError(String(e));
        }
    };

    const addMemberUi = async (serverId: string) => {
        const peerId = prompt('Member peer ID');
        if (!peerId?.trim()) return;
        const name = prompt('Display name')?.trim() || shortId(peerId.trim());
        const role = prompt('Role (member / admin)')?.trim() === 'admin' ? 'admin' : 'member';
        try {
            const v = await addMember(serverId, peerId.trim(), name, role);
            setServers((old) => ({...old, [v.id]: v}));
        } catch (e) {
            setError(String(e));
        }
    };

    const acceptJoin = async (n: JoinNotice) => {
        try {
            const v = await addMember(n.serverId, n.peerId, n.name, 'member');
            setServers((old) => ({...old, [v.id]: v}));
            setJoinRequests((old) => old.filter((x) => x.peerId !== n.peerId));
        } catch (e) {
            setError(String(e));
        }
    };

    const rejectJoin = (n: JoinNotice) => {
        setJoinRequests((old) => old.filter((x) => x.peerId !== n.peerId || x.serverId !== n.serverId));
    };

    const leave = async (serverId: string) => {
        if (!confirm('Leave this server?')) return;
        try {
            await leaveServer(serverId);
            setServers((old) => {
                const next = {...old};
                delete next[serverId];
                return next;
            });
            setActiveServer(null);
            setActiveChannel(null);
        } catch (e) {
            setError(String(e));
        }
    };

    const addDm = async () => {
        const id = prompt('Peer ID to message (e.g. 12D3KooW…)');
        if (!id?.trim()) return;
        const chan = id.trim();
        try {
            await subscribe(chan);
            setDms((old) => (old.some((d) => d.id === chan) ? old : [...old, {id: chan, name: shortId(chan), unread: 0}]));
            setDmOpen(true);
            setActiveServer(null);
            setActiveDm(chan);
        } catch (e) {
            setError(String(e));
        }
    };

    const doLock = async () => {
        try {
            await lock();
        } catch (e) {
            setError(String(e));
        }
        setMe(null);
        setServers({});
        setDms([]);
        setHistory({});
        setUnread({});
        setJoinRequests([]);
        setActiveServer(null);
        setActiveDm(null);
        setActiveChannel(null);
        setDmOpen(false);
        setPhase('locked');
    };

    const submitAuth = async (e: FormEvent) => {
        e.preventDefault();
        if (phase === 'onboarding' && password !== password2) {
            setError('Passwords do not match');
            return;
        }
        setBusy(true);
        try {
            const info = phase === 'onboarding' ? await initIdentity(password) : await unlock(password);
            setMe(info);
            setPassword('');
            setPassword2('');
            setPhase('ready');
            await refreshServers();
        } catch (err) {
            setError(String(err));
        } finally {
            setBusy(false);
        }
    };

    if (phase === 'boot') {
        return <div className="flex h-full w-full items-center justify-center bg-[#0b0d10]"/>;
    }

    if (phase !== 'ready') {
        return (
            <div className="flex h-full w-full items-center justify-center bg-[#0b0d10]">
                <form onSubmit={submitAuth} className="w-80 rounded-2xl border border-[#2b2d31] bg-[#17181c] p-6">
                    <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-[#4ade80] text-lg font-bold text-black">P</div>
                    <h1 className="mt-3 text-xl font-bold text-[#e8eaed]">Peers</h1>
                    <p className="mb-4 text-xs text-[#8a8f98]">
                        {phase === 'onboarding' ? 'Create your encrypted identity — this password seals your keys locally.' : 'Enter your password to unlock your identity and start the swarm.'}
                    </p>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        minLength={phase === 'onboarding' ? 8 : undefined}
                        autoFocus
                        className="mb-2 w-full rounded-lg bg-[#212226] px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6d7278] outline-none focus:ring-1 focus:ring-[#4ade80]/50"
                    />
                    {phase === 'onboarding' && (
                        <input
                            type="password"
                            value={password2}
                            onChange={(e) => setPassword2(e.target.value)}
                            placeholder="Confirm password"
                            minLength={8}
                            className="mb-4 w-full rounded-lg bg-[#212226] px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6d7278] outline-none focus:ring-1 focus:ring-[#4ade80]/50"
                        />
                    )}
                    {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
                    <button
                        type="submit"
                        disabled={busy}
                        className="w-full rounded-lg bg-[#4ade80] px-3 py-2 text-sm font-semibold text-black hover:bg-[#86efac] disabled:opacity-50"
                    >
                        {busy ? '…' : phase === 'onboarding' ? 'Create identity' : 'Unlock'}
                    </button>
                </form>
            </div>
        );
    }

    const serverList = Object.values(servers);
    const server = activeServer ? servers[activeServer] : null;
    const dm = activeDm ? dms.find((d) => d.id === activeDm) : null;
    const paneKey = dm ? `dm:${dm.id}` : server && activeChannel ? `${server.id}/${activeChannel}` : null;
    const paneMessages = paneKey ? history[paneKey] ?? [] : [];
    const paneName = dm
        ? dm.name
        : server?.channels.find((c) => c.name === activeChannel)?.name ?? '';

    return (
        <div className="flex h-full w-full bg-[#0b0d10] text-[#e8eaed]">
            <ServerRail
                servers={serverList}
                dms={dms}
                activeServer={dmOpen ? null : activeServer}
                activeDm={dmOpen ? (activeDm ?? '__dms__') : null}
                onSelect={select}
                onCreate={() => void createSrv()}
                onJoin={() => void join()}
                serverHasUnread={(id) =>
                    Object.entries(unread).some(([k, n]) => n > 0 && k.startsWith(`${id}/`))
                }
                you={me?.peerIdShort ?? 'y'}
            />
            {dmOpen ? (
                <div className="flex h-full w-[248px] flex-col bg-[#212226]">
                    <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#17181c] px-4">
                        <span className="font-semibold">Direct messages</span>
                        <button
                            onClick={() => void addDm()}
                            title="Message a peer by ID"
                            className="flex h-6 w-6 items-center justify-center rounded text-lg font-light text-[#4ade80] hover:bg-[#2b2d31]"
                        >
                            +
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                        {dms.length === 0 && (
                            <div className="px-2 py-4 text-xs text-[#8a8f98]">
                                No DMs yet — add a peer ID to start an encrypted channel.
                            </div>
                        )}
                        {dms.map((d) => (
                            <button
                                key={d.id}
                                onClick={() => {
                                    setActiveDm(d.id);
                                    setUnread((u) => ({...u, [`dm:${d.id}`]: 0}));
                                    setDms((old) => old.map((x) => (x.id === d.id ? {...x, unread: 0} : x)));
                                }}
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                                    d.id === activeDm ? 'bg-[#3a3d43] text-[#f2f3f5]' : 'text-[#a8adb5] hover:bg-[#2b2d31]'
                                }`}
                            >
                                <span
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
                                    style={{background: colorFor(d.id)}}
                                >
                                    {d.name[0].toUpperCase()}
                                </span>
                                <span className="flex-1 truncate">{d.name}</span>
                                {d.unread > 0 && (
                                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#4ade80] px-1 text-[10px] font-bold text-black">
                                        {d.unread}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            ) : server ? (
                <ChannelList
                    server={server}
                    activeChannel={activeChannel ?? ''}
                    unreadFor={(name) => unread[`${server.id}/${name}`] ?? 0}
                    me={me}
                    joinRequests={joinRequests}
                    onSelectChannel={selectChannel}
                    onInvite={() => void copyInvite(server.id)}
                    onAddChannel={() => void addChannel(server.id)}
                    onAddMember={() => void addMemberUi(server.id)}
                    onAcceptJoin={(n) => void acceptJoin(n)}
                    onRejectJoin={rejectJoin}
                    onLeave={() => void leave(server.id)}
                />
            ) : (
                <div className="flex h-full w-[248px] items-center justify-center bg-[#212226] px-4 text-center text-xs text-[#8a8f98]">
                    No server selected
                </div>
            )}
            <MessagePane
                channelName={paneName || '…'}
                subtitle={dm ? 'E2E encrypted · direct' : server ? 'E2E encrypted · members ' + server.memberCount : ''}
                messages={paneMessages}
                onSend={send}
            />
            {error && (
                <div
                    className="fixed bottom-4 right-4 z-50 max-w-sm cursor-pointer rounded-lg border border-[#3a1d1d] bg-[#241313] px-3 py-2 text-xs text-red-300"
                    onClick={() => setError(null)}
                    title="Dismiss"
                >
                    {error}
                </div>
            )}
        </div>
    );
}
