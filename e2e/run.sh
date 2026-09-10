#!/usr/bin/env bash
#
# The end-to-end test: a real Worker, a real D1, the real built web client, and
# a browser driving them.
#
#     ./e2e/run.sh
#
# Nothing here is mocked except the mail provider, and that one is a real HTTP
# server the Worker really posts to — which is what lets the test read the
# sign-in code out of the message rather than be handed one.
#
# Everything it starts, it stops.

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD=$(tput bold 2>/dev/null || true); OFF=$(tput sgr0 2>/dev/null || true)
say() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

WORKER_PORT=8787
WEB_PORT=4173
pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

# Wait for something to answer, and say so plainly when it never does.
#
# The loops here used to give up in silence. When the preview server did not
# start on CI, every one of the 24 steps failed with a timeout or a refused
# connection, and not one line of the output said which server was missing —
# the harness knew, and threw the answer away.
wait_for() {
  local name=$1 url=$2 tries=$3 log=$4
  for _ in $(seq 1 "$tries"); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    printf '.'
    sleep 1
  done
  echo
  echo "the $name never came up at $url after ${tries}s" >&2
  echo "--- $log ---" >&2
  tail -40 "$log" >&2 || true
  exit 1
}

say "1. Mail sink"
node e2e/mail-sink.mjs >/tmp/e2e-sink.log 2>&1 & pids+=($!)

say "2. Worker (real workerd, local D1)"
cd worker
[ -d node_modules ] || npm ci
# The schema has to exist before anything signs in. --local keeps it on disk
# under .wrangler, so this is the same database the dev server will open.
npx -y wrangler@4 d1 execute tiktokforwork --local --file schema.sql --yes >/tmp/e2e-d1.log 2>&1
npx -y wrangler@4 dev --local --port "$WORKER_PORT" \
  --var RESEND_API_KEY:re_e2e \
  --var RESEND_API_BASE:http://127.0.0.1:9099 \
  --var APP_WEB_URL:"http://127.0.0.1:$WEB_PORT" \
  >/tmp/e2e-worker.log 2>&1 & pids+=($!)
cd ..

printf 'waiting for the Worker'
wait_for "Worker" "http://127.0.0.1:$WORKER_PORT/health" 60 /tmp/e2e-worker.log
echo
curl -fsS "http://127.0.0.1:$WORKER_PORT/health" >/tmp/e2e-health.json
python3 -m json.tool /tmp/e2e-health.json
# Parsed, not grepped: curl returns compact JSON and the pretty-print above is
# a different string. The first version of this check looked for `"email": true`
# in a body that says `"email":true`, and stopped a Worker that was fine.
python3 -c 'import json,sys; d=json.load(open("/tmp/e2e-health.json")); sys.exit(0 if d.get("email") else 1)' \
  || { echo "the Worker has no mail configured; the sign-in flow cannot run" >&2; exit 1; }

say "3. Web client, built against that Worker"
cd web-react
[ -d node_modules ] || npm ci
# The browser the spec drives. Some images ship one at a fixed path and set
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, in which case `install` is a no-op that
# would fail; everywhere else this is what makes a clean clone runnable at all.
if [ -n "${E2E_CHROMIUM:-}" ] || [ -x /opt/pw-browsers/chromium ]; then
  export E2E_CHROMIUM="${E2E_CHROMIUM:-/opt/pw-browsers/chromium}"
else
  npx playwright install --with-deps chromium >/tmp/e2e-browser.log 2>&1 \
    || npx playwright install chromium >>/tmp/e2e-browser.log 2>&1
fi
VITE_API_HOST="127.0.0.1:$WORKER_PORT" npm run build >/tmp/e2e-build.log 2>&1
grep -q "127.0.0.1:$WORKER_PORT" dist/assets/*.js || { echo "the backend host did not make it into the build" >&2; exit 1; }
# --host 127.0.0.1, explicitly. Vite's default is `localhost`, which is a name
# and not an address: on a machine with IPv6 it can resolve to ::1, and the
# preview server then listens there and nowhere else — while the spec, the
# Worker's APP_WEB_URL and the mail sink all speak 127.0.0.1. That is exactly
# what happened the first time this ran on a CI runner, and nothing in this
# container reproduces it, because IPv6 is switched off here.
npx vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >/tmp/e2e-preview.log 2>&1 & pids+=($!)
cd ..
printf 'waiting for the web client'
wait_for "web client" "http://127.0.0.1:$WEB_PORT/" 30 /tmp/e2e-preview.log
echo

say "4. Clear the rate-limit window"
# The credential routes are rate limited per caller, which is right, and this
# runs them several times from one address several times a day. Resetting the
# local window is the harness getting out of its own way — production is
# untouched, and a 429 during the run would look like a broken sign-in.
(cd worker && npx -y wrangler@4 d1 execute tiktokforwork --local \
  --command "DELETE FROM rate_limits" --yes >/tmp/e2e-ratelimit.log 2>&1) || true

say "5. Drive it"
node e2e/spec.mjs
