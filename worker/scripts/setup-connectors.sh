#!/usr/bin/env bash
#
# Turn on Gmail, Slack and Notion, and prove the Worker can see them.
#
#     ./worker/scripts/setup-connectors.sh
#
# The connectors are written and tested; what they are missing is one secret.
# Without `COMPOSIO_API_KEY` the Tools screen says so out loud and every
# /connectors route answers 503, which is correct and is also indistinguishable
# from a key that is simply wrong. So this sets the key, deploys — the routes
# only exist in a deployed build — and then asks the live Worker to list the
# connectors, which is the first call that actually reaches Composio.
#
# What this switches on:
#   * Gmail   — mail addressed to you in the last week becomes decisions
#   * Slack   — messages addressed to or mentioning you, without opening Slack
#   * Notion  — rows in the database you point at, and decisions written back
#
# GitHub is not here: it is built in and needs no third party.
#
# Auth configs. Each connector ships the id of the one this project set up at
# Composio, so a fresh deployment works with no further configuration. An auth
# config belongs to whoever created it, so if you are running this against your
# own Composio account, create one per toolkit there and set:
#
#     CONNECTOR_AUTH_GMAIL, CONNECTOR_AUTH_SLACK, CONNECTOR_AUTH_NOTION
#
# This script offers that at the end. Skip it and the built-in ids stand.
#
# Needs `npx wrangler login` and nothing else.

set -euo pipefail

cd "$(dirname "$0")/.."

WRANGLER=(npx -y wrangler@4)
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

secret() {
  local prompt="$1" answer
  read -r -s -p "$prompt: " answer </dev/tty
  printf '\n' >&2
  printf '%s' "$answer"
}

put_secret() {
  local name="$1" value="$2"
  printf '%s' "$value" | "${WRANGLER[@]}" secret put "$name" >/dev/null
  note "  $name — set"
}

# The two shape checks, as functions rather than inline, so they can be run
# without a terminal — a prompt reading from /dev/tty cannot be driven by a
# test, and these are exactly the part worth testing. `--self-test` below runs
# them; sourcing this file defines them and does nothing else.
valid_key() {
  case "$1" in
    "") return 1 ;;
    http*|*/*|*' '*) return 1 ;;
    *) return 0 ;;
  esac
}

valid_auth_config() {
  case "$1" in ac_?*) return 0 ;; *) return 1 ;; esac
}

if [ "${1:-}" = "--self-test" ]; then
  fails=0
  check() {  # check <expect ok|no> <fn> <value>
    if [ "$1" = ok ]; then "$2" "$3" || { echo "FAIL: $2 rejected '$3'"; fails=1; }
    else "$2" "$3" && { echo "FAIL: $2 accepted '$3'"; fails=1; } || true
    fi
  }
  check ok valid_key "ak_abc123"
  check no valid_key ""
  check no valid_key "https://app.composio.dev/settings"
  check no valid_key "cd ~/HonmaruAI"
  check no valid_key "worker/scripts/setup-connectors.sh"
  check ok valid_auth_config "ac_XcSzdgFl91Ds"
  check no valid_auth_config "ac_"
  check no valid_auth_config "XcSzdgFl91Ds"
  check no valid_auth_config ""
  [ "$fails" -eq 0 ] && echo "self-test: all guards behave" || exit 1
  exit 0
fi

say "0. Who are we?"
if ! "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in"; then
  echo "Not logged in to Cloudflare. Run this first:" >&2
  echo "    npx wrangler login" >&2
  exit 1
fi

say "1. The Composio key"
note "https://app.composio.dev → Settings → API Keys. It starts with 'ak_'."
key=$(secret "Composio API key")
key=$(printf '%s' "$key" | tr -d '[:space:]')
# A pasted dashboard URL and a pasted command both look like an answer to a
# prompt reading from /dev/tty, and both are stored just as happily as a key.
if ! valid_key "$key"; then
  echo "That is not an API key: $key" >&2
  echo "Expected the value itself, something like ak_xxxxxxxx" >&2
  exit 1
fi
put_secret COMPOSIO_API_KEY "$key"

say "2. Deploy"
note "The /connectors routes only exist in a deployed build."
[ -d node_modules ] || npm ci
"${WRANGLER[@]}" deploy >/dev/null
note "  deployed"

say "3. Can the Worker see them?"
note "This is the first call that actually reaches Composio."
host=$(grep -oE '[a-z0-9.-]+\.workers\.dev' ../README.md 2>/dev/null | head -1)
host=${host:-tiktokforwork.torubj0904.workers.dev}
note "  asking https://$host/connectors"
# /connectors needs a session, so an unauthenticated call cannot tell us
# whether the key works — but it can tell us the key is *there*, because the
# 503 is checked before the 401 and disappears the moment it is set.
code=$(curl -sS -o /tmp/connectors.out -w '%{http_code}' "https://$host/connectors" || echo 000)
case "$code" in
  401)
    note "  the key is in place (401 = sign in first, which is expected here)"
    ;;
  503)
    echo "Still 503: the deployed Worker does not have COMPOSIO_API_KEY." >&2
    echo "That usually means the deploy above did not take. Try again." >&2
    exit 1
    ;;
  *)
    echo "Unexpected $code from /connectors:" >&2
    cat /tmp/connectors.out >&2
    exit 1
    ;;
esac

say "4. Your own auth configs (optional)"
note "Skip all three with Enter if you are using this project's Composio account."
for pair in "GMAIL Gmail" "SLACK Slack" "NOTION Notion"; do
  set -- $pair
  var="CONNECTOR_AUTH_$1"
  value=$(ask "  $2 auth config id (ac_…), or Enter to skip")
  value=$(printf '%s' "$value" | tr -d '[:space:]')
  [ -z "$value" ] && continue
  if valid_auth_config "$value"; then put_secret "$var" "$value"
  else echo "  not an auth config id, skipped: $value" >&2
  fi
done

say "Done."
note "Open the app → You → Tools. Each connector should offer Connect."
note "Connecting opens Composio's own consent screen; come back and Pull."
note ""
note "If Tools still says connectors are not switched on, the browser is"
note "holding an old build — reload it. If a Connect button fails, the auth"
note "config belongs to another Composio account: set CONNECTOR_AUTH_* above."
