'use strict';

const DEFAULT_WORKFLOW_ID = 'ci.yml';
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 20 * 1000;
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function latestExactRun(runs, { revision, branch, workflowPath }) {
  return runs
    .filter(run => run && run.head_sha === revision && run.head_branch === branch && run.event === 'push' && run.path === workflowPath)
    .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))[0] || null;
}

async function waitForCiSuccess({
  github,
  repo,
  revision,
  branch,
  workflowId = DEFAULT_WORKFLOW_ID,
  workflowPath = `.github/workflows/${DEFAULT_WORKFLOW_ID}`,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now,
  pause = sleep,
}) {
  if (!github?.rest?.actions?.listWorkflowRuns) throw new Error('GitHub Actions read API is unavailable.');
  if (!repo?.owner || !repo?.repo) throw new Error('GitHub repository context is required.');
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision)) throw new Error('A full commit SHA is required.');
  if (typeof branch !== 'string' || !branch) throw new Error('The deployment branch is required.');
  if (typeof workflowId !== 'string' || !workflowId) throw new Error('The CI workflow identifier is required.');
  if (typeof workflowPath !== 'string' || !workflowPath) throw new Error('The CI workflow path is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('The CI wait timeout is invalid.');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('The CI polling interval is invalid.');

  const deadline = now() + timeoutMs;
  for (;;) {
    let data;
    try {
      ({ data } = await github.rest.actions.listWorkflowRuns({
        ...repo,
        workflow_id: workflowId,
        head_sha: revision,
        branch,
        event: 'push',
        per_page: 100,
      }));
    } catch (cause) {
      const detail = String(cause?.message || cause).slice(0, 300);
      throw new Error(`Could not read CI status for ${branch}@${revision}: ${detail}`);
    }

    if (!Array.isArray(data?.workflow_runs)) throw new Error('GitHub returned an invalid CI run list.');
    const run = latestExactRun(data.workflow_runs, { revision, branch, workflowPath });
    if (run?.status === 'completed') {
      if (run.conclusion === 'success') return run;
      const conclusion = run.conclusion || 'unknown';
      throw new Error(`Exact-commit CI run ${run.html_url || run.id} concluded ${conclusion}; deployment stopped.`);
    }
    if (run && !PENDING_STATUSES.has(run.status)) {
      throw new Error(`Exact-commit CI run ${run.html_url || run.id} has unsupported status ${run.status || 'unknown'}; deployment stopped.`);
    }

    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Timed out waiting for CI success on ${branch}@${revision}; deployment stopped.`);
    await pause(Math.min(intervalMs, remaining));
  }
}

module.exports = { waitForCiSuccess };
