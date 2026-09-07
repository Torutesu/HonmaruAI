#!/usr/bin/env bash
#
# Turn on the email door, and prove it opened.
#
#     ./worker/scripts/setup-email.sh
#
# Two secrets, a deploy, and a real round trip. It exists because setting the
# secrets is the easy half: a wrong key, an unverified domain or a sandbox
# that has not authorized the recipient all look identical from the outside —
# nothing arrives — and the person who notices is whoever was waiting for a
# code that never came.
#
# So the last step actually asks the live Worker for a code and reports what
# Mailgun said. A 502 here is a Mailgun problem you can fix in a minute; the
# same problem found later is someone locked out of the product.
#
# What this switches on:
#   * signing in with a six-digit code (POST /auth/otp/request, /verify) —
#     the only way in for anyone who does not have GitHub
#   * email as the notification floor, when no push channel reaches someone
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

ask_secret() {
  local prompt="$1" answer
  read -r -s -p "$prompt: " answer </dev/tty
  printf '\n' >&2
  printf '%s' "$answer"
}

say "0. Who are we?"
if ! "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in"; then
  echo "Not logged in to Cloudflare. Run this first:" >&2
  echo "    npx wrangler login" >&2
  exit 1
fi
"${WRANGLER[@]}" whoami 2>/dev/null | grep -iE "account name|account id" || true

say "1. Mailgun"
note "Sending domain from Mailgun → Sending → Domains. A sandbox domain works"
note "for testing, but only to recipients you have authorized there."
domain=$(ask 'Mailgun sending domain (e.g. mg.example.com)' '')
case "$domain" in
  "") echo "Nothing to do without a domain." >&2; exit 1 ;;
  # Anything else becomes part of a URL the Worker posts to on every send.
  *[!A-Za-z0-9.-]*) echo "That is not a domain. Nothing was set." >&2; exit 1 ;;
esac

note "Private API key from Mailgun → Send → API keys. Starts 'key-' on older"
note "accounts; newer ones are a plain string. It is not the public key."
api_key=$(ask_secret 'Mailgun private API key')
[ -n "$api_key" ] || { echo "No key given. Nothing was set." >&2; exit 1; }

from=$(ask 'From line' "Honmaru AI <no-reply@$domain>")
base=$(ask 'API base (blank for US, https://api.eu.mailgun.net for EU)' '')

printf '%s' "$domain"  | "${WRANGLER[@]}" secret put MAILGUN_DOMAIN   >/dev/null 2>&1 && echo "  MAILGUN_DOMAIN — set"
printf '%s' "$api_key" | "${WRANGLER[@]}" secret put MAILGUN_API_KEY  >/dev/null 2>&1 && echo "  MAILGUN_API_KEY — set"
printf '%s' "$from"    | "${WRANGLER[@]}" secret put NOTIFY_EMAIL_FROM >/dev/null 2>&1 && echo "  NOTIFY_EMAIL_FROM — set"
if [ -n "$base" ]; then
  printf '%s' "$base" | "${WRANGLER[@]}" secret put MAILGUN_API_BASE >/dev/null 2>&1 && echo "  MAILGUN_API_BASE — set"
fi
unset api_key

say "2. Deploy"
note "Secrets take effect immediately, but the sign-in code endpoints and the"
note "table they store codes in only exist in a deployed build. Migration first."
./scripts/deploy-local.sh

host=$(grep -oE '[a-z0-9.-]+\.workers\.dev' ../README.md | head -1)
host=${host:-tiktokforwork.torubj0904.workers.dev}

say "3. Is the door open?"
health=$(curl -fsS "https://$host/health" || true)
printf '%s\n' "$health" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$health"
case "$health" in
  *'"email": true'*|*'"email":true'*) note "  email: true — the Worker has credentials." ;;
  *) echo "  email is still false. The secrets did not reach this Worker." >&2; exit 1 ;;
esac

say "4. Does a code actually arrive?"
note "This sends a real email. On a sandbox domain, use an address you have"
note "authorized in Mailgun — anything else is refused by them, not by us."
to=$(ask 'Send a test sign-in code to' '')
if [ -z "$to" ]; then
  note "  skipped — but nothing has proved mail leaves the building yet."
  exit 0
fi

body=$(curl -sS -X POST "https://$host/auth/otp/request" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$to\"}" \
  -w '\n%{http_code}')
code=$(printf '%s' "$body" | tail -n1)
payload=$(printf '%s' "$body" | sed '$d')

case "$code" in
  200)
    say "It works."
    note "A six-digit code is on its way to $to. It is good for ten minutes,"
    note "once. Sign in with it at the web client or in the app."
    ;;
  429)
    note "  A code was sent to this address in the last minute already — which"
    note "  also means the send path works. $payload"
    ;;
  502)
    echo "Mailgun refused the send. The secrets are set but wrong, or the" >&2
    echo "domain is not verified, or the recipient is not authorized on a" >&2
    echo "sandbox domain. Mailgun → Sending → Logs says which." >&2
    echo "$payload" >&2
    exit 1
    ;;
  503)
    echo "The Worker says email is not configured, which contradicts /health." >&2
    echo "Give it a moment and run this again." >&2
    exit 1
    ;;
  404)
    # The deploy is what puts these routes on the Worker. A 404 here means the
    # running build predates them, which is worth naming precisely: the same
    # answer from a browser looks like a typo in the URL.
    echo "This Worker has no sign-in code endpoint, so it is running a build" >&2
    echo "from before they existed. The deploy above did not take — run" >&2
    echo "./scripts/deploy-local.sh on its own and read what it says." >&2
    exit 1
    ;;
  *)
    echo "Unexpected answer ($code): $payload" >&2
    exit 1
    ;;
esac
