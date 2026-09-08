#!/usr/bin/env bash
#
# Turn on the email door, and prove it opened.
#
#     ./worker/scripts/setup-email.sh
#
# One secret, a deploy, and a real round trip. It exists because setting the
# secret is the easy half: a wrong key, an unverified From domain and a
# recipient the shared sender may not reach all look identical from outside —
# nothing arrives — and the person who notices is otherwise whoever was
# waiting for a code that never came.
#
# So the last step actually asks the live Worker for a code and reports what
# Resend said. A refusal here is a minute's fix; the same refusal found later
# is someone locked out of the product.
#
# What this switches on:
#   * signing in with a six-digit code (POST /auth/otp/request, /verify) —
#     the only way in for anyone who does not have GitHub
#   * email as the notification floor, when no push channel reaches someone
#
# One API key from Resend, and nothing else: no domain, no DNS records, and a
# free tier that is a free tier rather than a trial — which is the right shape
# for a channel that is a fallback and a sign-in code rather than the product.
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

# A key is read with the echo off, so nothing appears as it is typed or
# pasted. That silence reads as a dead prompt: someone presses Enter to see
# whether it is alive, gets "No key given", and then pastes the key into the
# shell — where it becomes a command, lands in ~/.zsh_history, and has to be
# rotated. Happened on a real run. So the prompt says the input is hidden,
# confirms the length once something is entered, and offers the empty answer
# again rather than treating the first one as final.
ask_secret() {
  local prompt="$1" answer
  while :; do
    printf '%s (input is hidden — paste it and press Enter): ' "$prompt" >&2
    read -r -s answer </dev/tty
    printf '\n' >&2
    if [ -n "$answer" ]; then
      printf '  got %d characters\n' "${#answer}" >&2
      break
    fi
    printf '  nothing received. Paste it again, or press Ctrl-C to stop.\n' >&2
  done
  printf '%s' "$answer"
}

say "0. Who are we?"
if ! "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in"; then
  echo "Not logged in to Cloudflare. Run this first:" >&2
  echo "    npx wrangler login" >&2
  exit 1
fi
"${WRANGLER[@]}" whoami 2>/dev/null | grep -iE "account name|account id" || true

say "1. Resend"
note "API key from https://resend.com/api-keys — it starts 're_'."
api_key=$(ask_secret 'Resend API key')
[ -n "$api_key" ] || { echo "No key given. Nothing was set." >&2; exit 1; }
# A key pasted with a stray newline or a leading space is stored verbatim and
# then rejected by Resend as if it were the wrong key.
api_key=$(printf '%s' "$api_key" | tr -d '[:space:]')
case "$api_key" in
  re_*) ;;
  *) echo "That does not look like a Resend key: expected one starting 're_'." >&2
     echo "Nothing was set." >&2; exit 1 ;;
esac

note "From line. Leave it blank to use Resend's shared sender, which needs no"
note "domain and no DNS — mail then only reaches the address that owns the"
note "Resend account, which is enough to test with. Set one only once you have"
note "verified a domain at Resend."
from=$(ask 'From line (blank for the shared sender)' '')

# Answering this prompt with your own address is the obvious thing to do and
# the one thing that cannot work: Resend sends only from a domain you have
# verified there, and nobody verifies gmail.com. It refuses with a 422 that
# reads like a problem with the API key, which is where an hour goes.
case "$from" in
  "") ;;
  *@*)
    from_domain=$(printf '%s' "$from" | sed -e 's/.*@//' -e 's/[>[:space:]].*//' | tr 'A-Z' 'a-z')
    case "$from_domain" in
      gmail.com|googlemail.com|yahoo.*|ymail.com|outlook.*|hotmail.*|live.*|msn.com|icloud.com|me.com|mac.com|aol.com|gmx.*|proton.me|protonmail.com)
        echo >&2
        echo "  $from_domain is a mailbox provider, not a domain you can verify" >&2
        echo "  at Resend — so Resend would refuse every send from it. Using the" >&2
        echo "  shared sender instead; that reaches the address your Resend" >&2
        echo "  account is registered under, which is what you want for a test." >&2
        from=""
        ;;
      *)
        note "  $from_domain must be verified at https://resend.com/domains, or"
        note "  Resend refuses the send. The test below will say if it is not."
        ;;
    esac
    ;;
  *)
    echo "  That has no address in it. Using the shared sender." >&2
    from=""
    ;;
esac

printf '%s' "$api_key" | "${WRANGLER[@]}" secret put RESEND_API_KEY >/dev/null 2>&1 && echo "  RESEND_API_KEY — set"
if [ -n "$from" ]; then
  printf '%s' "$from" | "${WRANGLER[@]}" secret put NOTIFY_EMAIL_FROM >/dev/null 2>&1 && echo "  NOTIFY_EMAIL_FROM — set"
else
  # Not deleted from here: `secret delete` wants a confirmation, and a prompt
  # answered by nobody inside a script is a script that hangs with its output
  # redirected away. Said out loud instead, because a leftover From from an
  # earlier run is exactly what broke this once.
  note "  NOTIFY_EMAIL_FROM — not set by this run. If an earlier run left one,"
  note "  it still applies; clear it with"
  note "      npx -y wrangler@4 secret delete NOTIFY_EMAIL_FROM"
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
note "Not a reserved domain: Resend refuses example.com and friends with a 422,"
note "which looks exactly like an unverified sender. Use an address you can read."
note "This sends a real email. Until you have verified a domain at Resend, use"
note "the address that owns the Resend account — anything else Resend refuses,"
note "and that refusal is theirs, not ours."
to=$(ask 'Send a test sign-in code to' '')
if [ -z "$to" ]; then
  note "  skipped — but nothing has proved mail leaves the building yet."
  exit 0
fi
# A prompt reading from /dev/tty will accept anything the clipboard had in it,
# and this value goes into a JSON body unescaped. Refuse what is not an address
# rather than send a malformed request and report the provider's confusion
# about it as if it were an answer about the setup.
#
# Surrounding whitespace is trimmed rather than refused: a trailing space off a
# paste is not a typo worth a second run of the whole script.
#
# grep with an explicit regex, and LC_ALL=C, rather than a shell bracket
# expression: `[!A-Za-z0-9._%+-@]` reads as a range from + to @ and does not
# mean the same thing in every shell and locale this runs in. The first version
# of this check refused a perfectly good address on the machine it was written
# for, which is a worse failure than the paste it was guarding against.
to=$(printf '%s' "$to" | tr -d '[:space:]')
if ! printf '%s' "$to" | LC_ALL=C grep -qE '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
  echo "That does not look like an email address: $to" >&2
  echo "Nothing was sent. Everything above is already set — run this again" >&2
  echo "to test, or send the request by hand:" >&2
  echo "    curl -sS -X POST https://$host/auth/otp/request \\" >&2
  echo "      -H 'content-type: application/json' -d '{\"email\":\"you@example.com\"}'" >&2
  exit 1
fi

# The endpoint answers the internet, so it says only that the send failed —
# naming an unverified domain to an unauthenticated caller is a detail nobody
# outside this machine needs. The reason is logged instead, and the reason is
# the whole point of this step, so listen for it here rather than send someone
# to a second terminal they will not open.
# An explicit template: `mktemp -t PREFIX` means different things on macOS and
# GNU, and the GNU one refuses a template with no X's at all.
tail_log=$(mktemp "${TMPDIR:-/tmp}/honmaru-tail.XXXXXX")
trap 'rm -f "$tail_log"' EXIT
"${WRANGLER[@]}" tail --format json >"$tail_log" 2>&1 &
tail_pid=$!
# Wait for the attach rather than guess at it. A fixed four seconds was not
# enough on a real run, and the failure mode — "the log did not reach us in
# time" — is the one message this step exists to avoid printing.
note "  attaching to the Worker's log…"
for _ in $(seq 1 30); do
  grep -q "Connected to" "$tail_log" 2>/dev/null && break
  sleep 1
done

body=$(curl -sS -X POST "https://$host/auth/otp/request" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$to\"}" \
  -w '\n%{http_code}')
code=$(printf '%s' "$body" | tail -n1)
payload=$(printf '%s' "$body" | sed '$d')

sleep 3
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true
# `|| true` on both halves, because `set -euo pipefail` is on and a grep that
# matches nothing exits 1 — which, on a success, is exactly what it does. The
# first version of this ended the script in silence at the moment it was
# supposed to say "It works."
reason=$( { grep -o 'mail refused by Resend[^"]*' "$tail_log" || true; } | head -1 || true)

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
    echo "Resend refused the send." >&2
    if [ -n "$reason" ]; then
      echo >&2
      echo "  $reason" >&2
      echo >&2
      echo "That is Resend's own wording." >&2
    else
      echo "The log did not reach us in time. Run this in one terminal:" >&2
      echo "    npx -y wrangler@4 tail --format pretty" >&2
      echo "and the curl below in another; the reason appears in the first." >&2
      echo "    curl -sS -X POST https://$host/auth/otp/request \\" >&2
      echo "      -H 'content-type: application/json' -d '{\"email\":\"$to\"}'" >&2
      echo >&2
      echo "In the meantime, from the status code:" >&2
    fi
    # The status code narrows it to one line rather than three.
    case "$payload" in
      *'"providerStatus":401'*)
        echo "  Resend said 401: the API key is wrong. Make a new one at" >&2
        echo "  https://resend.com/api-keys and run this again." >&2
        ;;
      *'"providerStatus":403'*)
        echo "  Resend said 403: the key does not have permission to send." >&2
        echo "  Check its Permission at https://resend.com/api-keys — a key" >&2
        echo "  limited to a domain cannot use the shared sender. Full access" >&2
        echo "  is the fix." >&2
        ;;
      *'"providerStatus":422'*)
        echo "  Resend said 422: it would not take the request. Almost always" >&2
        echo "  this one, and it has nothing to do with the key:" >&2
        echo >&2
        echo "    Until a domain is verified, the shared sender delivers ONLY" >&2
        echo "    to the address your Resend account is registered under." >&2
        echo "    Check it at https://resend.com/settings and send the test" >&2
        echo "    there — it is often not the address you expected, e.g. when" >&2
        echo "    the account was made by signing in with GitHub." >&2
        echo >&2
        echo "  The other 422: NOTIFY_EMAIL_FROM names a domain not verified" >&2
        echo "  at Resend. Clear it with" >&2
        echo "      npx -y wrangler@4 secret delete NOTIFY_EMAIL_FROM" >&2
        echo "  to fall back to the shared sender." >&2
        ;;
      *)
        echo "  * the API key is wrong, or is restricted to a domain" >&2
        echo "  * NOTIFY_EMAIL_FROM names a domain not verified at Resend" >&2
        echo "  * $to is not the address the Resend account is registered" >&2
        echo "    under, and the shared sender delivers only to that one" >&2
        ;;
    esac
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
