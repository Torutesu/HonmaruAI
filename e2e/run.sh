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
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$WORKER_PORT/health" >/tmp/e2e-health.json 2>/dev/null; then break; fi
  printf '.'; sleep 1
done
echo
python3 -m json.tool /tmp/e2e-health.json
# Parsed, not grepped: curl returns compact JSON and the pretty-print above is
# a different string. The first version of this check looked for `"email": true`
# in a body that says `"email":true`, and stopped a Worker that was fine.
python3 -c 'import json,sys; d=json.load(open("/tmp/e2e-health.json")); sys.exit(0 if d.get("email") else 1)' \
  || { echo "the Worker has no mail configured; the sign-in flow cannot run" >&2; exit 1; }

say "3. Web client, built against that Worker"
cd web-react
[ -d node_modules ] || npm ci
VITE_API_HOST="127.0.0.1:$WORKER_PORT" npm run build >/tmp/e2e-build.log 2>&1
grep -q "127.0.0.1:$WORKER_PORT" dist/assets/*.js || { echo "the backend host did not make it into the build" >&2; exit 1; }
npx vite preview --port "$WEB_PORT" --strictPort >/tmp/e2e-preview.log 2>&1 & pids+=($!)
cd ..
for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && break
  sleep 1
done

say "4. Clear the rate-limit window"
# The credential routes are rate limited per caller, which is right, and this
# runs them several times from one address several times a day. Resetting the
# local window is the harness getting out of its own way — production is
# untouched, and a 429 during the run would look like a broken sign-in.
(cd worker && npx -y wrangler@4 d1 execute tiktokforwork --local \
  --command "DELETE FROM rate_limits" --yes >/tmp/e2e-ratelimit.log 2>&1) || true

say "5. Drive it"
node e2e/spec.mjs
