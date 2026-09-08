#!/usr/bin/env bash
# Cold, disposable browser gate. CI installs the locked web/Worker dependencies
# and Chromium first; this script creates, starts, verifies, and removes its own
# local backend. It never deploys, loads .dev.vars, or uses an existing database.
#
# Local example (with both dependencies + Chromium installed):
# WEB_QA_WEB_PORT=4317 WEB_QA_WORKER_PORT=8797 bash scripts/ci-browser-smoke.sh
set -euo pipefail

WEB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$WEB_ROOT/.." && pwd)"
WORKER_ROOT="$REPO_ROOT/worker"
WEB_PORT="${WEB_QA_WEB_PORT:-3000}"
WORKER_PORT="${WEB_QA_WORKER_PORT:-8787}"
for port in "$WEB_PORT" "$WORKER_PORT"; do
  case "$port" in ''|*[!0-9]*) echo "QA ports must be numeric." >&2; exit 1;; esac
  [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || { echo "QA port is out of range." >&2; exit 1; }
done
[ "$WEB_PORT" != "$WORKER_PORT" ] || { echo "Frontend and Worker ports must differ." >&2; exit 1; }

command -v node >/dev/null
command -v curl >/dev/null
[ -f "$WEB_ROOT/node_modules/vite/bin/vite.js" ] || { echo "Run npm ci --no-audit in web-react first." >&2; exit 1; }
[ -f "$WORKER_ROOT/node_modules/wrangler/bin/wrangler.js" ] || { echo "Run npm ci --no-audit in worker first." >&2; exit 1; }

# Refuse occupied ports rather than accidentally testing a previously running
# server with a different API, source tree, or database.
node --input-type=module - "$WEB_PORT" "$WORKER_PORT" <<'JS'
import net from 'node:net'
for (const port of process.argv.slice(2).map(Number)) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => reject(new Error(`Cannot reserve QA port ${port} (${error.code}). Choose an unused accessible port.`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}
JS

QA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/honmaru-web-ci.XXXXXX")"
OUTPUT="${WEB_QA_OUTPUT:-$(mktemp -d "${TMPDIR:-/tmp}/honmaru-web-evidence.XXXXXX")}"
WEB_PID=""
WORKER_PID=""
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  for pid in "$WEB_PID" "$WORKER_PID"; do
    [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "$WEB_PID" "$WORKER_PID"; do
    [ -z "$pid" ] || wait "$pid" 2>/dev/null || true
  done
  if [ "$result" -ne 0 ]; then
    for log in "$QA_ROOT/migrate.log" "$QA_ROOT/build.log" "$QA_ROOT/worker.log" "$QA_ROOT/web.log"; do
      if [ -f "$log" ]; then printf '\n%s\n' "Local QA diagnostic: $(basename "$log")" >&2; tail -n 30 "$log" >&2; fi
    done
  fi
  # Only the directory minted by this process is removed. Screenshots/checks
  # remain in OUTPUT; browser storage, D1, R2, and local logs do not.
  rm -rf -- "$QA_ROOT"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$OUTPUT"
: > "$QA_ROOT/empty.env"
export WRANGLER_SEND_METRICS=false
export WRANGLER_LOG_PATH="$QA_ROOT/wrangler-logs"
export CLOUDFLARE_INCLUDE_PROCESS_ENV=false

(
  cd "$WORKER_ROOT"
  node node_modules/wrangler/bin/wrangler.js d1 execute tiktokforwork \
    --local --persist-to "$QA_ROOT/state" --env-file "$QA_ROOT/empty.env" \
    --file schema.sql --yes
) > "$QA_ROOT/migrate.log" 2>&1

(
  cd "$WORKER_ROOT"
  exec node node_modules/wrangler/bin/wrangler.js dev \
    --local --ip 127.0.0.1 --port "$WORKER_PORT" \
    --persist-to "$QA_ROOT/state" --env-file "$QA_ROOT/empty.env"
) > "$QA_ROOT/worker.log" 2>&1 &
WORKER_PID=$!

# Exercise an actual production bundle with an explicit local API origin. Its
# output is isolated so the developer's dist/ and running dev server stay intact.
(
  cd "$WEB_ROOT"
  VITE_API_HOST="http://127.0.0.1:$WORKER_PORT" VITE_DEBUG=false \
    node node_modules/vite/bin/vite.js build --outDir "$QA_ROOT/dist"
) > "$QA_ROOT/build.log" 2>&1

(
  cd "$WEB_ROOT"
  exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 \
    --port "$WEB_PORT" --strictPort --outDir "$QA_ROOT/dist"
) > "$QA_ROOT/web.log" 2>&1 &
WEB_PID=$!

wait_for_server() {
  local url=$1 pid=$2
  for attempt in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || { echo "Local QA server exited before becoming ready: $url" >&2; return 1; }
    if curl --max-time 1 -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "Local QA server did not become ready: $url" >&2
  return 1
}
wait_for_server "http://127.0.0.1:$WORKER_PORT/health" "$WORKER_PID"
wait_for_server "http://127.0.0.1:$WEB_PORT" "$WEB_PID"

cd "$WEB_ROOT"
WEB_QA_URL="http://127.0.0.1:$WEB_PORT" WORKER_QA_URL="http://127.0.0.1:$WORKER_PORT" WEB_QA_OUTPUT="$OUTPUT" node scripts/browser-smoke.mjs
printf '\nLocal browser evidence: %s\n' "$OUTPUT"
