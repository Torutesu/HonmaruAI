const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

// Execute the actual workflow gate, with offline Git/GitHub responses.
const workflow = readFileSync(join(__dirname, '../workflows/mac-release.yml'), 'utf8')
const gate = workflow.split('      - name: Verify tagged release version and CI\n')[1]
  .split('        run: |\n')[1].split('\n      - ')[0]
  .split('\n').map(line => line.replace(/^          /, '')).join('\n')
const success = { head_sha: 'abc', head_branch: 'main', run_number: 1, status: 'completed', conclusion: 'success' }
for (const [name, runs, ref, ancestor, accepted] of [
  ['exact tested main commit', [success], 'mac-release/v1.3.9', true, true],
  ['missing CI', [], 'mac-release/v1.3.9', true, false],
  ['pending CI', [{ ...success, status: 'in_progress', conclusion: null }], 'mac-release/v1.3.9', true, false],
  ['failed CI', [{ ...success, conclusion: 'failure' }], 'mac-release/v1.3.9', true, false],
  ['other commit', [{ ...success, head_sha: 'other' }], 'mac-release/v1.3.9', true, false],
  ['feature branch CI', [{ ...success, head_branch: 'feature' }], 'mac-release/v1.3.9', true, false],
  ['newer failed run supersedes success', [success, { ...success, run_number: 2, conclusion: 'failure' }], 'mac-release/v1.3.9', true, false],
  ['version mismatch', [success], 'mac-release/v1.3.8', true, false],
  ['not on main', [success], 'mac-release/v1.3.9', false, false],
]) test(`Mac tag gate: ${name}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'honmaru-release-gate-'))
  try {
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.3.9' }))
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ workflow_runs: runs }))
    writeFileSync(join(dir, 'bin/gh'), '#!/bin/sh\ncat "$FIXTURE_RUNS"\n', { mode: 0o700 })
    writeFileSync(join(dir, 'bin/git'), '#!/bin/sh\nif [ "$1" = "merge-base" ]; then exit "$FIXTURE_ANCESTOR"; fi\n', { mode: 0o700 })
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', gate], {
      cwd: dir, encoding: 'utf8', env: {
        ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        RELEASE_REF: ref, GITHUB_SHA: 'abc', GITHUB_REPOSITORY: 'test/repository',
        FIXTURE_RUNS: join(dir, 'runs.json'), FIXTURE_ANCESTOR: ancestor ? '0' : '1',
      },
    })
    assert.equal(result.status === 0, accepted, result.stderr + result.stdout)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
