'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { waitForCiSuccess } = require('./ci-dependency.cjs');

const revision = '3c742f95fd6bb362f3577ba5789a58de16f771b1';
const branch = 'main';
const repo = { owner: 'Torutesu', repo: 'HonmaruAI' };
const workflowPath = '.github/workflows/ci.yml';

function run(overrides = {}) {
  return {
    id: 12,
    head_sha: revision,
    head_branch: branch,
    event: 'push',
    path: workflowPath,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/Torutesu/HonmaruAI/actions/runs/12',
    ...overrides,
  };
}

function client(responses, calls = []) {
  let index = 0;
  return {
    github: {
      rest: {
        actions: {
          async listWorkflowRuns(parameters) {
            calls.push(parameters);
            const response = responses[Math.min(index, responses.length - 1)];
            index += 1;
            if (response instanceof Error) throw response;
            return { data: { workflow_runs: response } };
          },
        },
      },
    },
    calls,
  };
}

function clock() {
  let time = 0;
  return {
    now: () => time,
    pause: async ms => { time += ms; },
  };
}

test('accepts only a successful exact-SHA push run from the requested branch and workflow', async () => {
  const { github, calls } = client([[run()]]);
  const actual = await waitForCiSuccess({ github, repo, revision, branch });
  assert.equal(actual.id, 12);
  assert.deepEqual(calls[0], {
    ...repo,
    workflow_id: 'ci.yml',
    head_sha: revision,
    branch,
    event: 'push',
    per_page: 100,
  });
});

test('matches an exact staging push on the staging branch', async () => {
  const stagingRun = run({ head_branch: 'staging' });
  const { github } = client([[stagingRun]]);
  const actual = await waitForCiSuccess({ github, repo, revision, branch: 'staging' });
  assert.equal(actual.head_branch, 'staging');
});

test('does not accept runs with a different SHA, branch, event, or workflow path', async () => {
  const mismatches = [
    run({ id: 20, head_sha: '7bf01bb1236c2bb47fac576f43816c3b0da9b46f' }),
    run({ id: 21, head_branch: 'feature' }),
    run({ id: 22, event: 'pull_request' }),
    run({ id: 23, path: '.github/workflows/other.yml' }),
  ];
  const { github } = client([mismatches]);
  const time = clock();
  await assert.rejects(waitForCiSuccess({ github, repo, revision, branch, timeoutMs: 25, intervalMs: 10, ...time }), /Timed out waiting for CI success/);
});

test('waits for an exact pending run and returns it once successful', async () => {
  const { github, calls } = client([[run({ status: 'in_progress', conclusion: null })], [run()]]);
  const time = clock();
  const actual = await waitForCiSuccess({ github, repo, revision, branch, timeoutMs: 100, intervalMs: 10, ...time });
  assert.equal(actual.conclusion, 'success');
  assert.equal(calls.length, 2);
});

test('fails closed when the exact CI run fails', async () => {
  const { github } = client([[run({ conclusion: 'failure' })]]);
  await assert.rejects(waitForCiSuccess({ github, repo, revision, branch }), /concluded failure; deployment stopped/);
});

test('fails closed when the exact CI run is cancelled', async () => {
  const { github } = client([[run({ conclusion: 'cancelled' })]]);
  await assert.rejects(waitForCiSuccess({ github, repo, revision, branch }), /concluded cancelled; deployment stopped/);
});

test('fails closed on timeout when no exact push run is available', async () => {
  const { github } = client([[]]);
  const time = clock();
  await assert.rejects(waitForCiSuccess({ github, repo, revision, branch, timeoutMs: 25, intervalMs: 10, ...time }), /Timed out waiting for CI success/);
});

test('fails closed immediately when the Actions read API fails', async () => {
  const { github } = client([new Error('Resource not accessible by integration')]);
  await assert.rejects(waitForCiSuccess({ github, repo, revision, branch }), /Could not read CI status.*Resource not accessible by integration/);
});

test('chooses the newest exact-SHA run and does not fall back to an older success', async () => {
  const { github } = client([[run({ id: 11 }), run({ id: 12, conclusion: 'failure' })]]);
  await assert.rejects(waitForCiSuccess({ github, repo, revision, branch }), /concluded failure; deployment stopped/);
});
