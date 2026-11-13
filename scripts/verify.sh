#!/usr/bin/env bash
# "Does the codebase work?" in one command: the same checks CI runs
# (.github/workflows/ci.yml), in the same directories, in order. Each part
# installs from its own lockfile.
#
#   scripts/verify.sh            everything but the end-to-end run
#   scripts/verify.sh --e2e      and ./e2e/run.sh (a local stack and a browser)
#   scripts/verify.sh --quick    skip the Worker suite (~45 min on one machine;
#                                CI runs it in four shards)
#
# Stops at the first failure and says which part failed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
e2e=0; quick=0
for arg in "$@"; do
  case "$arg" in
    --e2e) e2e=1 ;;
    --quick) quick=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
trap 'echo "verify: failed during: ${current:-setup}" >&2' ERR

current="gateway and release checks"; step "$current"
node --test gateway/test/*.test.mjs
node --test .github/scripts/worker-dependency.test.cjs .github/scripts/migrate-columns.test.cjs .github/scripts/ci-dependency.test.cjs .github/scripts/wrangler-pin.test.cjs

if [ "$quick" = 0 ]; then
  current="worker"; step "$current"
  (cd worker && npm ci && npm test)
fi

current="reference relay"; step "$current"
(cd server && npm ci && npm test)

current="web client"; step "$current"
(cd web-react && npm ci && npm run build && npx tsc --noEmit -p . && npx vitest run)

current="desktop"; step "$current"
(cd apps/desktop && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm test && node --check src/main.js && node --check src/preload.cjs)

current="shared core and mobile"; step "$current"
node scripts/check-versions.mjs
npm ci
npm test --workspace @honmaru/cli
npm test --workspace @honmaru/core
npm run typecheck --workspace @honmaru/core
npm run typecheck --workspace @honmaru/mobile

if [ "$e2e" = 1 ]; then
  current="end to end"; step "$current"
  ./e2e/run.sh
fi

echo
echo "verify: all passed"
