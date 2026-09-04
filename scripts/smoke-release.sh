#!/usr/bin/env bash
#
# Release-build smoke launch for Honmaru AI.
#
#   scripts/smoke-release.sh          # build Release for the sim, launch, assert it stays up
#
# The reason this exists: everything else we verify runs Debug on the simulator,
# but the App Store artifact is a *Release* build, and code that is compiled out
# of Debug (anything behind `#if !DEBUG`) only runs there. That gap once shipped a
# build that crashed on launch — the RevenueCat SDK deliberately `fatalError`s
# when configured with a Test Store key in a Release build. A Debug run can never
# catch it; a Release run catches it in about a minute.
#
# So this builds the Release configuration, installs it on a simulator, launches
# it, and — the whole point — checks that the process is *still alive* a few
# seconds later by looking it up in `launchctl list`. `simctl launch` returns
# success for a process that dies a second afterwards, so its exit code proves
# nothing on its own.
#
# Exits non-zero, loudly, if the app is gone after launch. `release.sh` runs this
# before any upload, so a launch crash aborts the release instead of shipping.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The Xcode project is generated, so its name comes from project.yml — the same
# way release.sh resolves it.
XCODE_PROJECT_NAME="$(awk '/^name:/ {print $2; exit}' "$REPO_ROOT/project.yml")"
XCODE_PROJECT="$REPO_ROOT/$XCODE_PROJECT_NAME.xcodeproj"
SCHEME="${ASC_SCHEME:-$XCODE_PROJECT_NAME}"
BUNDLE_ID="${ASC_BUNDLE_ID:-com.honmaru.ai}"

# How long to wait after launch before checking the process is still alive. The
# RevenueCat crash fires from inside a Task after presenting an alert, so the
# process lingers for a beat before dying — a too-short window sees it "running".
SETTLE_SECONDS="${SMOKE_SETTLE_SECONDS:-12}"
# Which simulator to build/run on. Default to a stable, widely-installed device;
# override with SMOKE_SIMULATOR if that runtime isn't installed.
SIMULATOR_NAME="${SMOKE_SIMULATOR:-iPhone 16 Pro}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mx  %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓  %s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"; }

need_cmd xcodegen "Install it with: brew install xcodegen"
need_cmd xcodebuild "Install Xcode from the App Store"
need_cmd xcrun "Install Xcode from the App Store"

# --------------------------------------------------------------- simulator ----

# The udid of a booted simulator, or empty if none is running.
booted_udid() {
  xcrun simctl list devices booted 2>/dev/null \
    | grep -Eo '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
    | head -n1
}

# The udid of an available (not unavailable) device matching SIMULATOR_NAME.
device_udid_for_name() {
  xcrun simctl list devices available 2>/dev/null \
    | grep -F "$SIMULATOR_NAME (" \
    | grep -Eo '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
    | head -n1
}

# Returns ONLY the udid on stdout. Diagnostics go to stderr, so the caller's
# command substitution captures the udid and nothing else — mixing a log line
# into stdout here silently corrupts the -destination id and the build fails with
# a confusing "no device matched".
ensure_booted_simulator() {
  local udid
  udid="$(booted_udid)"
  if [ -n "$udid" ]; then
    info "using already-booted simulator $udid" >&2
    printf '%s' "$udid"
    return 0
  fi

  udid="$(device_udid_for_name)"
  [ -n "$udid" ] || die "no simulator named '$SIMULATOR_NAME' is available. List them with: xcrun simctl list devices available — then set SMOKE_SIMULATOR."

  info "booting simulator '$SIMULATOR_NAME' ($udid)" >&2
  xcrun simctl boot "$udid" 2>/dev/null || true
  # bootstatus blocks until the device is fully booted, so the install/launch
  # below don't race a half-booted device.
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true
  printf '%s' "$udid"
}

# ------------------------------------------------------------------- build ----

UDID="$(ensure_booted_simulator)"

step "Building $SCHEME (Release, simulator, unsigned)"
xcodegen generate --spec "$REPO_ROOT/project.yml" >/dev/null
# CODE_SIGNING_ALLOWED=NO: a simulator build needs no signing, and requiring it
# would make this gate depend on a provisioning profile it has no reason to.
xcodebuild build \
  -project "$XCODE_PROJECT" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "id=$UDID" \
  CODE_SIGNING_ALLOWED=NO \
  | tail -n 3

# Resolve the built .app from build settings rather than guessing the DerivedData
# path, so this keeps working wherever Xcode puts it.
step "Locating the built app"
BUILD_SETTINGS="$(xcodebuild -showBuildSettings \
  -project "$XCODE_PROJECT" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "id=$UDID" \
  CODE_SIGNING_ALLOWED=NO 2>/dev/null)"
APP_DIR="$(printf '%s\n' "$BUILD_SETTINGS" | awk -F' = ' '/ TARGET_BUILD_DIR = /{print $2; exit}')"
APP_NAME="$(printf '%s\n' "$BUILD_SETTINGS" | awk -F' = ' '/ WRAPPER_NAME = /{print $2; exit}')"
APP_PATH="$APP_DIR/$APP_NAME"
[ -d "$APP_PATH" ] || die "built app not found at $APP_PATH — the Release build did not produce a .app"
info "$APP_PATH"

# ------------------------------------------------------------- launch test ----

step "Installing and launching on the simulator"
# Terminate any prior instance and reinstall clean, so a process left running by
# an earlier run cannot mask a crash, and a restored session / stale keychain
# cannot change what this launch does.
xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP_PATH"

# `simctl launch` exits 0 even for a process that crashes a second later, so its
# exit code proves nothing. Capture the launched PID and check *that* pid stays
# alive — a stale launchd record for the bundle id could otherwise read as "up".
LAUNCH_OUT="$(xcrun simctl launch "$UDID" "$BUNDLE_ID" 2>/dev/null || true)"
LAUNCHED_PID="$(printf '%s' "$LAUNCH_OUT" | grep -Eo '[0-9]+' | tail -n1)"
info "launched pid ${LAUNCHED_PID:-unknown}"

# Is the app still alive? True only if launchd still lists the bundle id AND, when
# we know the launched pid, that exact pid is still present.
is_alive() {
  local listing
  listing="$(xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep "$BUNDLE_ID" || true)"
  [ -n "$listing" ] || return 1
  if [ -n "$LAUNCHED_PID" ]; then
    printf '%s' "$listing" | awk '{print $1}' | grep -qx "$LAUNCHED_PID" || return 1
  fi
  return 0
}

# Poll across the whole settle window rather than checking once at the end. The
# RevenueCat crash fires from a Task after presenting an alert, so a warm launch
# can linger a few seconds before dying — a single end-of-window check raced that
# once and passed a crashing build. If it dies at ANY point after a short grace,
# fail. Only a process alive for the entire window passes.
step "Watching the process for ${SETTLE_SECONDS}s"
GRACE=2  # let launchd register the pid before the first check
sleep "$GRACE"
elapsed="$GRACE"
while [ "$elapsed" -lt "$SETTLE_SECONDS" ]; do
  if ! is_alive; then
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

# Second, complementary check: scan the launch-window log for a fatal signature.
# Liveness alone is not enough for every crash — the RevenueCat "Test Store key in
# Release" crash (the one that shipped as build 30) fires from a Task *after*
# presenting an alert, so headless in a simulator the alert can stall and the
# process lingers past the window even though it is fatally broken and WILL crash
# on a device. Catching the log signature makes that specific, high-stakes case
# deterministic here rather than relying on process death that only reproduces on
# device. `Fatal error:` covers any Swift trap on the launch path generally.
WINDOW_LOG="$(xcrun simctl spawn "$UDID" log show --last "$((SETTLE_SECONDS + 5))s" \
  --predicate "processImagePath CONTAINS \"$XCODE_PROJECT_NAME\"" 2>/dev/null || true)"
FATAL_SIGNATURE="$(printf '%s\n' "$WINDOW_LOG" \
  | grep -iE "Test Store API key used in Release build|Fatal error:" | head -n1 || true)"

if is_alive && [ -z "$FATAL_SIGNATURE" ]; then
  ok "still running after ${SETTLE_SECONDS}s, no fatal in the log — Release build launches cleanly"
  exit 0
fi

# Failure. Say which check caught it, then surface the cause from the log.
if [ -n "$FATAL_SIGNATURE" ]; then
  warn "$BUNDLE_ID logged a fatal error on launch (it crashes on a real device even if the simulator process lingered):"
  warn "  $FATAL_SIGNATURE"
else
  warn "$BUNDLE_ID (pid ${LAUNCHED_PID:-?}) died within ${SETTLE_SECONDS}s of launch — the Release build crashed on launch."
fi
printf '\n' >&2
warn "Recent log lines for the process:"
printf '%s\n' "$WINDOW_LOG" \
  | grep -iE "error|fatal|crash|exception|Test Store|Release build" \
  | tail -n 15 >&2 || true
printf '\n' >&2
die "Release smoke launch FAILED. Do not ship this build. Reproduce with: xcrun simctl launch --console-pty $UDID $BUNDLE_ID"
