import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";

export type Role = "member" | "admin" | "owner";

export interface PeerCard {
    edPub: number[];
    x25519Pub: number[];
    sig: number[];
}

export interface SignedProfile {
    version: number;
    peerId: string;
    pubkey: number[];
    displayName: string;
    about: string;
    avatarHash: string | null;
    sig: string;
}

export interface ChannelConfig {
    name: string;
    topic: string;
    readMin: Role;
    writeMin: Role;
}

export interface Member {
    peerId: string;
    name: string;
    role: Role;
    joinedEpoch: number;
    card?: PeerCard;
    profile?: SignedProfile;
}

export interface ServerView {
    id: string;
    name: string;
    ownerPeer: string;
    isOwner: boolean;
    myRole: Role | null;
    memberCount: number;
    epoch: number;
    pending: boolean;
    channels: ChannelConfig[];
    members: Member[];
}

export interface IdentityInfo {
    peerId: string;
    peerIdShort: string;
    fingerprint: string;
    defaultName?: string;
}

export interface ServerMessage {
    serverId: string;
    channel: string;
    from: string;
    text: string;
    ts: number;
}

export interface NodeMessage {
    from: string;
    channel: string;
    text?: string;
    error?: string;
}

export interface JoinNotice {
    kind: string;
    serverId: string;
    peerId: string;
    name: string;
    nonce: number[];
    card: PeerCard;
}

export interface SignedMessageDto {
    version: number;
    serverId: string;
    channel: string;
    from: string;
    pubkey: number[];
    text: string;
    ts: number;
    sig: string;
}

export interface DmMessageDto {
    peer: string;
    text: string;
    ts: number;
    mine: boolean;
}

export interface UiMessage {
    id: string;
    author: string;
    authorColor: string;
    time: string;
    text: string;
    mine: boolean;
    /** Peer id of the author (for avatars); omitted for plain DMs. */
    authorPeer?: string;
    /** True when this server message @-mentions our own peer id (a ping). */
    mentionsMe?: boolean;
}

/** A verified Plaza message as stored/returned by the backend. */
export interface PlazaMessageDto {
    version: number;
    kind: string;
    from: string;
    pubkey: number[];
    ts: number;
    text: string;
    profile?: SignedProfile | null;
    sig: string;
}

/** Frontend-friendly Plaza post (author resolved to a display name). */
export interface PlazaPost {
    id: string;
    author: string;
    authorColor: string;
    authorPeer: string;
    time: string;
    text: string;
    mine: boolean;
    profile?: SignedProfile | null;
}

/** A Plaza participant and when they were last seen (plaza_who). */
export interface PlazaPresence {
    peerId: string;
    lastTs: number;
}

/** A live plaza://profile announcement. */
export interface PlazaProfile {
    peerId: string;
    profile: SignedProfile | null;
}

/** A live plaza://message announcement. */
export interface PlazaMessage {
    from: string;
    text: string;
    ts: number;
    profile?: SignedProfile | null;
}

/** A snapshot of our own connectivity (net_status). */
export interface NetStatus {
    peers: number;
    listenAddrs: string[];
    externalAddrs: string[];
    relayReservations: number;
    /** Measured by an AutoNAT dial-back once `reachabilityMeasured` is true;
     *  inferred from observed addresses until then. */
    reachability: "direct" | "relayed" | "unreachable" | "unknown";
    /** True once AutoNAT has actually probed us, so the UI can stop hedging. */
    reachabilityMeasured: boolean;
    /** How many always-on nodes are configured. 0 means cross-NAT chat
     *  will not work — see docs/running-a-node.md. */
    knownNodes: number;
}

/** Our short 12-digit peer code: a lookup hint, never proof of identity. */
export interface PeerCode {
    code: string;
    formatted: string;
}

export const hasIdentity = () => invoke<boolean>("has_identity");
export const isUnlocked = () => invoke<boolean>("is_unlocked");
export const generatePhrase = (wordCount = 12) =>
    invoke<string>("generate_phrase", {wordCount});
export const initFromPhrase = (phrase: string) =>
    invoke<IdentityInfo>("init_from_phrase", {phrase});
export const myCode = () => invoke<PeerCode>("my_code");
/** Starts an async DHT lookup; the answer arrives via onCodeResolved. */
export const lookupCode = (code: string) => invoke<string>("lookup_code", {code});
/** Subscribes to a peer's DM topic so we can exchange messages. */
export const addContact = (peerId: string) => invoke<void>("add_contact", {peerId});
/** Sends a friend request to a peer. The request carries our profile so the
 *  recipient knows who is asking. Also subscribes to their DM topic so we
 *  receive their messages once they accept. */
export const sendFriendRequest = (peerId: string) =>
    invoke<void>("send_friend_request", {peerId});
/** Accepts an incoming friend request: subscribes to the requester's DM topic
 *  and sends a confirmation back. */
export const acceptFriend = (peerId: string) =>
    invoke<void>("accept_friend", {peerId});
export const netStatus = () => invoke<NetStatus>("net_status");

/** A friend code resolved (or failed to) via the DHT. `peerId` is null when
 *  nobody is providing that code. A match is a *location*, not an identity —
 *  verify the profile before trusting it. */
export const onCodeResolved = (cb: (e: {code: string; peerId: string | null}) => void) =>
    listen<{code: string; peerId: string | null}>("code://resolved", (e) => cb(e.payload));
/** A relayed connection upgraded to direct (or failed to, and stays relayed). */
export const onHolePunch = (cb: (e: {peerId: string; direct: boolean}) => void) =>
    listen<{peerId: string; direct: boolean}>("net://hole-punch", (e) => cb(e.payload));
/** An incoming friend request from a peer who scanned our code. */
export const onFriendRequest = (cb: (e: {peerId: string; displayName: string; avatarHash: string | null}) => void) =>
    listen<{peerId: string; displayName: string; avatarHash: string | null}>("friend://request", (e) => cb(e.payload));
export const unlock = (password: string) => invoke<IdentityInfo>("unlock", {password});
export const lock = () => invoke<void>("lock");

export const createServer = (name: string) => invoke<ServerView>("create_server", {name});
export const listServers = () => invoke<ServerView[]>("list_servers");
export const createInvite = (serverId: string) => invoke<string>("create_invite", {serverId});
export const joinServer = (inviteJson: string, name: string) =>
    invoke<ServerView>("join_server", {inviteJson, name});
export const leaveServer = (serverId: string) => invoke<void>("leave_server", {serverId});
export const addMember = (serverId: string, peerId: string, name: string, role: Role, card?: PeerCard) =>
    invoke<ServerView>("add_member", {serverId, peerId, name, role, card});
export const setChannel = (serverId: string, name: string, topic: string, readMin: Role, writeMin: Role) =>
    invoke<ServerView>("set_channel", {serverId, name, topic, readMin, writeMin});

export const subscribeChannel = (serverId: string, channel: string) =>
    invoke<void>("subscribe_channel", {serverId, channel});
export const publishChannel = (serverId: string, channel: string, text: string) =>
    invoke<void>("publish_channel", {serverId, channel, text});

export const subscribe = (channel: string) => invoke<void>("subscribe", {channel});
export const publish = (channel: string, text: string) => invoke<void>("publish", {channel, text});

export const setProfile = (displayName: string, about: string, avatarHash: string | null) =>
    invoke<SignedProfile>("set_profile", {displayName, about, avatarHash});
export const getProfile = () => invoke<SignedProfile | null>("get_profile");
export const contactProfiles = () =>
    invoke<Record<string, SignedProfile>>("contact_profiles");

export const parkBlob = (data: number[]) => invoke<void>("park_blob", {data});
export const fetchBlob = (hash: string) => invoke<void>("fetch_blob", {hash});

export const publishPlaza = (text: string) => invoke<void>("publish_plaza", {text});
export const plazaHistory = () => invoke<PlazaMessageDto[]>("plaza_history");
export const plazaWho = () => invoke<PlazaPresence[]>("plaza_who");

export const onBlobFetched = (cb: (e: {hash: string; data: number[]}) => void) =>
    listen<{hash: string; data: number[]}>("blob://fetched", (e) => cb(e.payload));
export const onBlobFetchFailed = (cb: (e: {hash: string; reason: string}) => void) =>
    listen<{hash: string; reason: string}>("blob://failed", (e) => cb(e.payload));
export const onBlobParked = (cb: (e: {hash: string}) => void) =>
    listen<{hash: string}>("blob://parked", (e) => cb(e.payload));
export const onPlazaMessage = (cb: (m: PlazaMessage) => void) =>
    listen<PlazaMessage>("plaza://message", (e) => cb(e.payload));
export const onPlazaProfile = (cb: (m: PlazaProfile) => void) =>
    listen<PlazaProfile>("plaza://profile", (e) => cb(e.payload));

export const serverHistory = (serverId: string, channel: string) =>
    invoke<SignedMessageDto[]>("server_history", {serverId, channel});
export const dmHistory = (peer: string) => invoke<DmMessageDto[]>("dm_history", {peer});
export const onlinePeers = () => invoke<string[]>("online_peers");
export const renameServer = (serverId: string, name: string) =>
    invoke<ServerView>("rename_server", {serverId, name});
export const removeMember = (serverId: string, peerId: string) =>
    invoke<ServerView>("remove_member", {serverId, peerId});
export const setRole = (serverId: string, peerId: string, role: Role) =>
    invoke<ServerView>("set_role", {serverId, peerId, role});
export const rotateKey = (serverId: string) =>
    invoke<ServerView>("rotate_key", {serverId});
export const exportSnapshot = (serverId: string) => invoke<string>("export_snapshot", {serverId});
export const importSnapshot = (serverId: string, snapshotJson: string) =>
    invoke<number>("import_snapshot", {serverId, snapshotJson});

export const onServerList = (cb: (v: ServerView) => void) =>
    listen<ServerView>("server://list", (e) => cb(e.payload));
export const onServerMessage = (cb: (m: ServerMessage) => void) =>
    listen<ServerMessage>("server://message", (e) => cb(e.payload));
export const onServerError = (cb: (e: {serverId: string; error: string}) => void) =>
    listen<{serverId: string; error: string}>("server://error", (e) => cb(e.payload));
export const onNodeMessage = (cb: (m: NodeMessage) => void) =>
    listen<NodeMessage>("node://message", (e) => cb(e.payload));
export const onJoinRequest = (cb: (n: JoinNotice) => void) =>
    listen<JoinNotice>("server://join-request", (e) => cb(e.payload));
export const onPeerConnected = (cb: (peerId: string) => void) =>
    listen<string>("presence://peer-connected", (e) => cb(e.payload));
export const onPeerDisconnected = (cb: (peerId: string) => void) =>
    listen<string>("presence://peer-disconnected", (e) => cb(e.payload));

export const shortId = (id: string) => (id.length > 13 ? `${id.slice(0, 12)}…` : id);

/** Byte array → base64, chunked to avoid argument limits on larger blobs. */
export function bytesToBase64(bytes: number[]): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
    }
    return btoa(binary);
}

/** Byte array → an image data URL suitable for avatar `<img>` elements. */
export const dataUrl = (bytes: number[]): string =>
    `data:image/png;base64,${bytesToBase64(bytes)}`;

/** Copies `text`; false lets the caller present a selectable in-app fallback. */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

/** Anything that has a server name and (optionally) a signed profile —
 *  both server members and Plaza participants qualify. */
export interface Contact {
    peerId: string;
    name: string;
    profile?: SignedProfile;
}

export const peerName = (peerId: string, members: Contact[]) =>
    members.find((m) => m.peerId === peerId)?.name ?? shortId(peerId);

/** Display name for a contact: signed profile name first, else local name. */
export const memberName = (m: {name: string; profile?: SignedProfile}) =>
    m.profile?.displayName && m.profile.displayName.trim() ? m.profile.displayName : m.name;

/** A parsed @-mention in a message: the peer id and (if a member) the member. */
export interface Mention {
    start: number;
    end: number;
    peerId: string;
    member?: Contact;
}

const MENTION_RE = /@([0-9A-Za-z]{44,52})/g;

/** Finds `@<peerId>` mentions in `text`, resolving each against `members`.
 *  Mentions of non-members are still returned (peerId set, member undefined)
 *  so the caller can render them as "not a ping". */
export function parseMentions(text: string, members: Contact[]): Mention[] {
    const out: Mention[] = [];
    const re = new RegExp(MENTION_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const peerId = m[1];
        out.push({
            start: m.index,
            end: m.index + m[0].length,
            peerId,
            member: members.find((x) => x.peerId === peerId),
        });
    }
    return out;
}

/** True if `text` mentions our own peer id (so we can flag pings). */
export function mentionsMe(text: string, myPeerId: string): boolean {
    return text.includes(`@${myPeerId}`);
}

/** Theme colours needed as runtime values (inline styles, canvas, derived
 *  colours) rather than Tailwind classes. Keep in sync with the `@theme`
 *  block in style.css — these are the only duplicates of those tokens. */
export const THEME = {
    accent: "#e8863c",
    online: "#7bb08a",
    danger: "#d9614f",
    warn: "#e0b04a",
    muted: "#8f8574",
} as const;

/** Stable per-peer identity colour. Warm hues chosen to sit on the Ember
 *  surfaces and stay distinguishable from each other; this is the one place
 *  colours are literals rather than theme tokens, because the value is
 *  derived at runtime from a peer id rather than chosen by a designer. */
export const colorFor = (s: string) => {
    const palette = [
        "#e8863c", // ember
        "#7bb08a", // sage
        "#d98f6a", // clay
        "#c9a227", // brass
        "#b5836b", // terracotta
        "#8fa87b", // moss
        "#d97b6c", // rust
        "#a89170", // bronze
        "#e0b04a", // amber
        "#9c8f6d", // olive
    ];
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
};

export const timeFor = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
