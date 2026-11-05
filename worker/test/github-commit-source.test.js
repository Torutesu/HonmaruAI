import { afterEach, expect, test, vi } from 'vitest';
import { fetchGitHubCommitSource, verifyGitHubCommitRef } from '../src/harness/githubCommitSource.js';

const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const rootBlob = 'c'.repeat(40);
const jsBlob = 'd'.repeat(40);
const base64 = (value) => btoa(value);
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const responseFor = (url, refSha = commitSha, html = '<script src="./app.js"></script>', js = 'document.body.dataset.ready="yes";') => {
  const path = new URL(url).pathname;
  if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: refSha } });
  if (path.endsWith('/git/commits/' + commitSha)) return json({ sha: commitSha, tree: { sha: treeSha } });
  if (path.endsWith('/git/trees/' + treeSha)) return json({ truncated: false, tree: [
    { type: 'blob', mode: '100644', path: 'index.html', sha: rootBlob, size: new TextEncoder().encode(html).length },
    { type: 'blob', mode: '100644', path: 'app.js', sha: jsBlob, size: new TextEncoder().encode(js).length },
  ] });
  if (path.endsWith('/git/blobs/' + rootBlob)) return json({ encoding: 'base64', sha: rootBlob, size: new TextEncoder().encode(html).length, content: base64(html) });
  if (path.endsWith('/git/blobs/' + jsBlob)) return json({ encoding: 'base64', sha: jsBlob, size: new TextEncoder().encode(js).length, content: base64(js) });
  return new Response('unexpected request', { status: 404 });
};
afterEach(() => vi.unstubAllGlobals());

test('imports immutable HTML and recursively captures same-commit relative JS assets', async () => {
  const fetch = vi.fn(async (url) => responseFor(url));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('gho-never-return-this', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result.source).toContain('./app.js');
  expect(result.commit.sha).toBe(commitSha);
  expect(result.assets.map((asset) => asset.path)).toEqual(['app.js']);
  expect(result.commit.assets).toEqual([{ path: 'app.js', mimeType: 'text/javascript', contentHash: expect.any(String), size: 34 }]);
  expect(JSON.stringify(result)).not.toContain('gho-never-return-this');
  expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://api.github.com/'))).toBe(true);
});

test('rejects a branch moved before or during import', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => responseFor(url, String(url).includes('/git/ref/heads/') && fetch.mock.calls.length > 1 ? 'e'.repeat(40) : commitSha)));
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 409 });
});

test('rejects traversal references and missing assets without fetching arbitrary paths', async () => {
  const fetch = vi.fn(async (url) => responseFor(url, commitSha, '<script src="../secret.js"></script>'));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 400 });
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/git/blobs/'))).toHaveLength(1);
});

test('rejects oversized tree and root blobs before returning any content', async () => {
  const fetch = vi.fn(async (url) => String(url).includes('/git/trees/')
    ? json({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'index.html', sha: rootBlob, size: 119801 }] })
    : responseFor(url));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 400 });
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/git/blobs/' + rootBlob))).toBe(false);
});

test('verifies the branch still resolves to the approved full commit SHA', async () => {
  const fetch = vi.fn(async (url) => responseFor(url));
  vi.stubGlobal('fetch', fetch);
  await expect(verifyGitHubCommitRef('token', { owner: 'acme', repo: 'app', branch: 'main', sha: commitSha })).resolves.toEqual({ verified: true });
  vi.stubGlobal('fetch', vi.fn(async (url) => responseFor(url, 'f'.repeat(40))));
  await expect(verifyGitHubCommitRef('token', { owner: 'acme', repo: 'app', branch: 'main', sha: commitSha })).resolves.toMatchObject({ status: 409 });
});
