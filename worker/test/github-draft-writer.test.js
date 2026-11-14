import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectGitHubAppDraftRepository, writeGitHubAppDraft } from '../src/harness/githubDraftWriter.js';

const TOKEN = 'gho_test_secret_do_not_return';
const DEFAULT_SHA = '1'.repeat(40);
const DEFAULT_TREE = '2'.repeat(40);
const DRAFT_SHA = '3'.repeat(40);
const DRAFT_TREE = '7'.repeat(40);
const NEW_TREE = '4'.repeat(40);
const NEW_COMMIT = '5'.repeat(40);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function setupFetch({ push = true, defaultBranch = 'main', draft = 'missing', patchStatus = 200, defaultMoves = false, defaultBranchMoves = false } = {}) {
  const requests = [];
  let defaultReads = 0;
  let repoReads = 0;
  const fetchMock = vi.fn(async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed.href, path: parsed.pathname, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    if (parsed.origin !== 'https://api.github.com') return json({ message: 'unexpected host' }, 400);
    if (parsed.pathname === '/user') return json({ id: 71, login: 'writer' });
    if (parsed.pathname === '/repos/acme/demo') {
      repoReads += 1;
      return json({ full_name: 'acme/demo', default_branch: defaultBranchMoves && repoReads > 1 ? 'honmaru/apps/app-1/draft' : defaultBranch, permissions: { push } });
    }
    if (parsed.pathname === `/repos/acme/demo/git/ref/heads/${defaultBranch.split('/').join('/')}`) {
      defaultReads += 1;
      return json({ object: { sha: defaultMoves && defaultReads > 1 ? 'a'.repeat(40) : DEFAULT_SHA } });
    }
    if (parsed.pathname === `/repos/acme/demo/git/commits/${DEFAULT_SHA}`) return json({ sha: DEFAULT_SHA, tree: { sha: DEFAULT_TREE } });
    if (parsed.pathname === `/repos/acme/demo/git/commits/${DRAFT_SHA}`) return json({ sha: DRAFT_SHA, tree: { sha: DRAFT_TREE } });
    if (parsed.pathname === '/repos/acme/demo/git/ref/heads/honmaru/apps/app-1/draft') {
      return draft === 'missing' ? json({ message: `not found ${TOKEN}` }, 404) : json({ object: { sha: DRAFT_SHA } });
    }
    if (parsed.pathname === '/repos/acme/demo/git/blobs') return json({ sha: (6 + requests.filter(r => r.path === parsed.pathname).length - 1).toString(16).repeat(40) });
    if (parsed.pathname === '/repos/acme/demo/git/trees') return json({ sha: NEW_TREE });
    if (parsed.pathname === '/repos/acme/demo/git/commits' && options.method === 'POST') return json({ sha: NEW_COMMIT });
    if (parsed.pathname === '/repos/acme/demo/git/refs' && options.method === 'POST') return json({ ref: 'refs/heads/honmaru/apps/app-1/draft' });
    if (parsed.pathname === '/repos/acme/demo/git/refs/heads/honmaru/apps/app-1/draft' && options.method === 'PATCH') {
      return patchStatus === 200 ? json({ ref: 'refs/heads/honmaru/apps/app-1/draft' }) : json({ message: `non-fast-forward ${TOKEN}` }, patchStatus);
    }
    return json({ message: `unexpected request ${parsed.pathname}` }, 400);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

const draft = {
  owner: 'acme', repo: 'demo', appId: 'app-1',
  html: '<!doctype html><html><head><link rel="stylesheet" href="site.css"></head><body><main>Draft</main></body></html>',
  assets: [{ path: 'site.css', content: 'main { color: #111; }' }],
};

afterEach(() => vi.unstubAllGlobals());

describe('writeGitHubAppDraft', () => {
  it('creates only the generated draft branch from the current default branch', async () => {
    const { requests } = setupFetch();
    const result = await writeGitHubAppDraft(TOKEN, { ...draft, endpoint: 'https://example.invalid/proxy' });

    expect(result).toMatchObject({
      ok: true, owner: 'acme', repo: 'demo', repository: 'acme/demo', defaultBranch: 'main', appId: 'app-1',
      branch: 'honmaru/apps/app-1/draft', path: 'honmaru/apps/app-1/draft/index.html', commitSha: NEW_COMMIT,
      assetCount: 1, totalBytes: new TextEncoder().encode(draft.html).byteLength + new TextEncoder().encode('main { color: #111; }').byteLength,
    });
    expect(requests.every(request => new URL(request.url).origin === 'https://api.github.com')).toBe(true);
    expect(requests.find(request => request.path === '/repos/acme/demo/git/trees')?.body).toMatchObject({
      base_tree: DEFAULT_TREE,
      tree: [
        { path: 'honmaru/apps/app-1/draft/index.html', mode: '100644', type: 'blob' },
        { path: 'honmaru/apps/app-1/draft/site.css', mode: '100644', type: 'blob' },
      ],
    });
    expect(requests.find(request => request.path === '/repos/acme/demo/git/commits' && request.method === 'POST')?.body.parents).toEqual([DEFAULT_SHA]);
    expect(requests.find(request => request.path === '/repos/acme/demo/git/refs')?.body).toEqual({ ref: 'refs/heads/honmaru/apps/app-1/draft', sha: NEW_COMMIT });
    expect(requests.some(request => request.method === 'PATCH' && request.path.endsWith('/main'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('updates an existing generated draft ref with a fast-forward-only patch', async () => {
    const { requests } = setupFetch({ draft: 'present' });
    const result = await writeGitHubAppDraft(TOKEN, draft);
    const update = requests.find(request => request.method === 'PATCH');
    expect(result.ok).toBe(true);
    expect(update.path).toBe('/repos/acme/demo/git/refs/heads/honmaru/apps/app-1/draft');
    expect(update.body).toEqual({ sha: NEW_COMMIT, force: false });
    expect(requests.find(request => request.path === '/repos/acme/demo/git/commits' && request.method === 'POST')?.body.parents).toEqual([DRAFT_SHA]);
    expect(requests.find(request => request.path === '/repos/acme/demo/git/trees')?.body.base_tree).toBe(DRAFT_TREE);
  });

  it('requires a verified account and explicit repository push permission', async () => {
    const { requests } = setupFetch({ push: false });
    const result = await writeGitHubAppDraft(TOKEN, draft);
    expect(result).toEqual({ error: 'The connected GitHub account does not have push permission for this repository.', status: 403 });
    expect(requests.some(request => /\/git\/(?:blobs|trees|commits|refs)/.test(request.path))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('inspects repository binding and push access without creating Git objects or refs', async () => {
    const { requests } = setupFetch();
    const result = await inspectGitHubAppDraftRepository(TOKEN, { owner: 'acme', repo: 'demo', appId: 'app-1' });
    expect(result).toEqual({
      ok: true, owner: 'acme', repo: 'demo', repository: 'acme/demo', defaultBranch: 'main',
      appId: 'app-1', branch: 'honmaru/apps/app-1/draft', path: 'honmaru/apps/app-1/draft/index.html',
    });
    expect(requests.map(request => request.path)).toEqual(['/user', '/repos/acme/demo']);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('uses expectedSha as a precondition before creating any Git objects', async () => {
    const { requests } = setupFetch({ draft: 'present' });
    const result = await writeGitHubAppDraft(TOKEN, { ...draft, expectedSha: DEFAULT_SHA });
    expect(result).toEqual({ error: 'The draft branch changed. Reload the current draft before publishing again.', status: 409 });
    expect(requests.some(request => request.method === 'POST')).toBe(false);
  });

  it('rejects an expected draft revision when the generated branch does not yet exist', async () => {
    const { requests } = setupFetch();
    const result = await writeGitHubAppDraft(TOKEN, { ...draft, expectedSha: DRAFT_SHA });
    expect(result.status).toBe(409);
    expect(requests.some(request => request.method === 'POST')).toBe(false);
  });

  it('rejects a generated branch that collides with the repository default branch', async () => {
    const { requests } = setupFetch({ defaultBranch: 'honmaru/apps/app-1/draft' });
    const result = await writeGitHubAppDraft(TOKEN, draft);
    expect(result).toEqual({ error: 'The generated draft branch cannot be the repository default branch.', status: 409 });
    expect(requests.some(request => /\/git\/(?:blobs|trees|commits|refs)/.test(request.path))).toBe(false);
  });

  it('maps non-fast-forward branch updates to a safe conflict without force', async () => {
    const { requests } = setupFetch({ draft: 'present', patchStatus: 422 });
    const result = await writeGitHubAppDraft(TOKEN, draft);
    expect(result).toEqual({ error: 'The Git branch changed concurrently. Reload the draft before publishing again.', status: 409 });
    expect(requests.find(request => request.method === 'PATCH')?.body.force).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('maps either GitHub conflict response to a safe conflict without force', async () => {
    for (const patchStatus of [409, 422]) {
      const { requests } = setupFetch({ draft: 'present', patchStatus });
      const result = await writeGitHubAppDraft(TOKEN, draft);
      expect(result.status).toBe(409);
      expect(requests.find(request => request.method === 'PATCH')?.body.force).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('rejects oversized or unsafe assets before making a network request', async () => {
    const { requests } = setupFetch();
    const oversizedHtml = await writeGitHubAppDraft(TOKEN, { ...draft, html: 'x'.repeat(120_001) });
    const oversizedBundle = await writeGitHubAppDraft(TOKEN, { ...draft, assets: [{ path: 'large.css', content: 'x'.repeat(1_500_000) }] });
    const unsafePath = await writeGitHubAppDraft(TOKEN, { ...draft, assets: [{ path: '../outside.css', content: 'body{}' }] });
    expect(oversizedHtml.status).toBe(413);
    expect(oversizedBundle.status).toBe(413);
    expect(unsafePath.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('never returns provider bodies or fetch errors that could contain the token', async () => {
    const mock = vi.fn(async url => {
      if (new URL(url).pathname === '/user') return json({ message: `token=${TOKEN}` }, 401);
      return json({});
    });
    vi.stubGlobal('fetch', mock);
    const result = await writeGitHubAppDraft(TOKEN, draft);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`request failed with ${TOKEN}`); }));
    const networkFailure = await writeGitHubAppDraft(TOKEN, draft);
    expect(JSON.stringify(networkFailure)).not.toContain(TOKEN);
  });

  it('does not write when the default branch moves during upload', async () => {
    const { requests } = setupFetch({ defaultMoves: true });
    const result = await writeGitHubAppDraft(TOKEN, draft);
    expect(result.status).toBe(409);
    expect(requests.some(request => request.method === 'POST' && request.path === '/repos/acme/demo/git/refs')).toBe(false);
    expect(requests.some(request => request.method === 'PATCH')).toBe(false);
  });

  it('does not update a generated ref if that ref becomes the repository default branch', async () => {
    const { requests } = setupFetch({ defaultBranchMoves: true, draft: 'present' });
    const result = await writeGitHubAppDraft(TOKEN, draft);
    expect(result.status).toBe(409);
    expect(requests.some(request => request.method === 'PATCH')).toBe(false);
  });
});
