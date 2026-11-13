import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';

// A custom domain serves a published Custom App and its records to anyone,
// with no expiry. Public links already need the app owner or a workspace
// admin; a domain must need the same authority (issue #958).

const ORG = 'team:domain-authority';
const hostname = 'tracker.example';
let maker, editor, admin, app;
const domainEnv = { ...env, CF_ACCOUNT_ID: 'test-account', CF_PAGES_PROJECT: 'honmaru-web', PAGES_DOMAINS_API_TOKEN: 'test-token' };
const headers = (token) => ({ 'content-type': 'application/json', 'x-session-token': token });
const call = (path, init = {}) => worker.fetch(new Request('https://example.com' + path, init), domainEnv);
const send = (path, token, body) => call(path, { method: 'POST', headers: headers(token), body: JSON.stringify({ orgId: ORG, ...body }) });
const hosting = (token, body) => send(`/apps/${app.id}/hosting`, token, body);
const resolve = () => call(`/app-domains/resolve?host=${hostname}`);
const count = async (table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?1 AND app_id=?2`).bind(ORG, app.id).first()).n;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await env.DB.exec("CREATE TABLE IF NOT EXISTS hx_app_domain_public_consents (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, hostname TEXT NOT NULL, domain_created_at TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL, confirmation_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(org_id,app_id));");
  for (const [id, login, role] of [['9201', 'maker', 'member'], ['9202', 'editor', 'member'], ['9203', 'admin', 'admin']]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: 'en' });
    await upsertMembership(env.DB, ORG, id, role);
  }
  maker = await createSession(env.DB, '9201', 'gho-maker');
  editor = await createSession(env.DB, '9202', 'gho-editor');
  admin = await createSession(env.DB, '9203', 'gho-admin');
  const created = await send('/apps', maker, { name: 'Customers', columns: [{ name: 'Name', type: 'text' }] });
  expect(created.status, await created.clone().text()).toBe(201);
  app = (await created.json()).app;
  // Publish an inline Custom App directly; the publish flow has its own tests.
  await env.DB.prepare(`UPDATE hx_apps SET definition=json_set(COALESCE(definition,'{}'),'$.custom',json('{"published":"<main>customer list</main>"}')) WHERE org_id=?1 AND id=?2`).bind(ORG, app.id).run();
  await env.DB.prepare(`INSERT INTO hx_app_person_access(org_id,app_id,user_github_id,permission,updated_at) VALUES(?1,?2,'9202','edit',?3)`).bind(ORG, app.id, new Date().toISOString()).run();
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = new URL(input && typeof input === 'object' && 'url' in input ? input.url : String(input));
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (url.hostname === 'api.cloudflare.com') {
      if (method === 'GET') return Response.json({ success: true, result: [] });
      if (method === 'POST') return Response.json({ success: true, result: { status: 'active', validation_data: { status: 'success' }, verification_data: { status: 'success' } } });
      if (method === 'DELETE') return Response.json({ success: true, result: {} });
    }
    return new Response('Unexpected upstream request.', { status: 502 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

test('an app editor cannot attach a custom domain, just as they cannot create a public link', async () => {
  const shares = await send(`/apps/${app.id}/public-shares`, editor, { confirmDataExposure: true, version: app.version, accessVersion: 0 });
  expect(shares.status).toBe(403);
  const attached = await hosting(editor, { action: 'attach', hostname, publicDataConfirmed: true });
  expect(attached.status).toBe(403);
  expect(await count('hx_app_domains')).toBe(0);
  expect(await count('hx_app_domain_public_consents')).toBe(0);
  expect((await resolve()).status).toBe(404);
  // Editors keep the rest of hosting: reading it and managing variables.
  expect((await call(`/apps/${app.id}/hosting?orgId=${ORG}`, { headers: headers(editor) })).status).toBe(200);
});

test('the owner and an admin attach and detach as before, with a disclosure receipt', async () => {
  expect((await hosting(maker, { action: 'attach', hostname })).status).toBe(409);
  const attached = await hosting(maker, { action: 'attach', hostname, publicDataConfirmed: true });
  expect(attached.status, await attached.clone().text()).toBe(200);
  expect(await env.DB.prepare('SELECT confirmed_by AS by FROM hx_app_domain_public_consents WHERE org_id=?1 AND app_id=?2').bind(ORG, app.id).first()).toEqual({ by: '9201' });
  const page = await resolve();
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('customer list');
  // Removing a domain only narrows exposure, so an editor may still do it.
  expect((await hosting(editor, { action: 'remove' })).status).toBe(200);
  expect((await resolve()).status).toBe(404);

  const byAdmin = await hosting(admin, { action: 'attach', hostname, publicDataConfirmed: true });
  expect(byAdmin.status, await byAdmin.clone().text()).toBe(200);
  expect((await resolve()).status).toBe(200);
});

test('a domain stops serving when its confirmer may no longer make the app public', async () => {
  // A domain an editor attached before the owner-or-admin rule existed.
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO hx_app_domains(org_id,app_id,hostname,status,created_by,created_at,updated_at) VALUES(?1,?2,?3,'active','9202',?4,?4)").bind(ORG, app.id, hostname, at),
    env.DB.prepare("INSERT INTO hx_app_domain_public_consents(org_id,app_id,hostname,domain_created_at,confirmed_by,confirmed_at,confirmation_version) VALUES(?1,?2,?3,?4,'9202',?4,1)").bind(ORG, app.id, hostname, at),
  ]);
  expect((await resolve()).status).toBe(404);
  // The same receipt held by an admin serves, and stops once they are demoted.
  await env.DB.prepare("UPDATE hx_app_domain_public_consents SET confirmed_by='9203' WHERE org_id=?1 AND app_id=?2").bind(ORG, app.id).run();
  expect((await resolve()).status).toBe(200);
  await upsertMembership(env.DB, ORG, '9203', 'member');
  expect((await resolve()).status).toBe(404);
});
