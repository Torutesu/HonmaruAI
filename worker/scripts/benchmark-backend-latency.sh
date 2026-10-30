#!/bin/sh
# Local fixtures only. Keep baseline source beside its dependencies for imports.
set -eu
cd "$(dirname "$0")/.."
report=${1:-/tmp/honmaru-backend-latency-$$.jsonl}
baseline=2054bce06e34324f340f904e9d29346398f422b1
cleanup() { rm -f src/channels-latency-before.js src/channelRoutes-latency-before.js src/customAgents-latency-before.js test/backend-latency-benchmark.generated.test.js vitest.latency-benchmark.generated.config.js; }
for generated in src/channels-latency-before.js src/channelRoutes-latency-before.js src/customAgents-latency-before.js test/backend-latency-benchmark.generated.test.js vitest.latency-benchmark.generated.config.js; do
  if [ -e "$generated" ]; then printf "Refusing to overwrite %s\n" "$generated" >&2; exit 1; fi
done
trap cleanup EXIT HUP INT TERM
git show "$baseline":worker/src/channels.js > src/channels-latency-before.js
git show "$baseline":worker/src/customAgents.js | sed 's|"./channels.js"|"./channels-latency-before.js"|' > src/customAgents-latency-before.js
git show "$baseline":worker/src/channelRoutes.js | sed -e 's|"./channels.js"|"./channels-latency-before.js"|' -e 's|"./customAgents.js"|"./customAgents-latency-before.js"|' > src/channelRoutes-latency-before.js
cp scripts/backend-latency-benchmark.fixture.js test/backend-latency-benchmark.generated.test.js
python3 - "$report" <<'PYCONFIG'
from pathlib import Path
import json,sys
report=Path(sys.argv[1]).resolve()
report.write_text('')
config=Path('vitest.config.js').read_text()
config="import {appendFileSync} from 'node:fs';\n"+config
binding="serviceBindings: { BENCHMARK_CAPTURE: async request => { appendFileSync("+json.dumps(str(report))+", await request.text() + '\\n'); return new Response('ok'); } },"
config=config.replace('miniflare: {','miniflare: {'+binding,1)
Path('vitest.latency-benchmark.generated.config.js').write_text(config)
PYCONFIG
pnpm --config.verify-deps-before-run=false exec vitest run --config vitest.latency-benchmark.generated.config.js test/backend-latency-benchmark.generated.test.js --testTimeout=180000 --hookTimeout=120000

printf "Benchmark JSONL: %s\n" "$report"
