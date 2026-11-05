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
async function readReleaseState(appId, approvalId) {
  return env.DB.prepare(`SELECT a.version,json_extract(a.definition,'$.custom.publishedCommitApprovalId') AS publishedApproval,
    p.status AS approvalStatus,p.consumed_at AS consumedAt FROM hx_apps a JOIN hx_app_commit_approvals p ON p.org_id=a.org_id AND p.app_id=a.id
    WHERE a.org_id=?1 AND a.id=?2 AND p.id=?3`).bind(ORG,appId,approvalId).first();
}

async function importCommit(app) {
  const result = await send('POST', `/apps/${app.id}/custom`, toru, {
    action: 'import_commit', owner: 'acme', repo: 'static-app', branch: 'main', commitSha,
  });
  return result;
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\\n/g, ' '));
  await env.DB.exec("CREATE TABLE IF NOT EXISTS hx_app_domain_public_consents (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, hostname TEXT NOT NULL, domain_created_at TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL, confirmation_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(org_id,app_id)); CREATE INDEX IF NOT EXISTS hx_app_domain_public_consents_host ON hx_app_domain_public_consents(hostname,domain_created_at);");
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

  const beforeRelease=await readReleaseState(app.id,approval.id);
  const published = await send('POST', `/apps/${app.id}/custom`, toru, {
    action: 'publish_commit', version: importedBody.version, approvalId: approval.id,
  });
  const releaseState=await readReleaseState(app.id,approval.id);
  if(published.status===409) expect(releaseState).toEqual(beforeRelease);
  expect(published.status, `${await published.clone().text()} state=${JSON.stringify(releaseState)}`).toBe(200);
  expect((await published.json()).commit.sha).toBe(commitSha);
  expect(releaseState).toMatchObject({version:importedBody.version+1,publishedApproval:approval.id,approvalStatus:'published'});
  expect(releaseState.consumedAt).toBeTruthy();
  const replay=await send('POST', `/apps/${app.id}/custom`, toru, {
    action:'publish_commit',version:importedBody.version+1,approvalId:approval.id,
  });
  expect(replay.status).toBe(409);
  expect(await readReleaseState(app.id,approval.id)).toEqual(releaseState);

  const domain = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO hx_app_domains(org_id,app_id,hostname,status,created_by,created_at,updated_at)
    VALUES(?1,?2,'commit-release.example','active','9101',?3,?3)`).bind(ORG, app.id, domain).run();
  await env.DB.prepare(`INSERT INTO hx_app_domain_public_consents(org_id,app_id,hostname,domain_created_at,confirmed_by,confirmed_at,confirmation_version)
    VALUES(?1,?2,'commit-release.example',?3,'9101',?3,1)`).bind(ORG,app.id,domain).run();
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
  const beforeRelease=await readReleaseState(app.id,approval.id);
  const publish = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'publish_commit', version: imported.version, approvalId: approval.id });
  expect(publish.status).toBe(409);
  expect(await readReleaseState(app.id,approval.id)).toEqual(beforeRelease);
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
  const beforeScopeReject=await readReleaseState(app.id,approval.id);
  const changedScope = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'publish_commit', version: imported.version, approvalId: approval.id });
  expect(changedScope.status).toBe(409);
  expect(await readReleaseState(app.id,approval.id)).toEqual(beforeScopeReject);

  const current = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  const edited = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'draft', version: current.app.version, html: '<p>edited</p>' });
  expect(edited.status).toBe(200);
  const beforeStaleReject=await readReleaseState(app.id,approval.id);
  const stale = await send('POST', `/apps/${app.id}/custom`, toru, { action: 'publish_commit', version: imported.version, approvalId: approval.id });
  expect(stale.status).toBe(409);
  expect(await readReleaseState(app.id,approval.id)).toEqual(beforeStaleReject);
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
  await env.DB.prepare(`INSERT INTO hx_app_domain_public_consents(org_id,app_id,hostname,domain_created_at,confirmed_by,confirmed_at,confirmation_version)
    VALUES(?1,?2,'max-asset.example',?3,'9101',?3,1)`).bind(ORG,app.id,at).run();
  const approval=(await (await send('POST',`/apps/${app.id}/custom`,toru,{action:'request_commit_approval',version:data.version,commit:data.commit,sourceHash:data.commit.sourceHash})).json()).approval;
  expect((await send('POST',`/apps/${app.id}/custom`,gina,{action:'review_commit_approval',decision:'approve',approvalId:approval.id,version:data.version,commitSha,sourceHash:data.commit.sourceHash})).status).toBe(200);
  const beforeRelease=await readReleaseState(app.id,approval.id);
  const published=await send('POST',`/apps/${app.id}/custom`,toru,{action:'publish_commit',version:data.version,approvalId:approval.id});
  const releaseState=await readReleaseState(app.id,approval.id);
  if(published.status===409) expect(releaseState).toEqual(beforeRelease);
  expect(published.status, `${await published.clone().text()} state=${JSON.stringify(releaseState)}`).toBe(200);
  expect(releaseState).toMatchObject({version:data.version+1,publishedApproval:approval.id,approvalStatus:'published'});
  expect(releaseState.consumedAt).toBeTruthy();
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

test('custom domain consent is bound to its attachment and exposes only after explicit confirmation', async () => {
  const app=await makeApp();
  const draft=await send('POST',`/apps/${app.id}/custom`,toru,{action:'draft',version:app.version,html:'<main>public app snapshot</main>'});
  const saved=await draft.json();
  expect((await send('POST',`/apps/${app.id}/custom`,toru,{action:'publish',version:saved.version})).status).toBe(200);
  await env.DB.prepare(`INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?1,?2,'private',1)`).bind(ORG,app.id).run();

  const hostname='private-data.example';
  const route=`/apps/${app.id}/hosting`;
  const domainEnv={...env,CF_ACCOUNT_ID:'test-account',CF_PAGES_PROJECT:'honmaru-web',PAGES_DOMAINS_API_TOKEN:'test-token'};
  const domainCall=(path,init={})=>worker.fetch(new Request('https://example.com'+path,init),domainEnv);
  const domainSend=(body,token=toru)=>domainCall(route,{method:'POST',headers:headers(token),body:JSON.stringify({orgId:ORG,...body})});
  const unconfirmed=await domainSend({action:'attach',hostname});
  expect(unconfirmed.status).toBe(409);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_domain_public_consents WHERE org_id=?1 AND app_id=?2').bind(ORG,app.id).first()).toEqual({n:0});

  vi.stubGlobal('fetch',vi.fn(async input=>{
    const request=input instanceof Request?input:new Request(String(input));
    const url=new URL(request.url);
    if(url.hostname==='api.cloudflare.com'){
      if(request.method==='GET')return json({success:true,result:[]});
      if(request.method==='POST')return json({success:true,result:{status:'active',validation_data:{status:'success'},verification_data:{status:'success'}}});
      if(request.method==='DELETE')return json({success:true,result:{}});
    }
    return new Response('Unexpected upstream request.',{status:502});
  }));
  const attached=await domainSend({action:'attach',hostname,publicDataConfirmed:true});
  expect(attached.status).toBe(200);
  const domain=(await attached.json()).domain;
  const receipt=await env.DB.prepare('SELECT hostname,domain_created_at AS domainCreatedAt,confirmed_by AS confirmedBy,confirmed_at AS confirmedAt,confirmation_version AS confirmationVersion FROM hx_app_domain_public_consents WHERE org_id=?1 AND app_id=?2').bind(ORG,app.id).first();
  expect(receipt).toMatchObject({hostname,confirmedBy:'9101',confirmationVersion:1});
  expect(receipt.domainCreatedAt).toBe(domain.createdAt);
  const resolverCandidate=await env.DB.prepare(`SELECT d.status,d.hostname,d.created_at AS createdAt,c.domain_created_at AS consentCreatedAt,
    c.confirmation_version AS consentVersion,json_extract(a.definition,'$.custom.published') AS published
    FROM hx_app_domains d JOIN hx_app_domain_public_consents c ON c.org_id=d.org_id AND c.app_id=d.app_id AND c.hostname=d.hostname
      AND c.domain_created_at=d.created_at AND c.confirmation_version=1 JOIN hx_apps a ON a.org_id=d.org_id AND a.id=d.app_id
    WHERE d.hostname=?1`).bind(hostname).first();
  expect(resolverCandidate, 'resolver eligibility diagnostic').toBeTruthy();
  expect(resolverCandidate.status).toBe('active');
  const published=await domainCall(`/app-domains/resolve?host=${hostname}`);
  expect(published.status, await published.clone().text()).toBe(200);
  expect(await published.text()).toContain('public app snapshot');

  expect((await domainSend({action:'remove'})).status).toBe(200);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_domain_public_consents WHERE org_id=?1 AND app_id=?2').bind(ORG,app.id).first()).toEqual({n:0});
  expect((await domainCall(`/app-domains/resolve?host=${hostname}`)).status).toBe(404);
  expect((await domainSend({action:'attach',hostname})).status).toBe(409);
});
