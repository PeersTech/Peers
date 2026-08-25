import {useEffect, useRef, useState, type FormEvent} from 'react';
import type {UnlistenFn} from './lib/api';
import {
    addMember, addContact, acceptFriend, colorFor, contactProfiles, copyText, createInvite, createServer, dataUrl, dmHistory, exportSnapshot,
    fetchBlob, generatePhrase, getProfile, hasIdentity, importSnapshot, initFromPhrase, isUnlocked, joinServer,
    leaveServer, listServers, lock, lookupCode, mentionsMe, myCode, netStatus, onBlobFetched, onBlobParked, onCodeResolved,
    onFriendRequest, onHolePunch, onJoinRequest, onNodeMessage, onPeerConnected, onPeerDisconnected, onPlazaMessage, onPlazaProfile,
    onServerError, onServerList, onServerMessage, onlinePeers, parkBlob, peerName, plazaHistory, plazaWho, publish,
    publishChannel, publishPlaza, removeMember, renameServer, rotateKey, sendFriendRequest, serverHistory, setChannel, setProfile,
    setRole, shortId, subscribe, subscribeChannel, THEME, timeFor, unlock,
    type Contact, type IdentityInfo, type JoinNotice, type NetStatus, type PlazaPost, type PlazaPresence,
    type ServerView, type SignedProfile, type UiMessage,
} from './lib/api';
import {ServerRail} from './components/ServerRail';
import {ChannelList} from './components/ChannelList';
import {MessagePane} from './components/MessagePane';
import {DialogHost} from './components/DialogHost';
import {qrDataUrl} from './lib/qr';
import {useDialog} from './hooks/useDialog';
import {
    validateChannelName,
    validateJson,
    validatePeerId,
    validateRequired,
} from './lib/dialogs';

export interface DM {
    id: string;
    name: string;
    unread: number;
}

type Phase = 'boot' | 'onboarding' | 'locked' | 'ready' | 'noengine';

export default function App() {
    const {
        controller: dialogController,
        confirm: confirmDialog,
        prompt: promptDialog,
        showText,
    } = useDialog();
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
    const [notice, setNotice] = useState<string | null>(null);
    const [joinRequests, setJoinRequests] = useState<JoinNotice[]>([]);
    const [password, setPassword] = useState('');
    /** Freshly generated recovery phrase, shown once during onboarding. */
    const [newPhrase, setNewPhrase] = useState('');
    /** Gate on the user confirming they wrote the phrase down. */
    const [phraseSaved, setPhraseSaved] = useState(false);
    /** Onboarding sub-mode: type an existing phrase instead of generating one. */
    const [recovering, setRecovering] = useState(false);
    const [net, setNet] = useState<NetStatus | null>(null);
    const [code, setCode] = useState<string>('');
    /** "Add friend" modal: the code being typed, and what it resolved to. */
    const [addOpen, setAddOpen] = useState(false);
    const [codeInput, setCodeInput] = useState('');
    const [resolving, setResolving] = useState(false);
    const [resolved, setResolved] = useState<{code: string; peerId: string | null} | null>(null);
    const [busy, setBusy] = useState(false);
    const [online, setOnline] = useState<Set<string>>(new Set());
    const [plazaOpen, setPlazaOpen] = useState(false);
    const [plazaPosts, setPlazaPosts] = useState<PlazaPost[]>([]);
    const [plazaRoster, setPlazaRoster] = useState<PlazaPresence[]>([]);
    const [profiles, setProfiles] = useState<Record<string, SignedProfile>>({});
    const [myProfile, setMyProfile] = useState<SignedProfile | null>(null);
    const [blobs, setBlobs] = useState<Record<string, number[]>>({});
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [profileName, setProfileName] = useState('');
    const [profileAbout, setProfileAbout] = useState('');
    const [avatarBytes, setAvatarBytes] = useState<number[] | null>(null);
    const [pendingHash, setPendingHash] = useState<string | null>(null);
    const [showMembers, setShowMembers] = useState(true);
    const [engineError, setEngineError] = useState<string | null>(null);
    /** Incoming friend requests from peers who scanned our code. */
    const [friendRequests, setFriendRequests] = useState<{peerId: string; displayName: string; avatarHash: string | null}[]>([]);
    const booted = useRef(false);
    const historyLoaded = useRef(new Set<string>());
    const blobQueued = useRef(new Set<string>());

    const live = useRef({me: null as IdentityInfo | null, servers: {} as Record<string, ServerView>});
    useEffect(() => {
        live.current = {me, servers};
    }, [me, servers]);

    const activeRef = useRef({server: null as string | null, channel: null as string | null, dm: null as string | null});
    useEffect(() => {
        activeRef.current = {server: activeServer, channel: activeChannel, dm: activeDm};
    }, [activeServer, activeChannel, activeDm]);

    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(null), 4000);
        return () => clearTimeout(t);
    }, [notice]);

    /** Use the system clipboard when available and an in-app selectable
     *  fallback otherwise. Browser-native prompts are never used. */
    const copyOrShow = async (value: string, title: string, successMessage: string) => {
        if (await copyText(value)) {
            setNotice(successMessage);
            return;
        }
        await showText({
            title,
            body: 'Clipboard access is unavailable. Select and copy the text below.',
            value,
        });
    };

    // Generate the recovery phrase as soon as onboarding starts, so the user
    // sees it before committing to anything.
    useEffect(() => {
        if (phase !== 'onboarding' || recovering || newPhrase) return;
        void generatePhrase(12)
            .then(setNewPhrase)
            .catch((e) => setError(String(e)));
    }, [phase, recovering, newPhrase]);

    // Poll connectivity while unlocked. Peer count also moves instantly via
    // presence events; this fills in relay/reachability, which has no event.
    useEffect(() => {
        if (phase !== 'ready') return;
        let alive = true;
        const tick = () => {
            if (document.hidden) return;
            void netStatus()
                .then((s) => alive && setNet(s))
                .catch(() => {});
        };
        tick();
        const h = setInterval(tick, 5000);
        return () => {
            alive = false;
            clearInterval(h);
        };
    }, [phase]);

    // Our short peer code, for sharing.
    useEffect(() => {
        if (phase !== 'ready') return;
        void myCode()
            .then((c) => setCode(c.formatted))
            .catch(() => {});
    }, [phase]);

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

    const loadServerHistory = async (serverId: string, channel: string) => {
        const key = `${serverId}/${channel}`;
        if (historyLoaded.current.has(key)) return;
        historyLoaded.current.add(key);
        try {
            const msgs = await serverHistory(serverId, channel);
            if (msgs.length === 0) return;
            const members = live.current.servers[serverId]?.members ?? [];
            const list: UiMessage[] = msgs.map((d, i) => ({
                id: `${d.from}:${d.ts}:${i}`,
                author: peerName(d.from, members),
                authorColor: colorFor(d.from),
                time: timeFor(d.ts),
                text: d.text,
                mine: d.from === live.current.me?.peerId,
                authorPeer: d.from,
                mentionsMe: mentionsMe(d.text, live.current.me?.peerId ?? ''),
            }));
            setHistory((h) => ({...h, [key]: [...list, ...(h[key] ?? [])]}));
        } catch (e) {
            setError(String(e));
        }
    };

    const ensureBlob = (hash: string) => {
        if (!hash || blobs[hash] || blobQueued.current.has(hash)) return;
        blobQueued.current.add(hash);
        void fetchBlob(hash).catch(() => {});
    };

    const blobUrl = (hash: string | null | undefined): string | null => {
        if (!hash) return null;
        const data = blobs[hash];
        if (!data || data.length === 0) return null;
        return dataUrl(data);
    };

    const avatarFor = (peerId: string): string | null => {
        const p = profiles[peerId];
        if (!p?.avatarHash) return null;
        ensureBlob(p.avatarHash);
        return blobUrl(p.avatarHash);
    };

    const contactName = (peerId: string) => profiles[peerId]?.displayName || shortId(peerId);

    /** Everyone we could @-mention: server members plus known signed profiles. */
    const contactsFor = (): Contact[] => {
        const out: Contact[] = [];
        const seen = new Set<string>();
        for (const s of Object.values(servers)) {
            for (const m of s.members) {
                if (!seen.has(m.peerId)) {
                    seen.add(m.peerId);
                    out.push(m);
                }
            }
        }
        for (const p of Object.values(profiles)) {
            if (!seen.has(p.peerId)) {
                seen.add(p.peerId);
                out.push({peerId: p.peerId, name: p.displayName, profile: p});
            }
        }
        return out;
    };

    const loadProfiles = async () => {
        try {
            const [mine, all] = await Promise.all([getProfile(), contactProfiles()]);
            setMyProfile(mine);
            setProfiles(all);
            for (const p of Object.values(all)) if (p.avatarHash) ensureBlob(p.avatarHash);
        } catch {
            // profiles are best-effort
        }
    };

    const loadPlaza = async () => {
        try {
            const [hist, who] = await Promise.all([plazaHistory(), plazaWho()]);
            setPlazaPosts(
                hist.map((d, i) => ({
                    id: `${d.from}:${d.ts}:${i}`,
                    author: d.profile?.displayName || shortId(d.from),
                    authorColor: colorFor(d.from),
                    authorPeer: d.from,
                    time: timeFor(d.ts),
                    text: d.text,
                    mine: d.from === live.current.me?.peerId,
                    profile: d.profile,
                })),
            );
            setPlazaRoster(who);
            for (const d of hist) if (d.profile?.avatarHash) ensureBlob(d.profile.avatarHash);
        } catch (e) {
            setError(String(e));
        }
    };

    const openPlaza = () => {
        setPlazaOpen(true);
        setDmOpen(false);
        setActiveServer(null);
        setActiveDm(null);
        setActiveChannel(null);
        void loadPlaza();
    };

    /** Downscales an image to a square PNG no larger than `AVATAR_PX`.
     *
     *  Avatars ride the DHT, where every peer that displays you fetches a
     *  copy — so a 4 MB phone photo is not just slow, it is inconsiderate to
     *  the low-end nodes this project targets. 128px lands around 20-30 KB.
     */
    const AVATAR_PX = 128;
    const downscaleAvatar = (file: File): Promise<number[]> =>
        new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const canvas = document.createElement('canvas');
                canvas.width = AVATAR_PX;
                canvas.height = AVATAR_PX;
                const ctx = canvas.getContext('2d');
                if (!ctx) return reject(new Error('canvas unavailable'));
                // Center-crop to a square so portraits are not squashed.
                const side = Math.min(img.width, img.height);
                ctx.drawImage(
                    img,
                    (img.width - side) / 2, (img.height - side) / 2, side, side,
                    0, 0, AVATAR_PX, AVATAR_PX,
                );
                canvas.toBlob((blob) => {
                    if (!blob) return reject(new Error('could not encode avatar'));
                    blob.arrayBuffer()
                        .then((b) => resolve(Array.from(new Uint8Array(b))))
                        .catch(reject);
                }, 'image/png');
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('that file is not an image we can read'));
            };
            img.src = url;
        });

    const onAvatarFile = async (file: File) => {
        try {
            const buf = await downscaleAvatar(file);
            setAvatarBytes(buf);
            setPendingHash(null);
            await parkBlob(buf);
        } catch (e) {
            setError(String(e));
        }
    };

    const saveProfile = async (e: FormEvent) => {
        e.preventDefault();
        const name = profileName.trim();
        if (!name) {
            setError('Display name required');
            return;
        }
        const hash = pendingHash ?? myProfile?.avatarHash ?? null;
        try {
            const p = await setProfile(name, profileAbout.trim(), hash);
            setMyProfile(p);
            setProfiles((old) => ({...old, [live.current.me?.peerId ?? '']: p}));
            setNotice('Profile saved');
            setSettingsOpen(false);
            setAvatarBytes(null);
            setPendingHash(null);
        } catch (err) {
            setError(String(err));
        }
    };

    const loadDmHistory = async (peer: string) => {
        const key = `dm:${peer}`;
        if (historyLoaded.current.has(key)) return;
        historyLoaded.current.add(key);
        try {
            const msgs = await dmHistory(peer);
            if (msgs.length === 0) return;
            const list: UiMessage[] = msgs.map((d, i) => ({
                id: `${d.peer}:${d.ts}:${i}`,
                author: d.mine ? (me?.peerIdShort ?? 'you') : contactName(peer),
                authorColor: d.mine ? THEME.online : colorFor(peer),
                time: timeFor(d.ts),
                text: d.text,
                mine: d.mine,
                authorPeer: d.mine ? (me?.peerId ?? '') : peer,
                mentionsMe: mentionsMe(d.text, me?.peerId ?? ''),
            }));
            setHistory((h) => ({...h, [key]: [...list, ...(h[key] ?? [])]}));
        } catch (e) {
            setError(String(e));
        }
    };

    const runBoot = async () => {
        booted.current = true;
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
            await loadProfiles();
            try {
                setOnline(new Set(await onlinePeers()));
            } catch {
                // presence is best-effort
            }
        } catch (e) {
            // Engine unreachable (or any boot failure) — show the retry
            // screen instead of a misleading login form.
            setEngineError(e instanceof Error ? e.message : String(e));
            setPhase('noengine');
            booted.current = false; // allow retry
        }
    };

    useEffect(() => {
        if (booted.current) return;
        void runBoot();
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            onServerList((v) => {
                setServers((old) => ({...old, [v.id]: v}));
                const profs: Record<string, SignedProfile> = {};
                for (const m of v.members) {
                    // The backend verifies the signature; the frontend still
                    // checks the profile is bound to *this* member, so a valid
                    // profile cannot be replayed under someone else's name.
                    if (m.profile && m.profile.peerId === m.peerId) {
                        profs[m.peerId] = m.profile;
                    }
                }
                if (Object.keys(profs).length > 0) {
                    setProfiles((old) => ({...old, ...profs}));
                    for (const p of Object.values(profs)) if (p.avatarHash) ensureBlob(p.avatarHash);
                }
            }),
        );
        track(
            onServerMessage((m) => {
                if (m.from === live.current.me?.peerId) return;
                const key = `${m.serverId}/${m.channel}`;
                const members = live.current.servers[m.serverId]?.members ?? [];
                const msg: UiMessage = {
                    id: crypto.randomUUID(),
                    author: peerName(m.from, members),
                    authorColor: colorFor(m.from),
                    time: timeFor(m.ts),
                    text: m.text,
                    mine: live.current.me?.peerId === m.from,
                    mentionsMe: mentionsMe(m.text, live.current.me?.peerId ?? ''),
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
                if (m.from === live.current.me?.peerId) return;
                const chan = m.from;
                setDms((old) =>
                    old.some((d) => d.id === chan) ? old : [...old, {id: chan, name: shortId(chan), unread: 0}],
                );
                if (m.text !== undefined) {
                    const key = `dm:${chan}`;
                    const msg: UiMessage = {
                        id: crypto.randomUUID(),
                        author: contactName(m.from),
                        authorColor: colorFor(m.from),
                        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
                        text: m.text,
                        mine: false,
                        authorPeer: m.from,
                        mentionsMe: mentionsMe(m.text, live.current.me?.peerId ?? ''),
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
        track(
            onPeerConnected((peerId) =>
                setOnline((old) => {
                    if (old.has(peerId)) return old;
                    const next = new Set(old);
                    next.add(peerId);
                    return next;
                }),
            ),
        );
        track(
            onPeerDisconnected((peerId) =>
                setOnline((old) => {
                    if (!old.has(peerId)) return old;
                    const next = new Set(old);
                    next.delete(peerId);
                    return next;
                }),
            ),
        );
        track(
            onPlazaMessage((m) => {
                const prof = m.profile;
                if (prof) setProfiles((old) => ({...old, [m.from]: prof}));
                setPlazaPosts((old) => {
                    const id = `${m.from}:${m.ts}`;
                    if (old.some((p) => p.id === id)) return old;
                    const post: PlazaPost = {
                        id,
                        author: m.profile?.displayName || shortId(m.from),
                        authorColor: colorFor(m.from),
                        authorPeer: m.from,
                        time: timeFor(m.ts),
                        text: m.text,
                        mine: m.from === live.current.me?.peerId,
                        profile: m.profile,
                    };
                    return [...old, post];
                });
                if (m.profile?.avatarHash) ensureBlob(m.profile.avatarHash);
            }),
        );
        track(
            onPlazaProfile((m) => {
                const prof = m.profile;
                if (prof) {
                    setProfiles((old) => ({...old, [m.peerId]: prof}));
                    if (prof.avatarHash) ensureBlob(prof.avatarHash);
                }
            }),
        );
        track(
            onBlobFetched((e) => setBlobs((old) => ({...old, [e.hash]: e.data}))),
        );
        track(
            onBlobParked((e) => setPendingHash((h) => h ?? e.hash)),
        );
        track(
            onCodeResolved((e) => {
                setResolving(false);
                setResolved(e);
                if (!e.peerId) setError(`No one is using the code ${e.code}`);
            }),
        );
        track(
            onHolePunch((e) => {
                // Only worth saying when it succeeds — a failed punch just
                // means the connection stays relayed, which still works.
                if (e.direct) setNotice(`Direct connection established with ${shortId(e.peerId)}`);
            }),
        );
        track(
            onFriendRequest((e) => {
                setFriendRequests((prev) => {
                    // Dedupe by peer ID.
                    if (prev.some((r) => r.peerId === e.peerId)) return prev;
                    return [...prev, e];
                });
                setNotice(`Friend request from ${e.displayName || shortId(e.peerId)}`);
            }),
        );
        return () => {
            cancelled = true;
            offs.forEach((u) => u());
        };
    }, []);

    const jumpTo = (serverId: string, channel: string) => {
        setPlazaOpen(false);
        setActiveServer(serverId);
        setActiveDm(null);
        setDmOpen(false);
        setActiveChannel(channel);
        void subscribeChannel(serverId, channel).catch((e) => setError(String(e)));
        void loadServerHistory(serverId, channel);
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
        if (id === '__plaza__') {
            openPlaza();
            return;
        }
        if (id === '__dms__') {
            setPlazaOpen(false);
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
        if (activeServer) {
            void subscribeChannel(activeServer, name).catch((e) => setError(String(e)));
            void loadServerHistory(activeServer, name);
        }
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (dialogController.getCurrent()) return;
                void promptDialog({
                    title: 'Jump to a channel',
                    body: 'Enter the channel name. Peers will search across your servers.',
                    label: 'Channel',
                    placeholder: 'general',
                    validate: validateRequired('Channel', 32),
                }).then((name) => {
                    if (!name) return;
                    const query = name.trim().replace(/^#?\/?/, '').toLowerCase();
                    for (const serverView of Object.values(live.current.servers)) {
                        const channel = serverView.channels.find((item) => item.name.toLowerCase() === query);
                        if (channel) {
                            jumpTo(serverView.id, channel.name);
                            return;
                        }
                    }
                    setError(`No channel named #${query} was found`);
                });
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [dialogController, promptDialog]);

    const send = (text: string) => {
        const t = text.trim();
        if (!t) return;
        const msg: UiMessage = {
            id: crypto.randomUUID(),
            author: me?.peerIdShort ?? 'you',
            authorColor: THEME.online,
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
        } else if (plazaOpen) {
            setPlazaPosts((old) => [
                ...old,
                {
                    id: crypto.randomUUID(),
                    author: myProfile?.displayName || (me?.peerIdShort ?? 'you'),
                    authorColor: THEME.online,
                    authorPeer: me?.peerId ?? '',
                    time: new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
                    text: t,
                    mine: true,
                    profile: myProfile,
                },
            ]);
            void publishPlaza(t).catch((e) => setError(String(e)));
        }
    };

    const createSrv = async () => {
        const name = await promptDialog({
            title: 'Create a server',
            body: 'Servers are encrypted communities stored by their members — no central host required.',
            label: 'Server name',
            placeholder: 'Weekend crew',
            confirmLabel: 'Create server',
            validate: validateRequired('Server name', 80),
        });
        if (!name) return;
        try {
            const v = await createServer(name.trim());
            setServers((old) => ({...old, [v.id]: v}));
            await selectServer(v.id);
        } catch (e) {
            setError(String(e));
        }
    };

    const join = async () => {
        const invite = await promptDialog({
            title: 'Join a server',
            body: 'Paste the signed invite you received from the server owner.',
            label: 'Invite JSON',
            placeholder: '{\n  "payload": { ... }\n}',
            confirmLabel: 'Continue',
            multiline: true,
            mono: true,
            validate: validateJson('Invite'),
        });
        if (!invite) return;
        const name = await promptDialog({
            title: 'Choose your server name',
            body: 'This local server nickname is shown until members receive your signed global profile.',
            label: 'Display name',
            initial: myProfile?.displayName || me?.defaultName || '',
            placeholder: 'JuicyPear',
            confirmLabel: 'Join server',
            validate: validateRequired('Display name', 80),
        });
        if (!name) return;
        try {
            const v = await joinServer(invite.trim(), name.trim());
            setServers((old) => ({...old, [v.id]: v}));
            await selectServer(v.id);
        } catch (e) {
            setError(String(e));
        }
    };

    const copyInvite = async (serverId: string) => {
        try {
            const json = await createInvite(serverId);
            await copyOrShow(json, 'Copy server invite', 'Invite copied');
        } catch (e) {
            setError(String(e));
        }
    };

    const addChannel = async (serverId: string) => {
        const name = await promptDialog({
            title: 'Create a channel',
            body: 'Everyone in the server can read and post in this channel by default.',
            label: 'Channel name',
            placeholder: 'general',
            confirmLabel: 'Create channel',
            validate: validateChannelName,
        });
        if (!name) return;
        try {
            const v = await setChannel(serverId, name.trim(), '', 'member', 'member');
            setServers((old) => ({...old, [v.id]: v}));
        } catch (e) {
            setError(String(e));
        }
    };

    const addMemberUi = async (serverId: string) => {
        const peerId = await promptDialog({
            title: 'Add a server member',
            body: 'Paste the full peer ID. New members start with the member role and can be promoted later.',
            label: 'Peer ID',
            placeholder: '12D3KooW…',
            confirmLabel: 'Continue',
            mono: true,
            validate: validatePeerId,
        });
        if (!peerId) return;
        const name = await promptDialog({
            title: 'Name this member',
            label: 'Display name',
            initial: profiles[peerId.trim()]?.displayName || shortId(peerId.trim()),
            confirmLabel: 'Add member',
            validate: validateRequired('Display name', 80),
        });
        if (!name) return;
        try {
            const v = await addMember(serverId, peerId.trim(), name.trim(), 'member');
            setServers((old) => ({...old, [v.id]: v}));
        } catch (e) {
            setError(String(e));
        }
    };

    const acceptJoin = async (n: JoinNotice) => {
        try {
            const v = await addMember(n.serverId, n.peerId, n.name, 'member', n.card);
            setServers((old) => ({...old, [v.id]: v}));
            setJoinRequests((old) => old.filter((x) => x.peerId !== n.peerId));
        } catch (e) {
            setError(String(e));
        }
    };

    const rejectJoin = (n: JoinNotice) => {
        setJoinRequests((old) => old.filter((x) => x.peerId !== n.peerId || x.serverId !== n.serverId));
    };

    const applyServerUpdate = async (p: Promise<ServerView>) => {
        try {
            const v = await p;
            setServers((old) => ({...old, [v.id]: v}));
            return v;
        } catch (e) {
            setError(String(e));
            return null;
        }
    };

    const renameSrv = async (serverId: string) => {
        const name = await promptDialog({
            title: 'Rename server',
            label: 'Server name',
            initial: servers[serverId]?.name ?? '',
            confirmLabel: 'Rename',
            validate: validateRequired('Server name', 80),
        });
        if (!name) return;
        await applyServerUpdate(renameServer(serverId, name.trim()));
    };

    const rotateKeyUi = async (serverId: string) => {
        const accepted = await confirmDialog({
            title: 'Rotate the server signing key?',
            body: 'The member list will be re-signed immediately. Existing members receive the new key through the signed rotation chain.',
            confirmLabel: 'Rotate key',
            destructive: true,
        });
        if (!accepted) return;
        await applyServerUpdate(rotateKey(serverId));
        setNotice('Server signing key rotated');
    };

    const kickMember = async (serverId: string, peerId: string) => {
        const accepted = await confirmDialog({
            title: `Remove ${contactName(peerId)}?`,
            body: 'They will be removed from the signed member list and lose access to future server messages.',
            confirmLabel: 'Remove member',
            destructive: true,
        });
        if (!accepted) return;
        await applyServerUpdate(removeMember(serverId, peerId));
    };

    const promoteMember = async (serverId: string, peerId: string, role: 'admin' | 'member') => {
        await applyServerUpdate(setRole(serverId, peerId, role));
    };

    const exportSnapshotUi = async (serverId: string) => {
        try {
            const json = await exportSnapshot(serverId);
            await copyOrShow(json, 'Export signed snapshot', 'Snapshot copied');
        } catch (e) {
            setError(String(e));
        }
    };

    const importSnapshotUi = async (serverId: string) => {
        const json = await promptDialog({
            title: 'Import a signed snapshot',
            body: 'Peers verifies the owner signature before merging any new messages.',
            label: 'Snapshot JSON',
            placeholder: '{\n  "serverId": "…"\n}',
            confirmLabel: 'Verify and import',
            multiline: true,
            mono: true,
            validate: validateJson('Snapshot'),
        });
        if (!json) return;
        try {
            const n = await importSnapshot(serverId, json.trim());
            setNotice(`${n} message(s) imported from snapshot`);
        } catch (e) {
            setError(String(e));
        }
    };

    const leave = async (serverId: string) => {
        const accepted = await confirmDialog({
            title: `Leave ${servers[serverId]?.name ?? 'this server'}?`,
            body: 'This removes the local server record and unsubscribes this device. You will need a new invite to return.',
            confirmLabel: 'Leave server',
            destructive: true,
        });
        if (!accepted) return;
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
        const id = await promptDialog({
            title: 'Start a direct message',
            body: 'Use a full peer ID for a direct encrypted channel, or add a friend by short code from the server rail.',
            label: 'Peer ID',
            placeholder: '12D3KooW…',
            confirmLabel: 'Open DM',
            mono: true,
            validate: validatePeerId,
        });
        if (!id) return;
        const chan = id.trim();
        try {
            await subscribe(chan);
            setDms((old) => (old.some((d) => d.id === chan) ? old : [...old, {id: chan, name: shortId(chan), unread: 0}]));
            setDmOpen(true);
            setActiveServer(null);
            setActiveDm(chan);
            void loadDmHistory(chan);
        } catch (e) {
            setError(String(e));
        }
    };

    const copyMyId = () => {
        if (!me) return;
        void copyOrShow(me.peerId, 'Your peer ID', 'Peer ID copied');
    };

    const openAddFriend = () => {
        setCodeInput('');
        setResolved(null);
        setResolving(false);
        setAddOpen(true);
    };

    /** Kicks off the DHT lookup; the answer lands in onCodeResolved. */
    const submitCode = async (e: FormEvent) => {
        e.preventDefault();
        setResolved(null);
        setResolving(true);
        try {
            await lookupCode(codeInput);
        } catch (err) {
            setResolving(false);
            setError(String(err));
        }
    };

    /** Sends a friend request to a resolved peer. The user has seen who
     *  answered before this runs — that acceptance is what makes a grindable
     *  12-digit code safe to use as a lookup key. */
    const acceptResolved = async () => {
        const peerId = resolved?.peerId;
        if (!peerId) return;
        try {
            await sendFriendRequest(peerId);
            setDms((old) =>
                old.some((d) => d.id === peerId)
                    ? old
                    : [...old, {id: peerId, name: shortId(peerId), unread: 0}],
            );
            setAddOpen(false);
            setPlazaOpen(false);
            setDmOpen(true);
            setActiveServer(null);
            setActiveDm(peerId);
            void loadDmHistory(peerId);
            setNotice('Friend request sent — say hi');
        } catch (err) {
            setError(String(err));
        }
    };

    /** Accepts an incoming friend request: subscribes to their DM topic and
     *  removes them from the pending list. */
    const doAcceptFriend = async (peerId: string) => {
        try {
            await acceptFriend(peerId);
            setFriendRequests((prev) => prev.filter((r) => r.peerId !== peerId));
            setDms((old) =>
                old.some((d) => d.id === peerId)
                    ? old
                    : [...old, {id: peerId, name: shortId(peerId), unread: 0}],
            );
            setNotice('Friend added — say hi');
        } catch (err) {
            setError(String(err));
        }
    };

    /** Declines an incoming friend request. */
    const doDeclineFriend = (peerId: string) => {
        setFriendRequests((prev) => prev.filter((r) => r.peerId !== peerId));
    };

    const openSettings = () => {
        setProfileName(myProfile?.displayName || me?.defaultName || me?.peerIdShort || '');
        setProfileAbout(myProfile?.about || '');
        setAvatarBytes(null);
        setPendingHash(null);
        setSettingsOpen(true);
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
        setPlazaOpen(false);
        setPlazaPosts([]);
        setPlazaRoster([]);
        setProfiles({});
        setMyProfile(null);
        setActiveServer(null);
        setActiveDm(null);
        setActiveChannel(null);
        setDmOpen(false);
        setPhase('locked');
    };

    const submitAuth = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            let info;
            if (phase === 'onboarding') {
                // The phrase IS the key: either the one we just generated, or
                // one the user is restoring from.
                const phrase = (recovering ? password : newPhrase).trim();
                if (!phrase) {
                    setError('Enter your recovery phrase');
                    setBusy(false);
                    return;
                }
                info = await initFromPhrase(phrase);
            } else {
                info = await unlock(password);
            }
            setMe(info);
            setPassword('');
            setNewPhrase('');
            setPhraseSaved(false);
            setRecovering(false);
            setPhase('ready');
            await refreshServers();
        } catch (err) {
            setError(String(err));
        } finally {
            setBusy(false);
        }
    };

    if (phase === 'boot') {
        return <div className="flex h-full w-full items-center justify-center bg-surface-1"/>;
    }

    if (phase === 'noengine') {
        return (
            <>
                <div className="flex h-full w-full flex-col items-center justify-center gap-5 bg-surface-1 px-6 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-2xl text-warn">!</div>
                    <div>
                        <h1 className="text-lg font-bold text-ink">Engine not running</h1>
                        <p className="mx-auto mt-2 max-w-[420px] text-sm leading-relaxed text-muted">
                            The Peers window is just the shell — the engine process holds your keys
                            and the swarm. Start it, then press retry.
                        </p>
                    </div>
                    {engineError && (
                        <code className="max-w-[480px] rounded-lg border border-edge bg-surface-2 px-3 py-2 font-mono text-[11px] text-warn">
                            {engineError}
                        </code>
                    )}
                    <div className="rounded-lg border border-edge bg-surface-2 px-4 py-3 text-left font-mono text-xs text-muted">
                        <div><span className="text-faint"># one-time:</span> curl -O http://213.136.86.78:8080/host.cjs</div>
                        <div><span className="text-faint"># every session:</span></div>
                        <div>node host.cjs</div>
                    </div>
                    <button
                        onClick={() => { setEngineError(null); setPhase('boot'); void runBoot(); }}
                        className="rounded-lg bg-accent px-6 py-2 text-sm font-semibold text-black hover:bg-accent-hover"
                    >
                        Retry connection
                    </button>
                </div>
                <DialogHost controller={dialogController}/>
            </>
        );
    }

    if (phase !== 'ready') {
        const onboarding = phase === 'onboarding';
        return (
            <>
                <div className="flex h-full w-full items-center justify-center bg-surface-1">
                    <form onSubmit={submitAuth} className="w-[26rem] rounded-lg border border-surface-3 bg-surface-1 p-6">
                    <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-lg font-bold text-white">P</div>
                    <h1 className="mt-3 text-xl font-bold text-ink">Peers</h1>

                    {onboarding && !recovering && (
                        <>
                            <p className="mb-3 text-xs text-muted">
                                This is your recovery phrase. It <em>is</em> your identity — these
                                12 words generate your keys, so anyone who has them is you, and
                                nobody (including us) can restore them if you lose them.
                            </p>
                            <div className="mb-2 grid grid-cols-3 gap-1.5 rounded-lg border border-surface-3 bg-surface-2 p-3">
                                {newPhrase.split(' ').map((w, i) => (
                                    <div key={i} className="flex items-baseline gap-1 text-sm text-ink">
                                        <span className="w-4 shrink-0 text-right text-[10px] text-faint">{i + 1}</span>
                                        <span className="font-mono">{w}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="mb-3 flex items-center justify-between">
                                <button
                                    type="button"
                                    onClick={() => {
                                        void copyOrShow(newPhrase, 'Recovery phrase', 'Recovery phrase copied');
                                    }}
                                    className="text-xs text-accent hover:underline"
                                >
                                    Copy phrase
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setRecovering(true);
                                        setPassword('');
                                    }}
                                    className="text-xs text-muted hover:underline"
                                >
                                    I already have a phrase
                                </button>
                            </div>
                            <label className="mb-4 flex cursor-pointer items-start gap-2 text-xs text-ink-dim">
                                <input
                                    type="checkbox"
                                    checked={phraseSaved}
                                    onChange={(e) => setPhraseSaved(e.target.checked)}
                                    className="mt-0.5"
                                />
                                I have written these words down somewhere safe. I understand that
                                losing them means losing this identity permanently.
                            </label>
                        </>
                    )}

                    {onboarding && recovering && (
                        <>
                            <p className="mb-3 text-xs text-muted">
                                Enter your 12- or 24-word recovery phrase. This rebuilds the same
                                identity and peer ID on this machine.
                            </p>
                            <textarea
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                rows={3}
                                autoFocus
                                placeholder="abandon ability able about…"
                                className="mb-2 w-full resize-none rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm text-ink placeholder-faint outline-none focus:ring-1 focus:ring-accent/50"
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    setRecovering(false);
                                    setPassword('');
                                }}
                                className="mb-4 text-xs text-muted hover:underline"
                            >
                                ← Create a new identity instead
                            </button>
                        </>
                    )}

                    {!onboarding && (
                        <>
                            <p className="mb-4 text-xs text-muted">
                                Enter your recovery phrase to unlock your identity and start the swarm.
                            </p>
                            <textarea
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                rows={3}
                                autoFocus
                                placeholder="Your recovery phrase"
                                className="mb-4 w-full resize-none rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm text-ink placeholder-faint outline-none focus:ring-1 focus:ring-accent/50"
                            />
                        </>
                    )}

                    {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
                    <button
                        type="submit"
                        disabled={busy || (onboarding && !recovering && !phraseSaved)}
                        className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                        {busy ? '…' : onboarding ? (recovering ? 'Recover identity' : 'Create identity') : 'Unlock'}
                    </button>
                    </form>
                </div>
                <DialogHost controller={dialogController}/>
            </>
        );
    }

    const serverList = Object.values(servers);
    const server = activeServer ? servers[activeServer] : null;
    const dm = activeDm ? dms.find((d) => d.id === activeDm) : null;
    const plazaMessages: UiMessage[] = plazaPosts.map((p) => ({
        id: p.id,
        author: p.author,
        authorColor: p.authorColor,
        time: p.time,
        text: p.text,
        mine: p.mine,
        authorPeer: p.authorPeer,
    }));
    const paneKey = plazaOpen
        ? 'plaza'
        : dm
          ? `dm:${dm.id}`
          : server && activeChannel
            ? `${server.id}/${activeChannel}`
            : null;
    const paneMessages = plazaOpen ? plazaMessages : paneKey ? history[paneKey] ?? [] : [];
    const paneName = plazaOpen
        ? 'plaza'
        : dm
          ? (profiles[dm.id]?.displayName ?? dm.name)
          : server?.channels.find((c) => c.name === activeChannel)?.name ?? '';
    const onlineCount = server ? server.members.filter((m) => online.has(m.peerId)).length : 0;
    const dmOnline = dm ? online.has(dm.id) : false;
    const paneMembers: Contact[] = plazaOpen || dm
        ? contactsFor()
        : (server?.members ?? []);
    const plazaHere = plazaRoster.length + (me ? 1 : 0);

    /** One-line network state. Deliberately blunt about the case that breaks
     *  cross-NAT chat, since "0 peers" alone looks like a transient hiccup. */
    const netLabel = (): string => {
        if (!net) return '';
        const reach =
            net.reachability === 'direct'
                ? 'direct'
                : net.reachability === 'relayed'
                  ? 'via relay'
                  : net.reachability === 'unreachable'
                    ? 'unreachable'
                    : net.knownNodes === 0
                      ? 'no relay node configured'
                      : 'connecting';
        return `${net.peers} peer${net.peers === 1 ? '' : 's'} · ${reach}`;
    };
    const netTitle = net
        ? [
              // Say which of the two it is. "best guess" on a measured result
              // undersells it; dropping the caveat on an inferred one oversells it.
              `reachability: ${net.reachability}${net.reachabilityMeasured ? ' (measured)' : ' (best guess)'}`,
              `relay reservations: ${net.relayReservations}`,
              `configured nodes: ${net.knownNodes}`,
              net.externalAddrs.length ? `external: ${net.externalAddrs.join(', ')}` : '',
              net.listenAddrs.length ? `listening: ${net.listenAddrs.join(', ')}` : '',
          ]
              .filter(Boolean)
              .join('\n')
        : '';

    return (
        <div className="flex h-full w-full flex-col bg-surface-1 text-ink">
            {/* Studio top bar — brand + channel crumb + members toggle */}
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-surface-2 px-4">
                <span className="text-sm font-bold tracking-tight text-ink">
                    peers <span className="text-accent">•</span>
                </span>
                <span className="hidden text-sm text-muted sm:block">
                    {server ? (
                        <>
                            <b className="font-semibold text-ink">{server.name}</b> / #{activeChannel ?? '…'}
                        </>
                    ) : plazaOpen ? (
                        <b className="font-semibold text-ink">plaza</b>
                    ) : dm ? (
                        <b className="font-semibold text-ink">{dm.name}</b>
                    ) : (
                        '—'
                    )}
                </span>
                <button
                    onClick={() => setShowMembers((v) => !v)}
                    className={`ml-auto rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        showMembers ? 'border-accent bg-accent text-black' : 'border-edge bg-surface-3 text-muted hover:bg-surface-4 hover:text-ink'
                    }`}
                    title={showMembers ? 'Hide members' : 'Show members'}
                >
                    Members
                </button>
                <span className="hidden text-xs text-faint sm:block" title={netTitle}>
                    {netLabel()}
                </span>
            </div>
            {net && net.knownNodes === 0 && net.reachability !== 'direct' && (
                <div className="flex shrink-0 items-center gap-2 bg-accent-soft px-4 py-1.5 text-[11px] text-warn">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                    <span>
                        Offline — directory unreachable. Messages will only reach peers on your LAN.
                    </span>
                </div>
            )}
            <div className="flex min-h-0 flex-1">
            <div className="flex w-[316px] shrink-0 flex-col border-r border-edge bg-surface-2">
            <div className="flex min-h-0 flex-1">
            <ServerRail
                servers={serverList}
                dms={dms}
                activeServer={dmOpen ? null : activeServer}
                activeDm={dmOpen ? (activeDm ?? '__dms__') : null}
                plazaActive={plazaOpen}
                onSelect={select}
                onCreate={() => void createSrv()}
                onJoin={() => void join()}
                serverHasUnread={(id) =>
                    Object.entries(unread).some(([k, n]) => n > 0 && k.startsWith(`${id}/`))
                }
                you={me?.peerIdShort ?? 'y'}
                youFull={me?.peerId ?? ''}
                onCopyYou={copyMyId}
                onOpenSettings={openSettings}
                onAddFriend={openAddFriend}
            />
            {plazaOpen ? (
                <div className="flex h-full w-[248px] flex-col bg-surface-2">
                    <div className="flex h-12 shrink-0 items-center justify-between border-b border-surface-1 px-4">
                        <span className="font-semibold">Plaza</span>
                        <span className="text-[10px] text-faint">{plazaHere} here</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                        {plazaRoster.map((p) => {
                            const prof = profiles[p.peerId];
                            const name = prof?.displayName || shortId(p.peerId);
                            return (
                                <div key={p.peerId} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-ink-dim">
                                    <span
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
                                        style={{background: colorFor(p.peerId)}}
                                    >
                                        {name[0].toUpperCase()}
                                    </span>
                                    <span className="flex-1 truncate">{name}</span>
                                    <span className="h-2 w-2 rounded-full bg-online"/>
                                </div>
                            );
                        })}
                        {me && (
                            <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-ink-dim">
                                <span
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
                                    style={{background: THEME.online}}
                                >
                                    {(myProfile?.displayName || me.peerIdShort)[0].toUpperCase()}
                                </span>
                                <span className="flex-1 truncate">{myProfile?.displayName || me.peerIdShort}</span>
                                <span className="h-2 w-2 rounded-full bg-online"/>
                            </div>
                        )}
                        {plazaRoster.length === 0 && (
                            <div className="px-2 py-4 text-xs text-muted">
                                No one in the Plaza right now — say hi!
                            </div>
                        )}
                    </div>
                </div>
            ) : dmOpen ? (
                <div className="flex h-full w-[248px] flex-col bg-surface-2">
                    <div className="flex h-12 shrink-0 items-center justify-between border-b border-surface-1 px-4">
                        <span className="font-semibold">Direct messages</span>
                        <button
                            onClick={() => void addDm()}
                            title="Message a peer by ID"
                            className="flex h-6 w-6 items-center justify-center rounded text-lg font-light text-online hover:bg-surface-3"
                        >
                            +
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                        {friendRequests.length > 0 && (
                            <div className="mb-2 rounded-lg border border-surface-3 bg-surface-1 p-2">
                                <div className="mb-1 text-[10px] font-semibold uppercase text-muted">
                                    Friend requests
                                </div>
                                {friendRequests.map((r) => (
                                    <div key={r.peerId} className="flex items-center gap-2 py-1">
                                        <span
                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
                                            style={{background: colorFor(r.peerId)}}
                                        >
                                            {(r.displayName || shortId(r.peerId))[0].toUpperCase()}
                                        </span>
                                        <span className="flex-1 truncate text-xs text-ink">
                                            {r.displayName || shortId(r.peerId)}
                                        </span>
                                        <button
                                            onClick={() => void doAcceptFriend(r.peerId)}
                                            className="rounded bg-online px-1.5 py-0.5 text-[10px] font-bold text-black hover:bg-online/80"
                                        >
                                            ✓
                                        </button>
                                        <button
                                            onClick={() => doDeclineFriend(r.peerId)}
                                            className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-muted hover:bg-surface-4"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        {dms.length === 0 && friendRequests.length === 0 && (
                            <div className="px-2 py-4 text-xs text-muted">
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
                                    void loadDmHistory(d.id);
                                }}
                                className={`relative flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                                    d.id === activeDm ? 'bg-surface-4 text-ink' : 'text-ink-dim hover:bg-surface-3'
                                }`}
                            >
                                <span
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
                                    style={{background: colorFor(d.id)}}
                                >
                                    {avatarFor(d.id) ? (
                                        <img src={avatarFor(d.id) as string} alt="" className="h-full w-full rounded-full object-cover"/>
                                    ) : (
                                        (profiles[d.id]?.displayName || d.name)[0].toUpperCase()
                                    )}
                                </span>
                                {online.has(d.id) && (
                                    <span className="absolute left-[22px] top-[22px] h-2.5 w-2.5 rounded-full border-2 border-surface-2 bg-online"/>
                                )}
                                <span className="flex-1 truncate">{profiles[d.id]?.displayName || d.name}</span>
                                {d.unread > 0 && (
                                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
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
                    online={online}
                    onSelectChannel={selectChannel}
                    onInvite={() => void copyInvite(server.id)}
                    onAddChannel={() => void addChannel(server.id)}
                    onAddMember={() => void addMemberUi(server.id)}
                    onAcceptJoin={(n) => void acceptJoin(n)}
                    onRejectJoin={rejectJoin}
                    onLeave={() => void leave(server.id)}
                    onRename={() => void renameSrv(server.id)}
                    onRotateKey={() => void rotateKeyUi(server.id)}
                    onKickMember={(peerId) => void kickMember(server.id, peerId)}
                    onPromoteMember={(peerId, role) => void promoteMember(server.id, peerId, role)}
                    onExportSnapshot={() => void exportSnapshotUi(server.id)}
                    onImportSnapshot={() => void importSnapshotUi(server.id)}
                />
            ) : (
                <div className="flex h-full w-[248px] items-center justify-center bg-surface-2 px-4 text-center text-xs text-muted">
                    <div>
                        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-3 text-accent">◈</div>
                        <div className="font-medium text-ink">No server selected</div>
                        <div className="mt-1 text-faint">Create a server or join with an invite</div>
                    </div>
                </div>
            )}
            </div>
            {/* left downbar — your info, lives under rail+channels (316px), not full width */}
            <div className="flex h-[56px] shrink-0 items-center gap-3 border-t border-edge bg-surface-1 px-3">
                <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-black"
                    style={{background: THEME.online}}
                >
                    {(myProfile?.displayName || me?.peerIdShort || 'Y')[0].toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">
                        {myProfile?.displayName || me?.peerIdShort || 'you'}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted">
                        {me ? shortId(me.peerId) : '…'} {online.size > 0 && `· ${online.size} online`}
                    </div>
                </div>
                <button
                    onClick={copyMyId}
                    className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-ink"
                    title="Copy peer id"
                >
                    ⧉
                </button>
                <button
                    onClick={openSettings}
                    className="rounded-lg bg-accent p-1.5 text-black hover:bg-accent-hover"
                    title="Profile & settings"
                >
                    ⚙
                </button>
            </div>
            </div>
            <MessagePane
                channelName={paneName || '…'}
                subtitle={[
                    plazaOpen
                        ? `Public · ${plazaHere} here`
                        : dm
                          ? `E2E encrypted · direct · ${dmOnline ? 'online' : 'offline'}`
                          : server
                            ? `E2E encrypted · ${onlineCount}/${server.memberCount} online`
                            : '',
                    netLabel(),
                ]
                    .filter(Boolean)
                    .join('  ·  ')}
                subtitleTitle={netTitle}
                messages={paneMessages}
                members={paneMembers}
                myPeerId={me?.peerId ?? ''}
                onSend={send}
                avatarFor={avatarFor}
            />
            {showMembers && (
                <div className="hidden w-[220px] shrink-0 flex-col border-l border-edge bg-surface-2 xl:flex">
                    <div className="flex h-12 shrink-0 items-center px-4 text-[11px] font-bold uppercase tracking-wide text-muted">
                        Members — {paneMembers.length}
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                        {paneMembers.length === 0 ? (
                            <div className="px-2 py-4 text-center text-xs text-muted">No members yet</div>
                        ) : (
                            paneMembers.map((m) => (
                                <div key={m.peerId} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-dim hover:bg-surface-3">
                                    <span
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
                                        style={{background: colorFor(m.peerId)}}
                                    >
                                        {m.name[0]?.toUpperCase() ?? '?'}
                                    </span>
                                    <span className="flex-1 truncate">{m.name}</span>
                                    {online.has(m.peerId) && <span className="h-2 w-2 shrink-0 rounded-full bg-online" />}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
            </div>
            {addOpen && (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={() => setAddOpen(false)}>
                    <div onClick={(e) => e.stopPropagation()} className="w-[28rem] rounded-2xl border border-surface-3 bg-surface-2 p-5">
                        <div className="mb-4 flex items-center justify-between">
                            <h2 className="text-lg font-bold text-ink">Add a friend</h2>
                            <button type="button" onClick={() => setAddOpen(false)} className="text-muted hover:text-ink">✕</button>
                        </div>

                        <p className="mb-2 text-xs text-muted">Your code — share it however you like.</p>
                        <div className="mb-4 flex items-center gap-4 rounded-lg bg-surface-1 p-3">
                            {code && (
                                <img
                                    src={qrDataUrl(code.replace(/\s/g, ''), 3, 2)}
                                    alt="Your peer code as a QR code"
                                    className="h-24 w-24 shrink-0 rounded"
                                />
                            )}
                            <div className="min-w-0">
                                <div className="selectable font-mono text-lg tracking-wide text-accent">{code || '…'}</div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void copyOrShow(
                                            code.replace(/\s/g, ''),
                                            'Your friend code',
                                            'Code copied',
                                        );
                                    }}
                                    className="mt-1 text-xs text-muted hover:text-ink hover:underline"
                                >
                                    Copy code
                                </button>
                            </div>
                        </div>

                        <form onSubmit={(e) => void submitCode(e)}>
                            <label className="mb-1 block text-xs text-muted">Enter their 12-digit code</label>
                            <div className="flex gap-2">
                                <input
                                    value={codeInput}
                                    onChange={(e) => setCodeInput(e.target.value)}
                                    placeholder="4827 1193 6052"
                                    autoFocus
                                    className="flex-1 rounded-lg bg-surface-1 px-3 py-2 font-mono text-sm text-ink placeholder-faint outline-none focus:ring-1 focus:ring-accent/50"
                                />
                                <button
                                    type="submit"
                                    disabled={resolving}
                                    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                                >
                                    {resolving ? 'Searching…' : 'Find'}
                                </button>
                            </div>
                        </form>

                        {resolving && (
                            <p className="mt-3 text-xs text-muted">
                                Searching the DHT — this can take a few seconds.
                            </p>
                        )}

                        {resolved?.peerId && (
                            <div className="mt-4 rounded-lg border border-surface-3 bg-surface-1 p-3">
                                <div className="mb-2 flex items-center gap-2">
                                    <span
                                        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold text-black"
                                        style={{background: colorFor(resolved.peerId)}}
                                    >
                                        {avatarFor(resolved.peerId) ? (
                                            <img src={avatarFor(resolved.peerId) as string} alt="" className="h-full w-full object-cover"/>
                                        ) : (
                                            (profiles[resolved.peerId]?.displayName || resolved.peerId)[0].toUpperCase()
                                        )}
                                    </span>
                                    <div className="min-w-0">
                                        <div className="truncate text-sm font-semibold text-ink">
                                            {profiles[resolved.peerId]?.displayName || shortId(resolved.peerId)}
                                        </div>
                                        <div className="selectable truncate font-mono text-[10px] text-faint">
                                            {resolved.peerId}
                                        </div>
                                    </div>
                                </div>
                                <p className="mb-3 text-[11px] text-warn">
                                    A code only locates someone — it is not proof of who they are.
                                    Check this peer id matches what your friend told you before accepting.
                                </p>
                                <div className="flex justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setResolved(null)}
                                        className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-3"
                                    >
                                        Not them
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void acceptResolved()}
                                        className="rounded-lg bg-online px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
                                    >
                                        Add contact
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
            {settingsOpen && (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={() => setSettingsOpen(false)}>
                    <form
                        onSubmit={(e) => void saveProfile(e)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-96 rounded-2xl border border-surface-3 bg-surface-2 p-5"
                    >
                        <div className="mb-4 flex items-center justify-between">
                            <h2 className="text-lg font-bold text-ink">Your profile</h2>
                            <button type="button" onClick={() => setSettingsOpen(false)} className="text-muted hover:text-ink">✕</button>
                        </div>
                        <div className="mb-4 flex items-center gap-4">
                            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-black"
                                 style={{background: avatarBytes || myProfile?.avatarHash ? 'transparent' : THEME.online}}>
                                {avatarBytes ? (
                                    <img src={dataUrl(avatarBytes)} alt="" className="h-full w-full object-cover"/>
                                ) : myProfile?.avatarHash && blobUrl(myProfile.avatarHash) ? (
                                    <img src={blobUrl(myProfile.avatarHash) as string} alt="" className="h-full w-full object-cover"/>
                                ) : (
                                    (myProfile?.displayName || me?.peerIdShort || '?')[0].toUpperCase()
                                )}
                            </div>
                            <label className="cursor-pointer rounded-md bg-surface-3 px-3 py-1.5 text-sm text-ink hover:bg-surface-4">
                                Upload avatar
                                <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (f) void onAvatarFile(f);
                                    }}
                                />
                            </label>
                            <span className="text-[10px] text-faint">
                                {myProfile?.avatarHash ? 'Avatar shared across servers' : 'No avatar yet'}
                            </span>
                        </div>
                        <label className="mb-1 block text-xs text-muted">Display name</label>
                        <input
                            value={profileName}
                            onChange={(e) => setProfileName(e.target.value)}
                            className="mb-3 w-full rounded-lg bg-surface-1 px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent/50"
                            placeholder="Display name"
                        />
                        <label className="mb-1 block text-xs text-muted">About</label>
                        <textarea
                            value={profileAbout}
                            onChange={(e) => setProfileAbout(e.target.value)}
                            rows={2}
                            className="mb-4 w-full resize-none rounded-lg bg-surface-1 px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent/50"
                            placeholder="A short bio…"
                        />
                        <div className="mb-4 rounded-lg bg-surface-1 p-3">
                            <div className="mb-1 text-xs text-muted">Your peer code</div>
                            <div className="selectable font-mono text-base tracking-wide text-accent">{code || '…'}</div>
                            <div className="selectable mt-1 break-all font-mono text-[10px] text-faint">
                                {me?.peerId}
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setSettingsOpen(false)} className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-3">
                                Cancel
                            </button>
                            <button type="submit" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover">
                                Save
                            </button>
                        </div>
                    </form>
                </div>
            )}
            <DialogHost controller={dialogController}/>
            {notice && (
                <div
                    className="fixed bottom-4 right-4 z-50 max-w-sm cursor-pointer rounded-lg border border-online/30 bg-surface-3 px-3 py-2 text-xs text-online"
                    onClick={() => setNotice(null)}
                    title="Dismiss"
                >
                    {notice}
                </div>
            )}
            {error && (
                <div
                    className="fixed bottom-4 right-4 z-50 max-w-sm cursor-pointer rounded-lg border border-danger/30 bg-surface-3 px-3 py-2 text-xs text-danger"
                    onClick={() => setError(null)}
                    title="Dismiss"
                >
                    {error}
                </div>
            )}
        </div>
    );
}
