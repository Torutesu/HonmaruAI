#!/usr/bin/env bash
#
# App Store Connect release pipeline for TikTok for Work.
#
# Wraps the `asc` CLI (https://github.com/rorkai/App-Store-Connect-CLI) plus
# xcodegen/xcodebuild so a release is one command instead of a browser session.
#
#   scripts/release.sh doctor                 # verify auth, signing, review readiness
#   scripts/release.sh build 1.2.3            # xcodegen -> archive -> export ipa
#   scripts/release.sh upload                 # upload the exported ipa
#   scripts/release.sh testflight             # upload + hand to a tester group
#   scripts/release.sh metadata 1.2.3         # push ./metadata (dry-run first)
#   scripts/release.sh submit 1.2.3           # validate -> submit for review
#   scripts/release.sh status                 # where is the current version
#   scripts/release.sh all 1.2.3              # build -> upload -> metadata -> submit
#
# Every mutating step prints what it is about to do and asks for confirmation
# unless --yes is passed. Pass --dry-run to see the commands without running them.
#
# The asc CLI's own help is the source of truth for flags: `asc <command> --help`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/build"
ARCHIVE_PATH="$BUILD_DIR/TikTokForWork.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
EXPORT_OPTIONS="$BUILD_DIR/ExportOptions.plist"

DRY_RUN=0
ASSUME_YES=0

# ---------------------------------------------------------------- output ----

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mx  %s\033[0m\n' "$*" >&2; exit 1; }

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Print a command, then run it (or skip it under --dry-run).
run() {
  printf '\033[2m   $ %s\033[0m\n' "$*"
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  "$@"
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 0
  local reply
  printf '\033[1m?  %s [y/N] \033[0m' "$1"
  read -r reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) die "aborted" ;;
  esac
}

# ------------------------------------------------------------------ setup ----

load_env() {
  if [ -f "$REPO_ROOT/.asc.env" ]; then
    # shellcheck disable=SC1091
    set -a; . "$REPO_ROOT/.asc.env"; set +a
  elif [ "$SUBCOMMAND" != "help" ]; then
    warn ".asc.env not found — copy .asc.env.example and fill it in"
  fi

  ASC_SCHEME="${ASC_SCHEME:-TikTokForWork}"
  ASC_LOCALE="${ASC_LOCALE:-en-US}"
  ASC_BUNDLE_ID="${ASC_BUNDLE_ID:-com.tangle.tiktokforwork}"
  ASC_PROFILE="${ASC_PROFILE:-TikTokForWork}"
  # asc reads these for non-interactive auth in CI.
  export ASC_KEY_ID ASC_ISSUER_ID ASC_PRIVATE_KEY
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"
}

require_asc() {
  need_cmd asc "Install it with: brew install asc"
}

require_app_id() {
  [ -n "${ASC_APP_ID:-}" ] || die "ASC_APP_ID is not set in .asc.env. Find it with: asc apps list --output table"
}

require_version() {
  [ -n "${1:-}" ] || die "this command needs a marketing version, e.g. scripts/release.sh $SUBCOMMAND 1.2.3"
}

# ------------------------------------------------------------------ steps ----

cmd_login() {
  require_asc
  [ -n "${ASC_KEY_ID:-}" ]      || die "ASC_KEY_ID is not set in .asc.env"
  [ -n "${ASC_ISSUER_ID:-}" ]   || die "ASC_ISSUER_ID is not set in .asc.env"
  [ -n "${ASC_PRIVATE_KEY:-}" ] || die "ASC_PRIVATE_KEY is not set in .asc.env"
  [ -f "${ASC_PRIVATE_KEY}" ]   || die "private key not found at $ASC_PRIVATE_KEY"

  step "Storing App Store Connect credentials as profile '$ASC_PROFILE'"
  # --network validates the key against the API before saving it.
  # In CI, add --bypass-keychain (no keychain to unlock on a runner).
  local extra=(--network)
  [ "${CI:-}" = "true" ] && extra=(--bypass-keychain)
  run asc auth login \
    --name "$ASC_PROFILE" \
    --key-id "$ASC_KEY_ID" \
    --issuer-id "$ASC_ISSUER_ID" \
    --private-key "$ASC_PRIVATE_KEY" \
    "${extra[@]}"
}

cmd_doctor() {
  require_asc

  step "Credentials"
  run asc auth status --validate || warn "not authenticated — run: scripts/release.sh login"
  run asc auth doctor || true

  if [ -n "${ASC_APP_ID:-}" ]; then
    step "App"
    run asc apps info view --app "$ASC_APP_ID" --output table || true

    step "Review readiness"
    # review doctor flags the things that reject a submission before you submit:
    # missing screenshots, empty release notes, unanswered export compliance, etc.
    run asc review doctor --app "$ASC_APP_ID" || true

    step "Latest builds"
    run asc builds list --app "$ASC_APP_ID" --output table || true
  else
    warn "ASC_APP_ID unset — skipping app checks. List your apps with: asc apps list --output table"
  fi

  step "Local toolchain"
  command -v xcodegen >/dev/null 2>&1 && info "xcodegen ok" || warn "xcodegen missing (brew install xcodegen)"
  command -v xcodebuild >/dev/null 2>&1 && info "xcodebuild ok" || warn "xcodebuild missing (install Xcode)"
  [ -n "${DEVELOPMENT_TEAM:-}" ] && info "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM" || warn "DEVELOPMENT_TEAM unset — archiving will fail to sign"
}

# Ask App Store Connect for the next unused build number so we never collide
# with an already-uploaded build.
next_build_number() {
  local out
  if out="$(asc builds next-build-number --app "$ASC_APP_ID" --output json 2>/dev/null)"; then
    # Tolerant parse: the field name is whatever the CLI emits, take the first integer.
    local n
    n="$(printf '%s' "$out" | grep -Eo '[0-9]+' | head -n1 || true)"
    [ -n "$n" ] && { printf '%s' "$n"; return 0; }
  fi
  # Fall back to a timestamp — always monotonic, always accepted by Apple.
  date +%Y%m%d%H%M
}

cmd_build() {
  local version="$1"
  require_version "$version"
  need_cmd xcodegen "brew install xcodegen"
  need_cmd xcodebuild "Install Xcode from the App Store"
  [ -n "${DEVELOPMENT_TEAM:-}" ] || die "DEVELOPMENT_TEAM is not set in .asc.env — xcodebuild cannot sign the archive"

  local build_number
  if [ -n "${ASC_APP_ID:-}" ] && command -v asc >/dev/null 2>&1; then
    build_number="$(next_build_number)"
  else
    build_number="$(date +%Y%m%d%H%M)"
  fi
  info "version $version, build $build_number"

  step "Regenerating the Xcode project"
  run xcodegen generate --spec "$REPO_ROOT/project.yml"

  step "Archiving"
  mkdir -p "$BUILD_DIR"
  # Version and build number are passed on the command line rather than written
  # into project.yml, so a release never leaves the repo dirty.
  run xcodebuild archive \
    -project "$REPO_ROOT/TikTokForWork.xcodeproj" \
    -scheme "$ASC_SCHEME" \
    -configuration Release \
    -destination "generic/platform=iOS" \
    -archivePath "$ARCHIVE_PATH" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    MARKETING_VERSION="$version" \
    CURRENT_PROJECT_VERSION="$build_number" \
    CODE_SIGN_STYLE=Automatic \
    -allowProvisioningUpdates

  step "Exporting the ipa"
  sed "s/__DEVELOPMENT_TEAM__/$DEVELOPMENT_TEAM/" \
    "$REPO_ROOT/scripts/ExportOptions.plist.template" > "$EXPORT_OPTIONS"
  run xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_OPTIONS" \
    -allowProvisioningUpdates

  local ipa
  ipa="$(find_ipa || true)"
  [ -n "$ipa" ] && bold "built $ipa (version $version, build $build_number)"
}

find_ipa() {
  find "$EXPORT_DIR" -name '*.ipa' -maxdepth 2 2>/dev/null | head -n1
}

require_ipa() {
  local ipa
  ipa="$(find_ipa || true)"
  if [ -z "$ipa" ]; then
    [ "$DRY_RUN" -eq 1 ] && { printf '%s' "$EXPORT_DIR/TikTokForWork.ipa"; return 0; }
    die "no .ipa in $EXPORT_DIR — run: scripts/release.sh build <version>"
  fi
  printf '%s' "$ipa"
}

cmd_upload() {
  require_asc; require_app_id
  local ipa; ipa="$(require_ipa)"

  step "Uploading $(basename "$ipa") to App Store Connect"
  confirm "Upload this build?"
  run asc builds upload --app "$ASC_APP_ID" --ipa "$ipa"

  step "Processing status"
  info "Apple takes a few minutes to process. Watch it with:"
  info "  asc status --app $ASC_APP_ID --watch"
}

cmd_testflight() {
  require_asc; require_app_id
  local ipa; ipa="$(require_ipa)"
  local group="${TESTFLIGHT_GROUP:-Internal Testers}"

  step "Publishing to TestFlight group '$group'"
  confirm "Push $(basename "$ipa") to TestFlight?"
  # publish testflight handles upload + processing wait + group assignment.
  run asc publish testflight \
    --app "$ASC_APP_ID" \
    --ipa "$ipa" \
    --group "$group" \
    --wait
}

cmd_metadata() {
  local version="$1"
  require_version "$version"
  require_asc; require_app_id
  local dir="$REPO_ROOT/metadata"

  if [ ! -d "$dir" ]; then
    step "Scaffolding ./metadata"
    run asc metadata init --dir "$dir" --version "$version" --locale "$ASC_LOCALE"
    info "Fill in the generated files, then re-run this command."
    return 0
  fi

  step "Previewing metadata changes (dry run)"
  run asc metadata apply --app "$ASC_APP_ID" --version "$version" --dir "$dir" --dry-run

  confirm "Apply the metadata changes shown above?"
  step "Applying metadata"
  run asc metadata apply --app "$ASC_APP_ID" --version "$version" --dir "$dir" --confirm

  if [ -d "$REPO_ROOT/screenshots" ]; then
    step "Screenshots"
    run asc screenshots plan --app "$ASC_APP_ID" --version "$version" \
      --review-output-dir "$REPO_ROOT/screenshots/review"
    confirm "Apply the screenshot plan?"
    run asc screenshots apply --app "$ASC_APP_ID" --version "$version" \
      --review-output-dir "$REPO_ROOT/screenshots/review" --confirm
  fi
}

cmd_submit() {
  local version="$1"
  require_version "$version"
  require_asc; require_app_id

  step "Pre-submission checks"
  # Both of these are read-only. Fix what they report before burning a submission.
  run asc review doctor --app "$ASC_APP_ID" || warn "review doctor reported problems (see above)"
  run asc validate --app "$ASC_APP_ID" --version "$version"

  bold ""
  bold "About to submit $ASC_BUNDLE_ID $version for App Store review."
  confirm "Submit for review?"

  step "Submitting"
  run asc publish appstore \
    --app "$ASC_APP_ID" \
    --version "$version" \
    --submit \
    --confirm

  cmd_status
}

cmd_status() {
  require_asc; require_app_id
  step "Review status"
  run asc review status --app "$ASC_APP_ID"
  step "Versions"
  run asc versions list --app "$ASC_APP_ID" --output table
}

cmd_all() {
  local version="$1"
  require_version "$version"
  cmd_build "$version"
  cmd_upload
  cmd_metadata "$version"
  cmd_submit "$version"
}

# Print the header comment block (everything from line 3 to the first non-comment).
usage() {
  awk 'NR>2 && /^#/ { sub(/^# ?/, ""); print; next } NR>2 { exit }' "${BASH_SOURCE[0]}"
}

# ------------------------------------------------------------------- main ----

SUBCOMMAND="${1:-help}"
[ $# -gt 0 ] && shift

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    -*)        die "unknown option: $arg" ;;
    *)         ARGS+=("$arg") ;;
  esac
done

load_env
[ "$DRY_RUN" -eq 1 ] && warn "dry run — no commands will be executed"

case "$SUBCOMMAND" in
  login)      cmd_login ;;
  doctor)     cmd_doctor ;;
  build)      cmd_build "${ARGS[0]:-}" ;;
  upload)     cmd_upload ;;
  testflight) cmd_testflight ;;
  metadata)   cmd_metadata "${ARGS[0]:-}" ;;
  submit)     cmd_submit "${ARGS[0]:-}" ;;
  status)     cmd_status ;;
  all)        cmd_all "${ARGS[0]:-}" ;;
  help|--help|-h) usage ;;
  *)          usage; die "unknown command: $SUBCOMMAND" ;;
esac
