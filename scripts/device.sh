#!/usr/bin/env bash
#
# Point a device build at this Mac's relay server.
#
#   scripts/device.sh            # detect the LAN address and configure the build
#   scripts/device.sh 192.168.1.5    # use a specific address
#   scripts/device.sh --reset    # go back to loopback (simulator)
#   scripts/device.sh --open     # configure, then open Xcode
#
# On a phone, 127.0.0.1 is the phone. A device demo has to reach the Mac by its
# address on the Wi-Fi network, so this writes Config/Local.xcconfig (gitignored)
# and regenerates the Xcode project. Both machines must be on the same network.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The Xcode project is generated, so its name comes from project.yml.
XCODE_PROJECT_NAME="$(awk '/^name:/ {print $2; exit}' "$REPO_ROOT/project.yml")"
LOCAL_XCCONFIG="$REPO_ROOT/Config/Local.xcconfig"
PORT="${PORT:-8080}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓  %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[31mx  %s\033[0m\n' "$*" >&2; exit 1; }

# The address of whichever interface carries the default route — Wi-Fi in
# practice. Falls back to scanning the usual interface names.
detect_ip() {
  local iface ip
  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')" || true
  if [ -n "${iface:-}" ]; then
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null)" || true
    [ -n "${ip:-}" ] && { printf '%s' "$ip"; return 0; }
  fi
  for iface in en0 en1 en2 en3; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null)" || true
    [ -n "${ip:-}" ] && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

regenerate() {
  command -v xcodegen >/dev/null 2>&1 || die "xcodegen not found. Install it with: brew install xcodegen"
  xcodegen generate --spec "$REPO_ROOT/project.yml" >/dev/null
  ok "Regenerated $XCODE_PROJECT_NAME.xcodeproj"
}

OPEN_XCODE=0
TARGET_IP=""
for arg in "$@"; do
  case "$arg" in
    --reset)
      rm -f "$LOCAL_XCCONFIG"
      regenerate
      ok "Back to loopback (ws://127.0.0.1:$PORT) — right for the simulator"
      exit 0
      ;;
    --open) OPEN_XCODE=1 ;;
    -*)     die "unknown option: $arg" ;;
    *)      TARGET_IP="$arg" ;;
  esac
done

if [ -z "$TARGET_IP" ]; then
  TARGET_IP="$(detect_ip)" || die "Could not work out this Mac's address. Pass it explicitly: scripts/device.sh 192.168.1.5"
fi

case "$TARGET_IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
  127.*) die "$TARGET_IP is loopback — a phone cannot reach the Mac at that address. Use --reset for the simulator." ;;
  *) warn "$TARGET_IP is not a private LAN address. App Transport Security only exempts private ranges, so the app may refuse to connect." ;;
esac

mkdir -p "$(dirname "$LOCAL_XCCONFIG")"
cat > "$LOCAL_XCCONFIG" <<EOF
// Written by scripts/device.sh. Gitignored — this address is specific to the
// network this Mac is on right now, and changes when you move networks.
RELAY_HOST = $TARGET_IP:$PORT
EOF
ok "Relay set to ws://$TARGET_IP:$PORT"

regenerate

printf '\n'
bold "Next"
info "1. Start the relay in another terminal tab, and leave it running:"
dim  "     cd $REPO_ROOT/server && npm start"
info "2. Put the iPhone and this Mac on the same Wi-Fi, then plug the iPhone in"
info "3. In Xcode: pick your iPhone at the top, then press the ▶ button"
dim  "     Signing & Capabilities -> Team must be set the first time."
info "4. On first launch the phone asks to find devices on the local network — allow it"

printf '\n'
dim  "When you go back to the simulator: scripts/device.sh --reset"

if [ "$OPEN_XCODE" -eq 1 ]; then
  open "$REPO_ROOT/$XCODE_PROJECT_NAME.xcodeproj"
fi
