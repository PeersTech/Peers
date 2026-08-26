#!/usr/bin/env bash
# Peers desktop release builder — one command, all artifacts.
#
#   ./scripts/build-desktop.sh          # linux (appimage, tauri, host)
#   ./scripts/build-desktop.sh --win    # + windows (tauri exe, portable)
#   ./scripts/build-desktop.sh --nsis   # + windows installer (needs wine32)
#
# Output: apps/desktop/release/ with Peers-$VER-* names + SHA256SUMS.txt
set -euo pipefail

VER=$(node -p "require('./apps/tauri/src-tauri/tauri.conf.json').version")
REL=apps/desktop/release
WIN=0; NSIS=0
for a in "$@"; do
  [[ $a == --win ]] && WIN=1
  [[ $a == --nsis ]] && { WIN=1; NSIS=1; }
done

step() { printf '\033[2m==>\033[0m \033[1m%s\033[0m\n' "$*"; }

step "frontend (relative assets)"
npm --prefix frontend run build >/dev/null

step "desktop main/preload bundle"
npm --prefix apps/desktop run build >/dev/null

step "engine bundle (host.cjs)"
npx esbuild apps/web/src/host-standalone.ts --bundle --platform=node \
  --format=cjs --outfile=$REL/peers-host-v$VER.cjs >/dev/null

step "tauri binaries"
export PATH="$HOME/.cargo/bin:$PATH"
(cd apps/tauri/src-tauri && cargo build --release --features custom-protocol >/dev/null 2>&1)
cp apps/tauri/src-tauri/target/release/peers-tauri $REL/Peers-$VER-linux-x64

if [[ $WIN -eq 1 ]]; then
  step "tauri windows exe"
  (cd apps/tauri/src-tauri && cargo build --release --features custom-protocol --target x86_64-pc-windows-gnu >/dev/null 2>&1)
  cp apps/tauri/src-tauri/target/x86_64-pc-windows-gnu/release/peers-tauri.exe $REL/Peers-$VER-windows-x64.exe
fi

step "electron all-in-one (linux appimage)"
(cd apps/desktop && npx electron-builder --linux --publish never >/dev/null 2>&1)
cp $REL/Peers-$VER.AppImage $REL/Peers-$VER-linux-allinone.AppImage

if [[ $WIN -eq 1 ]]; then
  step "electron all-in-one (windows portable)"
  NSIS_FLAG=""
  [[ $NSIS -eq 0 ]] && NSIS_FLAG="-c.win.signAndEditExecutable=false"
  (cd apps/desktop && npx electron-builder --win portable --publish never $NSIS_FLAG >/dev/null 2>&1)
  mv "$REL/Peers $VER.exe" $REL/Peers-$VER-windows-allinone-portable.exe
  if [[ $NSIS -eq 1 ]]; then
    (cd apps/desktop && npx electron-builder --win nsis --publish never >/dev/null 2>&1)
    mv $REL/"Peers $VER Setup.exe" $REL/Peers-$VER-windows-setup.exe 2>/dev/null || true
  fi
fi

step "deb"
(cd apps/tauri/src-tauri && npx tauri build --bundles deb >/dev/null 2>&1)
cp apps/tauri/src-tauri/target/release/bundle/deb/Peers_${VER}_amd64.deb $REL/Peers-$VER-amd64.deb

step "checksums + gzip"
cd $REL
gzip -k -9 -f Peers-$VER-linux-x64 Peers-$VER-windows-x64.exe peers-host-v$VER.cjs 2>/dev/null || true
sha256sum Peers-$VER-* > SHA256SUMS.txt

echo ""
printf '\033[32m[ok]\033[0m Peers v%s artifacts:\n' "$VER"
ls -lh | grep "$VER" | grep -v ".gz$" | awk '{print "  " $9 " (" $5 ")"}'
