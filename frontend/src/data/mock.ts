export type Role = "owner" | "admin" | "member";

export interface Member {
    id: string;
    name: string;
    role: Role;
    online: boolean;
}

export interface Channel {
    id: string;
    name: string;
    topic?: string;
    unread: number;
}

export interface Server {
    id: string;
    name: string;
    short: string;
    color: string;
    channels: Channel[];
    members: Member[];
}

export interface Message {
    id: string;
    author: string;
    authorColor: string;
    time: string;
    text: string;
    replyTo?: string;
}

export interface DM {
    id: string;
    name: string;
    unread: number;
    online: boolean;
}

export const servers: Server[] = [
    {
        id: "srv-hashgreen",
        name: "Hash Garden",
        short: "HG",
        color: "#4ade80",
        channels: [
            {id: "c-general", name: "general", unread: 3},
            {id: "c-memes", name: "memes", unread: 12},
            {id: "c-crypto", name: "crypto", unread: 0},
        ],
        members: [
            {id: "m-1", name: "alice", role: "owner", online: true},
            {id: "m-2", name: "bob", role: "admin", online: true},
            {id: "m-3", name: "carol", role: "member", online: false},
            {id: "m-4", name: "you", role: "member", online: true},
        ],
    },
    {
        id: "srv-pear",
        name: "Pear Shack",
        short: "PS",
        color: "#facc15",
        channels: [
            {id: "c-chill", name: "chill", unread: 0},
            {id: "c-offtopic", name: "off-topic", unread: 1},
        ],
        members: [
            {id: "m-1", name: "alice", role: "admin", online: true},
            {id: "m-4", name: "you", role: "member", online: true},
        ],
    },
];

export const dms: DM[] = [
    {id: "dm-alice", name: "alice", unread: 2, online: true},
    {id: "dm-bob", name: "bob", unread: 0, online: false},
];

export const messages: Record<string, Message[]> = {
    "c-general": [
        {id: "x1", author: "alice", authorColor: "#4ade80", time: "06:01", text: "hey everyone, the swarm is up"},
        {id: "x2", author: "bob", authorColor: "#60a5fa", time: "06:02", text: "sweet, blob parking works now?"},
        {id: "x3", author: "alice", authorColor: "#4ade80", time: "06:03", text: "persistent until fetched. you stayed offline overnight, got 4 parked blobs"},
        {id: "x4", author: "you", authorColor: "#f472b6", time: "06:05", text: "end-to-end or it didn't happen", replyTo: "x2"},
    ],
    "c-memes": [
        {id: "y1", author: "carol", authorColor: "#fbbf24", time: "05:55", text: "SHA-256 of your soul. 64 hex chars. no refunds."},
        {id: "y2", author: "bob", authorColor: "#60a5fa", time: "05:57", text: "cat gif incoming via magnet blob"},
    ],
    "c-crypto": [],
    "c-chill": [
        {id: "z1", author: "alice", authorColor: "#4ade80", time: "07:12", text: "pears > servers. fight me."},
    ],
    "c-offtopic": [],
};

export const dmMessages: Record<string, Message[]> = {
    "dm-alice": [
        {id: "d1", author: "alice", authorColor: "#4ade80", time: "06:10", text: "fingerprint verified out of band?"},
        {id: "d2", author: "you", authorColor: "#f472b6", time: "06:11", text: "yeah, 3b7f…c9a2 matches"},
    ],
    "dm-bob": [],
};
