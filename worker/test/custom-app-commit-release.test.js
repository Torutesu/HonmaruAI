import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';

const ORG = 'personal:commit-release';
const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const blobIds = { html: 'c'.repeat(40), js: 'd'.repeat(40), css: 'e'.repeat(40) };
let toru, mika, gina;
const headers = (token) => ({ 'content-type': 'application/json', 'x-session-token': token });
const call = (path, init = {}) => worker.fetch(new Request('https://example.com' + path, init), { ...env });
const get = (path, token) => call(path, { headers: headers(token) });
const send = (method, path, token, body) => call(path, { method, headers: headers(token), body: JSON.stringify({ orgId: ORG, ...body }) });
const encode = (s) => btoa(unescape(encodeURIComponent(s)));
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function githubFetch({ branch = commitSha, html = '<link rel="stylesheet" href="./styles.css"><script src="./app.js"></script>', js = 'document.body.dataset.ready="yes";', css = 'body{color:#222}' } = {}) {
  const contents = { html, js, css };
  const sizes = Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, new TextEncoder().encode(value).length]));
  return vi.fn(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: branch } });
    if (path.endsWith('/git/commits/' + commitSha)) return json({ sha: commitSha, tree: { sha: treeSha } });
    if (path.endsWith('/git/trees/' + treeSha)) return json({ truncated: false, tree: [
      { type: 'blob', mode: '100644', path: 'index.html', sha: blobIds.html, size: sizes.html },
      { type: 'blob', mode: '100644', path: 'app.js', sha: blobIds.js, size: sizes.js },
      { type: 'blob', mode: '100644', path: 'styles.css', sha: blobIds.css, size: sizes.css },
    ] });
    for (const [key, sha] of Object.entries(blobIds)) if (path.endsWith('/git/blobs/' + sha)) {
      return json({ encoding: 'base64', sha, size: sizes[key], content: encode(contents[key]) });
    }
    return new Response('not found', { status: 404 });
  });
}

async function makeApp() {
  const response = await send('POST', '/apps', toru, { template: 'tracker', sample: false });
  expect(response.status).toBe(201);
  return (await response.json()).app;
}
async function importCommit(app) {
  const result = await send('POST', `/apps/${app.id}/custom`, toru, {
    action: 'import_commit', owner: 'acme', repo: 'static-app', branch: 'main', commitSha,
  });
  return result;
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\\n/g, ' '));
  for (const [id, login] of [['9101', 'toru'], ['9102', 'mika'], ['9103', 'gina']]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: 'en' });
    await upsertMembership(env.DB, ORG, id, 'admin');
  }
  toru = await createSession(env.DB, '9101', 'gho-release-maker');
  mika = await createSession(env.DB, '9102', 'gho-release-member');
  gina = await createSession(env.DB, '9103', 'gho-release-reviewer');
});
afterEach(() => vi.unstubAllGlobals());

test('HTTP import requires an independent Owner/Admin review and publishes captured assets without leaking GitHub token', async () => {
  vi.stubGlobal('fetch', githubFetch());
  const app = await makeApp();
  const imported = await importCommit(app);
  expect(imported.status).toBe(200);
  const importedBody = await imported.json();
  expect(importedBody.commit).toMatchObject({ owner: 'acme', repo: 'static-app', sha: commitSha, appVersion: app.version + 1 });
  expect(JSON.stringify(importedBody)).not.toContain('gho-release-maker');

  const state = await (await get(`/apps/${app.id}/custom?orgId=${ORG}`, toru)).json();
  const requested = await send('POST', `/apps/${app.id}/custom`, toru, {
    action: 'request_commit_approval', version: importedBody.version, commit: importedBody.commit, sourceHash: importedBody.commit.sourceHash,
  });
  expect(requested.status).toBe(200);
  const approval = (await requested.json()).approval;
  expect(approval.status).toBe('pending');
  expect(state.commit.sha).toBe(commitSha);

  const selfReview = await send('POST', `/apps/${app.id}/custom`, toru, {
    action: 'review_commit_approval', decision: 'approve', approvalId: approval.id, version: importedBody.version,
    commitSha, sourceHash: importedBody.commit.sourceHash,
  });
  expect(selfReview.status).toBe(409);

  const review = await send('POST', `/apps/${app.id}/custom`, gina, {
    action: 'review_commit_approval', decision: 'approve', approvalId: approval.id, version: importedBody.version,
    commitSha, sourceHash: importedBody.commit.sourceHash,
  });
  expect(review.status).toBe(200);
  expect((await review.json()).approval.status).toBe('approved');

  const published = await send('POST', `/apps/${app.id}/custom`, toru, {
    action: 'publish_commit', version: importedBody.version, approvalId: approval.id,
  });
  expect(published.status).toBe(200);
  expect((await published.json()).commit.sha).toBe(commitSha);

  const domain = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO hx_app_domains(org_id,app_id,hostname,status,created_by,created_at,updated_at)
    VALUES(?1,?2,'commit-release.example','active','9101',?3,?3)`).bind(ORG, app.id, domain).run();
  const assetUrl = `/app-commit-assets/${app.id}/${commitSha}/${importedBody.commit.assetToken}/app.js`;
  const asset = await call(assetUrl);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toContain('dataset.ready');
  expect(asset.headers.get('x-content-type-options')).toBe('nosniff');

  const stopped = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'unpublish', version: importedBody.version + 1 });
  expect(stopped.status).toBe(200);
  expect((await call(assetUrl)).status).toBe(404);
});

test('HTTP publish rejects branch movement after independent approval', async () => {
  let branch = commitSha;
  vi.stubGlobal('fetch', githubFetch({ branch: undefined }));
  const ghFetch = vi.mocked(fetch);
  ghFetch.mockImplementation((input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/git/ref/heads/main')) return Promise.resolve(json({ object: { sha: branch } }));
    return githubFetch()(input);
  });
  const app = await makeApp();
  const imported = await (await importCommit(app)).json();
  const request = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'request_commit_approval', version: imported.version, commit: imported.commit, sourceHash: imported.commit.sourceHash });
  const approval = (await request.json()).approval;
  const review = await send('POST', `/apps/${app.id}/custom`, gina, {
    action: 'review_commit_approval', decision: 'approve', approvalId: approval.id, version: imported.version,
    commitSha, sourceHash: imported.commit.sourceHash,
  });
  expect(review.status).toBe(200);
  branch = 'f'.repeat(40);
  const publish = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'publish_commit', version: imported.version, approvalId: approval.id });
  expect(publish.status).toBe(409);
});

test('HTTP publish rejects a changed visibility scope and stale app revision', async () => {
  vi.stubGlobal('fetch', githubFetch());
  const app = await makeApp();
  const imported = await (await importCommit(app)).json();
  const request = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'request_commit_approval', version: imported.version, commit: imported.commit, sourceHash: imported.commit.sourceHash });
  const approval = (await request.json()).approval;
  expect((await send('POST', `/apps/${app.id}/custom`, gina, {
    action: 'review_commit_approval', decision: 'approve', approvalId: approval.id, version: imported.version,
    commitSha, sourceHash: imported.commit.sourceHash,
  })).status).toBe(200);

  await env.DB.prepare(`INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?1,?2,'private',1)`).bind(ORG, app.id).run();
  const changedScope = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'publish_commit', version: imported.version, approvalId: approval.id });
  expect(changedScope.status).toBe(409);

  const current = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  const edited = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'draft', version: current.app.version, html: '<p>edited</p>' });
  expect(edited.status).toBe(200);
  const stale = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'publish_commit', version: imported.version, approvalId: approval.id });
  expect(stale.status).toBe(409);
});


test('stores and serves a maximum-size static asset as a D1 BLOB without base64 row expansion', async () => {
  vi.stubGlobal('fetch',githubFetch({html:'<script src="./app.js"></script>',js:'x'.repeat(1_500_000),css:''}));
  const app=await makeApp();
  const imported=await importCommit(app);
  expect(imported.status).toBe(200);
  const data=await imported.json();
  const stored=await env.DB.prepare('SELECT length(content_bytes) AS bytes FROM hx_app_git_assets WHERE org_id=?1 AND app_id=?2 AND path=\'app.js\'').bind(ORG,app.id).first();
  expect(stored).toEqual({bytes:1_500_000});
  const at=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO hx_app_domains(org_id,app_id,hostname,status,created_by,created_at,updated_at)
    VALUES(?1,?2,'max-asset.example','active','9101',?3,?3)`).bind(ORG,app.id,at).run();
  const approval=(await (await send('POST',`/apps/${app.id}/custom`,toru,{action:'request_commit_approval',version:data.version,commit:data.commit,sourceHash:data.commit.sourceHash})).json()).approval;
  expect((await send('POST',`/apps/${app.id}/custom`,gina,{action:'review_commit_approval',decision:'approve',approvalId:approval.id,version:data.version,commitSha,sourceHash:data.commit.sourceHash})).status).toBe(200);
  expect((await send('POST',`/apps/${app.id}/custom`,toru,{action:'publish_commit',version:data.version,approvalId:approval.id})).status).toBe(200);
  const served=await call(`/app-commit-assets/${app.id}/${commitSha}/${data.commit.assetToken}/app.js`);
  expect(served.status).toBe(200);
  expect((await served.arrayBuffer()).byteLength).toBe(1_500_000);
});


test('reviewer membership loss permanently revokes an approval even after access is restored', async () => {
  vi.stubGlobal('fetch',githubFetch());
  const app=await makeApp();
  const imported=await (await importCommit(app)).json();
  const request=await send('POST',`/apps/${app.id}/custom`,toru,{action:'request_commit_approval',version:imported.version,commit:imported.commit,sourceHash:imported.commit.sourceHash});
  const approval=(await request.json()).approval;
  expect((await send('POST',`/apps/${app.id}/custom`,gina,{action:'review_commit_approval',decision:'approve',approvalId:approval.id,version:imported.version,commitSha,sourceHash:imported.commit.sourceHash})).status).toBe(200);
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,'9103').run();
  await upsertMembership(env.DB,ORG,'9103','admin');
  const publish=await send('POST',`/apps/${app.id}/custom`,toru,{action:'publish_commit',version:imported.version,approvalId:approval.id});
  expect(publish.status).toBe(409);
});

test('ordinary saved custom app drafts keep the legacy publish route', async () => {
  const app=await makeApp();
  const draft=await send('POST',`/apps/${app.id}/custom`,toru,{action:'draft',version:app.version,html:'<main>legacy release</main>'});
  expect(draft.status).toBe(200);
  const saved=await draft.json();
  const published=await send('POST',`/apps/${app.id}/custom`,toru,{action:'publish',version:saved.version});
  expect(published.status).toBe(200);
  const state=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
  expect(state.app.definition.custom.published).toBe('<main>legacy release</main>');
});
