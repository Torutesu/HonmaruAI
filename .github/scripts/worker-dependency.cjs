// GitHub keeps only one pending run in a concurrency group. A newer Worker
// push may cancel the exact revision a Web build is waiting for.
// Accept its replacement only after proving that it contains that revision.
function stateOf(run) {
  if (run.status !== 'completed') return { state: 'pending', run }
  return { state: run.conclusion === 'success' ? 'ready' : 'failed', run }
}

async function workerDependency({ github, repo, revision, ancestry = new Map() }) {
  const list = async extra => (await github.rest.actions.listWorkflowRuns({
    ...repo, workflow_id: 'deploy-worker.yml', event: 'push', per_page: 100, ...extra,
  })).data.workflow_runs.filter(run => run.head_branch === 'main' && run.event === 'push')
    .sort((a, b) => b.id - a.id)
  const exact = (await list({ head_sha: revision })).find(run => run.head_sha === revision)
  // A failed exact deployment is a failure, not permission to bypass a gate.
  if (exact && !(exact.status === 'completed' && exact.conclusion === 'cancelled')) return stateOf(exact)
  for (const run of await list({ branch: 'main' })) {
    if (exact && run.id <= exact.id) continue
    if (run.status === 'completed' && run.conclusion === 'cancelled') continue
    const key = `${revision}:${run.head_sha}`
    if (!ancestry.has(key)) {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        ...repo, basehead: `${revision}...${run.head_sha}`, per_page: 1,
      })
      ancestry.set(key, ['ahead', 'identical'].includes(data.status))
    }
    if (ancestry.get(key)) return stateOf(run)
  }
  return { state: 'pending', run: null }
}

module.exports = { workerDependency }
