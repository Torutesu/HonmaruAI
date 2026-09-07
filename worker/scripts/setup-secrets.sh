#!/usr/bin/env bash
#
# Every secret the Worker needs, asked for once and put straight into
# Cloudflare. Run it from anywhere:
#
#     ./worker/scripts/setup-secrets.sh
#
# The VAPID pair is generated here and piped into `wrangler secret put` without
# ever being printed, so the private key does not land in your terminal
# scrollback, your shell history, or a file. Anything you leave blank is
# skipped, so this is also the way to set one more secret later.
#
# What it does NOT do: the two GitHub repository secrets that let the deploy
# workflow run (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID). Those live on
# GitHub, not Cloudflare — docs/setup-secrets.md, step 1.

set -euo pipefail

cd "$(dirname "$0")/.."

WRANGLER=(npx -y wrangler@4)
BOLD=$(tput bold 2>/dev/null || true)
DIM=$(tput dim 2>/dev/null || true)
OFF=$(tput sgr0 2>/dev/null || true)

say() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
note() { printf '%s%s%s\n' "$DIM" "$1" "$OFF"; }

# A value nobody typed is a secret nobody is changing. Blank means skip, which
# is what makes this safe to re-run when only one thing needs setting.
put() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    note "  $name — skipped"
    return
  fi
  printf '%s' "$value" | "${WRANGLER[@]}" secret put "$name" >/dev/null 2>&1
  printf '  %s — set\n' "$name"
}

ask() {  # visible: hostnames and addresses are not secrets
  local prompt="$1" default="${2:-}" answer
  read -r -p "$prompt${default:+ [$default]}: " answer </dev/tty
  printf '%s' "${answer:-$default}"
}

ask_secret() {  # hidden: keys
  local prompt="$1" answer
  read -r -s -p "$prompt: " answer </dev/tty
  printf '\n' >&2
  printf '%s' "$answer"
}

say "Who are we?"
if ! "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in"; then
  echo "Not logged in to Cloudflare. Run:  npx wrangler login" >&2
  exit 1
fi
"${WRANGLER[@]}" whoami 2>/dev/null | grep -iE "account name|account id" || true

say "1. Web Push (VAPID)"
note "A fresh key pair invalidates every existing browser subscription."
if [ "$(ask 'Generate and set a VAPID key pair? (y/N)' 'N')" = "y" ]; then
  # Captured into variables, never echoed. The subject is the contact a push
  # service uses when our notifications misbehave; it has to be a real mailto:
  # or https: URL.
  keys=$(node scripts/vapid-keys.mjs)
  public=$(printf '%s\n' "$keys" | sed -n 's/^VAPID_PUBLIC_KEY=//p')
  private=$(printf '%s\n' "$keys" | sed -n 's/^VAPID_PRIVATE_KEY=//p')
  subject=$(ask 'Contact URL for push services' 'mailto:you@example.com')
  # RFC 8292 wants a URI. An address typed bare is the common answer, and every
  # push service rejects the token for it, so complete it rather than send it.
  case "$subject" in
    mailto:*|https:*) ;;
    *@*) subject="mailto:$subject" ;;
  esac
  put VAPID_PUBLIC_KEY "$public"
  put VAPID_PRIVATE_KEY "$private"
  put VAPID_SUBJECT "$subject"
  unset keys public private
else
  note "  skipped"
fi

say "2. Email (Mailgun)"
note "The floor: only used when no push reached the person. Blank to skip."
mg_domain=$(ask 'Mailgun sending domain (e.g. mg.example.com)' '')
if [ -n "$mg_domain" ]; then
  mg_key=$(ask_secret 'Mailgun private API key')
  mg_from=$(ask 'From line' "Honmaru AI <no-reply@$mg_domain>")
  mg_base=$(ask 'API base (blank for US, https://api.eu.mailgun.net for EU)' '')
  put MAILGUN_DOMAIN "$mg_domain"
  put MAILGUN_API_KEY "$mg_key"
  put NOTIFY_EMAIL_FROM "$mg_from"
  put MAILGUN_API_BASE "$mg_base"
  unset mg_key
else
  note "  skipped"
fi

say "3. Where the web client lives"
note "Where a notification tap and an email link open. Blank to skip."
put APP_WEB_URL "$(ask 'Web client URL (e.g. https://honmaru-web.pages.dev)' '')"

say "4. What is live now"
host=$(ask 'Worker host' 'tiktokforwork.torubj0904.workers.dev')
# Secrets take effect on the running Worker immediately; no redeploy needed.
curl -fsS "https://$host/health" | python3 -m json.tool 2>/dev/null \
  || curl -fsS "https://$host/health" \
  || echo "Could not reach https://$host/health"

say "Done."
note "webPush and email true means those channels are on."
note "push is Apple's APNs and needs the App ID work in docs/push-notifications.md."
