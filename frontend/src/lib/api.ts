import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";

export type Role = "member" | "admin" | "owner";

export interface PeerCard {
    edPub: number[];
    x25519Pub: number[];
    sig: number[];
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

export interface UiMessage {
    id: string;
    author: string;
    authorColor: string;
    time: string;
    text: string;
    mine: boolean;
}

export const hasIdentity = () => invoke<boolean>("has_identity");
export const isUnlocked = () => invoke<boolean>("is_unlocked");
export const initIdentity = (password: string) => invoke<IdentityInfo>("init_identity", {password});
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

export const shortId = (id: string) => (id.length > 13 ? `${id.slice(0, 12)}…` : id);

export const peerName = (peerId: string, members: Member[]) =>
    members.find((m) => m.peerId === peerId)?.name ?? shortId(peerId);

export const colorFor = (s: string) => {
    const palette = ["#4ade80", "#60a5fa", "#f472b6", "#facc15", "#fb923c", "#a78bfa", "#2dd4bf", "#f87171"];
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
};

export const timeFor = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
