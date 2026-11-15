import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';

const ORG = 'personal:github-app-draft';
const DEFAULT_SHA = '1'.repeat(40);
const DEFAULT_TREE = '2'.repeat(40);
const NEW_COMMIT = '3'.repeat(40);
const headers = token => ({ 'content-type': 'application/json', 'x-session-token': token });
const call = (path, init = {}) => worker.fetch(new Request(`https://example.com${path}`, init), { ...env });
const send = (path, token, body) => call(path, { method: 'POST', headers: headers(token), body: JSON.stringify({ orgId: ORG, ...body }) });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\\n/g, ' '));
  await upsertUser(env.DB, { githubId: '9201', login: 'maker', name: 'Maker', avatarUrl: null, locale: 'en' });
  await upsertMembership(env.DB, ORG, '9201', 'admin');
});

test('GitHub draft export is a requester-authorized write to one isolated app branch using the saved revision', async () => {
  const token = await createSession(env.DB, '9201', 'gho-github-draft-test');
  const created = await call('/apps', { method: 'POST', headers: headers(token), body: JSON.stringify({ orgId: ORG, template: 'tracker', sample: false }) });
  expect(created.status).toBe(201);
  const app = (await created.json()).app;
  const html = '<!doctype html><main>Saved app revision</main>';
  const saved = await send(`/apps/${app.id}/custom`, token, { action: 'draft', version: app.version, html });
  expect(saved.status).toBe(200);

  const branch = `honmaru/apps/${app.id}/draft`;
  const paths = [];
  const fetchMock = vi.fn(async (input, options = {}) => {
    const url = new URL(String(input));
    paths.push({ path: url.pathname, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url.pathname === '/user') return response({ id: 9201, login: 'maker' });
    if (url.pathname === '/repos/acme/demo') return response({ full_name: 'acme/demo', default_branch: 'main', permissions: { push: true } });
    if (url.pathname === `/repos/acme/demo/git/ref/heads/main`) return response({ object: { sha: DEFAULT_SHA } });
    if (url.pathname === `/repos/acme/demo/git/commits/${DEFAULT_SHA}`) return response({ sha: DEFAULT_SHA, tree: { sha: DEFAULT_TREE } });
    if (url.pathname === `/repos/acme/demo/git/ref/heads/${branch}`) return response({ message: 'missing' }, 404);
    if (url.pathname === '/repos/acme/demo/git/blobs') return response({ sha: '4'.repeat(40) });
    if (url.pathname === '/repos/acme/demo/git/trees') return response({ sha: '5'.repeat(40) });
    if (url.pathname === '/repos/acme/demo/git/commits' && options.method === 'POST') return response({ sha: NEW_COMMIT });
    if (url.pathname === '/repos/acme/demo/git/refs' && options.method === 'POST') return response({ ref: `refs/heads/${branch}` });
    return response({ message: `unexpected ${url.pathname}` }, 400);
  });
  vi.stubGlobal('fetch', fetchMock);

  const inspected = await send(`/apps/${app.id}/custom`, token, { action: 'inspect_draft_repository', owner: 'acme', repo: 'demo' });
  expect(inspected.status).toBe(200);
  const inspection = await inspected.json();
  expect(inspection).toMatchObject({ branch, path: `${branch}/index.html`, currentDraftSha: null });
  expect(paths.every(request => request.method === 'GET')).toBe(true);

  const uninspected = await send(`/apps/${app.id}/custom`, token, { action: 'write_github_draft', owner: 'acme', repo: 'demo', html: '<main>Untrusted request body</main>' });
  expect(uninspected.status).toBe(400);
  expect(paths).toHaveLength(3);

  const written = await send(`/apps/${app.id}/custom`, token, {
    action: 'write_github_draft', owner: 'acme', repo: 'demo', expectedSha: inspection.currentDraftSha,
    html: '<main>Untrusted request body</main>',
  });
  expect(written.status).toBe(200);
  expect(await written.json()).toMatchObject({ repository: 'acme/demo', branch, path: `${branch}/index.html`, commitSha: NEW_COMMIT, assetCount: 0 });
  const blob = paths.find(request => request.path === '/repos/acme/demo/git/blobs');
  expect(atob(blob.body.content)).toBe(html);
  expect(paths.find(request => request.path === '/repos/acme/demo/git/trees')?.body).toMatchObject({
    base_tree: DEFAULT_TREE,
    tree: [{ path: `${branch}/index.html`, mode: '100644', type: 'blob', sha: '4'.repeat(40) }],
  });
  expect(paths.find(request => request.path === '/repos/acme/demo/git/refs')?.body).toEqual({ ref: `refs/heads/${branch}`, sha: NEW_COMMIT });
  expect(paths.some(request => request.method === 'PATCH' && request.path.endsWith('/main'))).toBe(false);
});

