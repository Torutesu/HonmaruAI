const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workerDependency } = require('./worker-dependency.cjs')
const run = (id, head_sha, status = 'completed', conclusion = 'success', extra = {}) =>
  ({ id, head_sha, status, conclusion, head_branch: 'main', event: 'push', ...extra })
function fixture(runs, statuses = {}) {
  const comparisons = []
  const github = { rest: {
    actions: { listWorkflowRuns: async args => ({ data: { workflow_runs: runs.filter(r => !args.head_sha || r.head_sha === args.head_sha) } }) },
    repos: { compareCommitsWithBasehead: async ({ basehead }) => { comparisons.push(basehead); return { data: { status: statuses[basehead] || 'diverged' } } } },
  } }
  return { github, repo: { owner: 'owner', repo: 'repo' }, revision: 'required', comparisons }
}
test('successful exact deployment is ready without ancestry calls', async () => {
  const f = fixture([run(1, 'required')])
  assert.equal((await workerDependency(f)).state, 'ready')
  assert.deepEqual(f.comparisons, [])
})
test('a cancelled pending deployment can be replaced by a successful descendant', async () => {
  const f = fixture([run(1, 'required', 'completed', 'cancelled'), run(2, 'replacement')], { 'required...replacement': 'ahead' })
  assert.equal((await workerDependency(f)).run.id, 2)
  assert.equal((await workerDependency(f)).state, 'ready')
})
test('waits for the descendant instead of accepting an older successful release', async () => {
  const f = fixture([run(1, 'old'), run(2, 'required', 'completed', 'cancelled'), run(3, 'replacement', 'queued', null)], { 'required...replacement': 'ahead' })
  assert.equal((await workerDependency(f)).state, 'pending')
})
test('unrelated, staging and manual runs never satisfy the dependency', async () => {
  const f = fixture([
    run(1, 'required', 'completed', 'cancelled'),
    run(2, 'other'), run(3, 'staging', 'completed', 'success', { head_branch: 'staging' }),
    run(4, 'manual', 'completed', 'success', { event: 'workflow_dispatch' }),
  ])
  assert.equal((await workerDependency(f)).state, 'pending')
  assert.deepEqual(f.comparisons, ['required...other'])
})
test('exact and descendant deployment failures remain failures', async () => {
  assert.equal((await workerDependency(fixture([run(1, 'required', 'completed', 'failure')]))).state, 'failed')
  const f = fixture([run(1, 'required', 'completed', 'cancelled'), run(2, 'replacement', 'completed', 'failure')], { 'required...replacement': 'ahead' })
  assert.equal((await workerDependency(f)).state, 'failed')
})
test('caches ancestry while rechecking live deployment status', async () => {
  const runs = [run(1, 'required', 'completed', 'cancelled'), run(2, 'replacement', 'in_progress', null)]
  const f = { ...fixture(runs, { 'required...replacement': 'ahead' }), ancestry: new Map() }
  assert.equal((await workerDependency(f)).state, 'pending')
  Object.assign(runs[1], { status: 'completed', conclusion: 'success' })
  assert.equal((await workerDependency(f)).state, 'ready')
  assert.deepEqual(f.comparisons, ['required...replacement'])
})
test('missing exact run still requires a proven descendant', async () => {
  const f = fixture([run(2, 'replacement')], { 'required...replacement': 'ahead' })
  assert.equal((await workerDependency(f)).state, 'ready')
  assert.equal((await workerDependency(fixture([]))).state, 'pending')
})
test('API errors fail closed', async () => {
  const f = fixture([run(2, 'replacement')])
  f.github.rest.repos.compareCommitsWithBasehead = async () => { throw new Error('unavailable') }
  await assert.rejects(workerDependency(f), /unavailable/)
})
test('a newer running descendant does not hide a proven successful deployment', async () => {
  const f = fixture([run(4, 'next', 'in_progress', null), run(3, 'deployed')], {
    'required...next': 'ahead', 'required...deployed': 'ahead',
  })
  const result = await workerDependency(f)
  assert.equal(result.state, 'ready')
  assert.equal(result.run.id, 3)
})
test('a newer failed descendant is not ignored in favor of an older success', async () => {
  const f = fixture([run(4, 'next', 'completed', 'failure'), run(3, 'deployed')], {
    'required...next': 'ahead', 'required...deployed': 'ahead',
  })
  assert.equal((await workerDependency(f)).state, 'failed')
})
