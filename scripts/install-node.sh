#!/usr/bin/env bash
# Installs a Peers backbone node as a systemd service.
#
#   sudo ./scripts/install-node.sh [--dir /opt/peers] [--port 4001] [--repo <git-url>]
#
# Idempotent: safe to re-run for upgrades (git pull + rebuild + restart).
# Prints the PEERS_NODES= line clients paste into their config when done.
set -euo pipefail

# Colour output for TTYs; plain text when piped or NO_COLOR is set.
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; D=''; N=''
fi
step() { printf '%s\n' "${D}==>${N} ${B}$*${N}"; }
ok()   { printf '%s\n' "${G}[ok]${N} $*"; }
die()  { printf '%s\n' "${R}error:${N} $*" >&2; exit 1; }

DIR=/opt/peers
PORT=4001
REPO="" # empty = use the checkout this script lives in

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ $(id -u) -eq 0 ]] || die "run with sudo/root"
command -v node >/dev/null || die "Node.js 22+ required (https://nodejs.org)"
NODE_BIN=$(readlink -f "$(command -v node)")
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[[ $NODE_MAJOR -ge 22 ]] || die "Node 22+ required, found $NODE_MAJOR"

step "placing sources in $DIR"
if [[ -n $REPO ]]; then
  [[ -d $DIR ]] || git clone "$REPO" "$DIR"
else
  SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  [[ $SCRIPT_DIR == "$DIR" ]] || { mkdir -p "$(dirname "$DIR")"; [[ -d $DIR ]] || cp -r "$SCRIPT_DIR" "$DIR"; }
fi
cd "$DIR"

step "building"
# dev deps stay: esbuild is needed to produce the CLI bundle.
npm ci >/dev/null
npm run build --workspace apps/cli >/dev/null

step "installing systemd unit"
cat > /etc/systemd/system/peers-node.service <<UNIT
[Unit]
Description=Peers relay node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PEERS_PORT=$PORT
Environment=HOME=$DIR
ExecStart=$NODE_BIN $DIR/apps/cli/bin/peers.js --node
WorkingDirectory=$DIR
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now peers-node

step "waiting for startup"
sleep 2
# This boot only (-b), newest line wins — old journal entries would lie.
LINE=$(journalctl -u peers-node -b --no-pager 2>/dev/null | grep -E 'PEERS_NODES=/' | tail -1 | sed 's/^.*PEERS_NODES=//')

systemctl is-active peers-node >/dev/null
echo ""
ok "peers-node is running (port $PORT)"
echo "   logs:    journalctl -u peers-node -f"
echo "   upgrade: cd $DIR && git pull && sudo ./scripts/install-node.sh --dir $DIR --port $PORT"
if [[ -n ${LINE:-} ]]; then
  echo ""
  echo "Give clients this line (also printed on every start):"
  echo "  $LINE"
  echo ""
  echo "Clients put it in ~/.config/peers/nodes.json like:"
  echo '  ["'"$LINE"'"]'
fi
