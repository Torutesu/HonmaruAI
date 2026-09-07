#!/usr/bin/env bash
#
# Deploy the Worker from this machine, in the order that matters.
#
#     ./worker/scripts/deploy-local.sh
#
# The same four steps the Deploy Worker workflow runs — test, migrate D1,
# deploy, check /health — for when that workflow cannot run because the
# repository has no CLOUDFLARE_API_TOKEN. All it needs is `wrangler login`.
#
# The migration goes first every time. That ordering is the whole reason the
# workflow exists: deploying code that reads a column D1 does not have yet
# fails every sign-in until someone notices.

set -euo pipefail

cd "$(dirname "$0")/.."

WRANGLER=(npx -y wrangler@4)
BOLD=$(tput bold 2>/dev/null || true)
DIM=$(tput dim 2>/dev/null || true)
OFF=$(tput sgr0 2>/dev/null || true)

say() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
note() { printf '%s%s%s\n' "$DIM" "$1" "$OFF"; }

say "0. Who are we?"
if ! "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in"; then
  echo "Not logged in to Cloudflare. Run this first:" >&2
  echo "    npx wrangler login" >&2
  exit 1
fi
"${WRANGLER[@]}" whoami 2>/dev/null | grep -iE "account name|account id" || true

say "1. Test"
note "Deploying code whose tests fail is how a broken relay reaches everyone at once."
[ -d node_modules ] || npm ci
npm test

say "2. Migrate D1"
note "Before the deploy, never after."
"${WRANGLER[@]}" d1 execute tiktokforwork --remote --file schema.sql --yes

say "3. Migrate D1 (column additions)"
# Statement by statement, because D1 aborts a file at its first error: on a
# database schema.sql already built, every ALTER here fails with "duplicate
# column name", and running them together meant that expected failure skipped
# everything after it.
status=0
while IFS= read -r stmt; do
  [ -z "$stmt" ] && continue
  printf '  %s\n' "$stmt"
  if ! "${WRANGLER[@]}" d1 execute tiktokforwork --remote --command "$stmt" --yes >/tmp/migrate.log 2>&1; then
    if grep -qi "duplicate column name" /tmp/migrate.log; then
      note "    already applied"
    else
      cat /tmp/migrate.log >&2
      status=1
    fi
  fi
done < <(grep -E '^(ALTER TABLE|CREATE )' migrations.sql)
[ "$status" -eq 0 ] || { echo "A migration failed. Nothing deployed." >&2; exit 1; }

say "4. Deploy"
"${WRANGLER[@]}" deploy

say "5. What is live now"
host=$(grep -oE '[a-z0-9.-]+\.workers\.dev' README.md | head -1)
host=${host:-tiktokforwork.torubj0904.workers.dev}
sleep 2
curl -fsS "https://$host/health" | python3 -m json.tool 2>/dev/null \
  || curl -fsS "https://$host/health" \
  || echo "Could not reach https://$host/health"

say "Done."
note "push / webPush / email false means the secrets are not set yet:"
note "  ./scripts/setup-secrets.sh"
