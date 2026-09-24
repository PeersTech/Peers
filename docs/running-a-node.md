# Running a Peers node

A **node** is a Peers process with a public address that other peers can dial.
It is what makes chat work between two people who are both behind home routers
— which is to say, between almost any two people in different countries.

This guide gets one running in about ten minutes.

---

## Why you need one

Peers is serverless, but "no central server" does not mean "no machines in the
middle". Three different jobs get confused with each other:

| Job | What it means | Who can do it |
|---|---|---|
| **Discovery** | Finding *where* a peer is | The public IPFS DHT — free, already working |
| **Reachability** | Being dialable at all | Impossible behind a typical home router |
| **Relaying** | Carrying traffic when neither side is dialable | Only a machine with a public address |

The trap is that **DHT bootstrap is not relaying**. Peers already talks to the
public IPFS bootstrap nodes, and they will happily help you *find* someone —
but they will not forward your traffic. So two NAT'd laptops can discover each
other and still be unable to connect.

A node fixes that. Both peers dial the node, each reserves a circuit slot
through it, and their messages flow. Then **DCUtR hole-punching upgrades the
connection to direct** whenever the two NATs allow it, and the node drops out of
the path entirely. It is a switchboard, not a bottleneck.

The node never decrypts sealed direct messages. It does process signed
control traffic and server-channel messages, so it can observe that metadata
and plaintext protocol content. It is not a trusted party for the full
protocol.

### Do I definitely need one?

You do **not** if:
- both peers are on the same LAN, or
- either peer has a public IP, port forwarding, or open IPv6.

You **do** if both of you are on ordinary home or mobile connections. If you are
unsure, unlock Peers and look at the connectivity line next to the channel name.
`no relay node configured` means cross-NAT chat will not work yet.

---

## What it costs

A node is cheap because chat is small. The lowest tier of any VPS provider is
plenty (~$4/month), and a Raspberry Pi on your home connection works if you can
port-forward.

At the shipped caps (see [Capacity](#capacity)), a node uses roughly 30–60 MB of
RAM and negligible CPU. Bandwidth is the only real variable, and only for
relayed traffic that has not yet upgraded to direct.

---

## Setup

### 1. Build the binary

On the node machine (or build locally and copy the binary over):

```sh
git clone https://github.com/PeersTech/Peers.git
cd Peers/backend
cargo build --release
```

The binary lands at `backend/target/release/peers`.

> On a 1 GB Pi, `cargo build --release` may run out of memory while linking.
> Build on a bigger machine with the same architecture and `scp` the binary
> across, or add swap.

> **Running on Pterodactyl?** There is a ready-made egg at
> [PeersTech/ptero-egg](https://github.com/PeersTech/ptero-egg) that does all of
> this for you, including the public-address handling in step 3. Note that it
> needs a custom Docker image — the reasons are in that repo's README.

### 2. Open the firewall

The node listens on a TCP and a QUIC (UDP) port — 4001 by default. Allow both
protocols:

```sh
sudo ufw allow 4001/tcp
sudo ufw allow 4001/udp
```

If you set `PEERS_PORT` (below), open that port instead.

On a VPS, do the same in the provider's own firewall/security-group console —
that one is separate from `ufw` and is the usual reason a node looks up but is
unreachable.

If the node is on your home network, forward the same port to it on your router.

### 3. Run it

```sh
./peers --node
```

You will see something like:

```
peers node peer id: 12D3KooWQ7xJ4kR2mN8pL5vX3wY6zA9bC1dE4fG7hJ0kL2mN5pQ
peers node identity: /home/you/.config/peers/node_identity.json
listening: /ip4/203.0.113.7/tcp/4001/p2p/12D3KooWQ7xJ4kR2mN8pL5vX3wY6zA9bC1dE4fG7hJ0kL2mN5pQ
  → PEERS_NODES=/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWQ7xJ4kR2mN8pL5vX3wY6zA9bC1dE4fG7hJ0kL2mN5pQ
listening (local only): /ip4/127.0.0.1/tcp/4001/p2p/12D3KooW…
peers node is up.
```

Copy the `PEERS_NODES=` line that shows a **public** address. Lines marked
`local only` (`127.x`, `0.0.0.0`) are real listeners but useless to anyone else
— handing one of those to a client is the most common setup mistake.

The node's identity is generated on first run and stored `0600` at
`<config>/peers/node_identity.json`. **Keep that file.** Deleting it changes the
node's peer ID, and every client pointing at the old ID stops connecting.

#### On a cloud VM (AWS, GCP, Azure, Hetzner…)

Most cloud instances do not have their public IP on the network interface — the
provider NATs it. The node can only see the private address, so it will print
something like `/ip4/172.31.4.9/tcp/4001` and never mention your real address.
**Handing that line to a client cannot work.**

Tell the node its public address with `PEERS_ANNOUNCE`:

```sh
PEERS_ANNOUNCE=/ip4/203.0.113.7/tcp/4001 ./peers --node
```

It then prints the address clients actually need, and advertises it to the DHT
straight away instead of waiting to learn it from the first inbound connection:

```
announcing: /ip4/203.0.113.7/tcp/4001/p2p/12D3KooW…
  → PEERS_NODES=/ip4/203.0.113.7/tcp/4001/p2p/12D3KooW…
```

With `PEERS_ANNOUNCE` set, private listener addresses are demoted to
`local only`, so there is only one line to copy.

#### Node environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PEERS_PORT` | `4001` | TCP and QUIC port to bind. Must stay fixed — clients store it. |
| `PEERS_ANNOUNCE` | — | Comma-separated public multiaddrs, **without** `/p2p/<id>`. Required on NAT'd/cloud hosts. |
| `PEERS_NODES` | — | Other nodes to dial and reserve relay slots on, so nodes can chain. |
| `PEERS_NO_RELAY` | — | Presence disables relaying entirely. Overrides `--node`; don't set it on a node. |

To announce both transports, pass both:

```sh
PEERS_ANNOUNCE=/ip4/203.0.113.7/tcp/4001,/ip4/203.0.113.7/udp/4001/quic-v1
```

### 4. Point your clients at it

Both you and the person you want to talk to do this, with the same value.

Either set the environment variable:

```sh
export PEERS_NODES=/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWQ7x…
```

Or write `<config>/peers/nodes.json` (no env var needed, survives reboots):

```json
["/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWQ7xJ4kR2mN8pL5vX3wY6zA9bC1dE4fG7hJ0kL2mN5pQ"]
```

Config directory by platform:

| Platform | Path |
|---|---|
| Linux | `~/.config/peers/nodes.json` |
| macOS | `~/Library/Application Support/peers/nodes.json` |
| Windows | `%APPDATA%\peers\nodes.json` |

`PEERS_NODES` takes precedence when both are present. Multiple nodes are
comma-separated in the env var, or extra array entries in the JSON — more than
one is better, because any single node can go down.

Restart Peers on both machines.

### 5. Verify

In the app, the line beside the channel name should change from
`no relay node configured` to `N peers · via relay`, or `· direct` once
hole-punching succeeds. Hover it for listen addresses, external addresses and
reservation count.

On the node, watch for:

```
peer connected: 12D3KooW…
relay reservation granted to 12D3KooW…
reachability: public (peers dialed us successfully)
```

One line per client. If you see `peer connected` but never
`relay reservation granted`, the client reached the node but could not reserve a
slot — check that the node was started with `--node` and is not at capacity.

The `reachability:` line is an **AutoNAT** result: other peers were asked to dial
this node back, and it reports whether they got through. This is a measurement,
not a guess — unlike an address some peer merely claimed to observe. A node that
prints

```
reachability: PRIVATE — peers tried to dial this node and could not reach it.
```

is not reachable from the outside no matter how healthy the process looks, and
no client will ever be able to use it. That is a firewall, a security group, or
a missing `PEERS_ANNOUNCE`. `unknown` is not a failure: it means too few peers
were around to probe with yet.

### Recovering from restarts

Clients re-establish relay reservations automatically. If a node goes down, each
client retries with an exponential backoff — starting at 10 seconds and capping
at 5 minutes — so a node that comes back is picked up within minutes without
anyone restarting an app, while a node that stays down is not hammered by every
client that has it configured.

This means you can restart a node freely, **as long as its peer ID and port do
not change**. Keep `node_identity.json` and pin `PEERS_PORT`.

---

## Keeping it running (systemd)

`/etc/systemd/system/peers-node.service`:

```ini
[Unit]
Description=Peers relay node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=peers
StateDirectory=peers
Environment=PEERS_PORT=4001
Environment=XDG_CONFIG_HOME=/var/lib/peers/.config
# On a cloud VM, uncomment with your public IP — the instance cannot see it.
#Environment=PEERS_ANNOUNCE=/ip4/203.0.113.7/tcp/4001
ExecStart=/usr/local/bin/peers --node
Restart=always
RestartSec=10

# The node holds no user secrets — it only routes ciphertext — so it can be
# locked down hard. State lives under /var/lib/peers, not the protected home.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/peers

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd -r -m -d /home/peers peers
sudo mkdir -p /var/lib/peers/.config/peers
sudo chown -R peers:peers /var/lib/peers
sudo cp backend/target/release/peers /usr/local/bin/
sudo systemctl enable --now peers-node
journalctl -u peers-node -f
```

---

## Capacity

Every Peers install can relay — a node is not a special build, just a different
tier of the same binary. Whether an install *actually* relays is decided by
reachability, not configuration: an unreachable client can advertise slots
harmlessly, because nobody can dial it to use them. This is how open-port peers
carry a torrent swarm without being asked.

**Circuit relay slots** (how many clients can reserve circuits through this node):

| Tier | Reservations | Circuits | Per circuit | Who |
|---|---|---|---|---|
| `citizen` | 8 (2/peer) | 16 (2/peer) | 16 MiB | Every GUI client |
| `node` | 64 (4/peer) | 64 (8/peer) | 128 MiB | `--node` |
| `off` | 0 | 0 | — | `PEERS_NO_RELAY=1` |

The per-peer limits matter more than the totals: they stop one busy peer
consuming every slot on a shared box.

Set `PEERS_NO_RELAY=1` on a metered or battery-powered machine to forward
nothing.

**Raw connection limits** (how many TCP/QUIC sockets the node holds):

| Tier | Pending in/out | Established in/out | Per peer | Who |
|---|---|---|---|---|
| `client` | 16 / 32 | 64 / 128 | 8 | GUI clients |
| `node` | 64 / 64 | 512 / 256 | 8 | `--node` |

Why these exist: relay caps bound *circuits* — connections already accepted and
then forwarded. A peer that opens sockets but never asks for a circuit can
exhaust file descriptors or memory without touching the relay tier at all. This
is the cheapest way to take down a small VPS, and it needs no protocol
misbehaviour — just `nc` in a loop. These caps are deliberately higher than the
relay tier (512 inbound > 64 reservations), so the relay budget stays the
binding constraint. If it were reversed, a busy node would refuse connections at
random instead of declining reservations, which is much harder to diagnose.

---

## Troubleshooting

**The node only prints private addresses (`10.x`, `172.16–31.x`, `192.168.x`).**
It is behind NAT — almost always a cloud VM whose public IP lives on the
provider's edge, not on the instance's interface. The node cannot discover this
by itself. Set `PEERS_ANNOUNCE=/ip4/<public-ip>/tcp/4001` and restart. Do not
hand the private line to a remote client; it can never work.

**Client still says `no relay node configured`.**
`PEERS_NODES` was not visible to the app. If you launched Peers from a desktop
icon it will not see a shell `export` — use `nodes.json` instead.

**Client says `connecting` and never advances.**
The node is not reachable from the outside. From another machine:
`nc -vz <ip> 4001`. If that fails, it is the firewall — check the provider's
console as well as `ufw`.

**Reservations granted, but messages do not arrive.**
Both clients must point at the *same* node for it to bridge them. Confirm the
peer ID in both configs matches the node's.

**It worked, then stopped after a reboot.**
Either `node_identity.json` was lost, so the node has a new peer ID — restore
the file or redistribute the new `PEERS_NODES` line. Or the port moved: pin it
with `PEERS_PORT=4001` so it survives restarts.

**Stuck on `via relay`, never `direct`.**
Normal. DCUtR cannot punch through every NAT combination — symmetric NAT on
both ends defeats it. Chat still works; it just stays relayed.

**The node logs `reachability: PRIVATE`.**
AutoNAT asked other peers to dial this node and none of them got through. The
process is fine; the packets are not arriving. In order of likelihood: the
provider's security group or firewall is closed (check it separately from
`ufw`), the node is behind NAT and needs `PEERS_ANNOUNCE`, or the announced port
does not match `PEERS_PORT`. No client can use the node until this reads
`public`.

**Reachability says `unreachable` in the client UI.**
AutoNAT confirmed the client cannot be dialed *and* it holds no relay
reservation — so nothing can reach it at all. Configure `PEERS_NODES`; this is
the state the whole relay mechanism exists to fix.

**Clients keep reconnecting to the node every few seconds.**
They should not: retries back off exponentially to a 5-minute ceiling. Rapid
reconnects mean the reservation is being *granted and then lost*, which usually
means the node is at capacity (raise the tier or add a second node) or an
intermediate firewall is dropping idle connections.
