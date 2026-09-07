#!/usr/bin/env bash
#
# Put the web client on Cloudflare Pages.
#
#     ./web-react/scripts/deploy-pages.sh
#
# The backend host is baked in at build time. There is no field on the sign-in
# screen to correct it afterwards, so a build that forgot it is a page that
# quietly tries to reach localhost and never connects. That is the one thing
# this script exists to get right.
#
# It ends by offering to set APP_WEB_URL on the Worker, which is where a
# notification tap and an email link open. Without it they open nothing.

set -euo pipefail

cd "$(dirname "$0")/.."

WRANGLER=(npx -y wrangler@4)
PROJECT="${PAGES_PROJECT:-honmaru-web}"
BOLD=$(tput bold 2>/dev/null || true)
DIM=$(tput dim 2>/dev/null || true)
OFF=$(tput sgr0 2>/dev/null || true)

say() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
note() { printf '%s%s%s\n' "$DIM" "$1" "$OFF"; }
ask() {
  local prompt="$1" default="${2:-}" answer
  read -r -p "$prompt${default:+ [$default]}: " answer </dev/tty
  printf '%s' "${answer:-$default}"
}

say "0. Who are we?"
if ! "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in"; then
  echo "Not logged in to Cloudflare. Run this first:" >&2
  echo "    npx wrangler login" >&2
  exit 1
fi

say "1. Which backend?"
note "Baked into the build. The page has no field to change it later."
default_host=$(sed -n 's/^VITE_API_HOST=//p' .env.example 2>/dev/null | head -1)
host=$(ask 'Worker host, no scheme' "${default_host:-tiktokforwork.torubj0904.workers.dev}")
[ -n "$host" ] || { echo "A host is required." >&2; exit 1; }

say "2. Build"
[ -d node_modules ] || npm ci
VITE_API_HOST="$host" npm run build
# public/ is copied verbatim, and the service worker has to sit at the root of
# the site or the browser will not let it control the page.
[ -f dist/sw.js ] || { echo "dist/sw.js is missing; push would not work." >&2; exit 1; }
grep -q "$host" dist/assets/*.js || { echo "The host did not make it into the build." >&2; exit 1; }
note "  $host is in the bundle, and dist/sw.js is there."

say "3. Deploy"
if ! "${WRANGLER[@]}" pages project list 2>/dev/null | grep -qw "$PROJECT"; then
  note "  creating the project $PROJECT"
  "${WRANGLER[@]}" pages project create "$PROJECT" --production-branch=main
fi
"${WRANGLER[@]}" pages deploy dist --project-name="$PROJECT" --branch=main --commit-dirty=true

url="https://$PROJECT.pages.dev"
say "4. Tell the Worker where that is"
note "Where a notification tap and an email link open."
if [ "$(ask "Set APP_WEB_URL to $url? (Y/n)" 'Y')" != "n" ]; then
  if printf '%s' "$url" | (cd ../worker && "${WRANGLER[@]}" secret put APP_WEB_URL >/tmp/app-web-url.log 2>&1); then
    echo "  APP_WEB_URL — set"
  else
    cat /tmp/app-web-url.log >&2
    echo "  APP_WEB_URL — FAILED. Set it by hand:" >&2
    echo "      cd worker && npx -y wrangler@4 secret put APP_WEB_URL" >&2
  fi
fi

say "Done."
echo "  $url"
note "Open it, sign in, and press the bell in the top bar to turn on notifications."
note "On an iPhone, add it to the home screen first — Safari only allows push there."
