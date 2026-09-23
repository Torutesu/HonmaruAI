import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://127.0.0.1:3013';
const server = await createServer({ root, define: { 'import.meta.env.VITE_API_HOST': JSON.stringify('127.0.0.1:3013') }, server: { host: '127.0.0.1', port: 3013, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => { if (!sessionStorage.getItem('boot')) { localStorage.setItem('onboarded', 'yes'); sessionStorage.setItem('boot', 'yes') } });
  let putCalls = 0, sessionStatus = 200, lastBody; const savedBodies = []; let holdSession = false, heldSession, inviteCalls = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/signup') return route.fulfill({ json: { token: 'onboarding-test-token', login: 'new-user', userId: 'email:new-user', orgId: 'org' } });
    if (url.pathname === '/invites/accept') { inviteCalls++; return route.fulfill({ json: { orgId: 'new-team' } }); }
    if (url.pathname === '/me') {
      if (route.request().method() === 'GET' && holdSession) { heldSession = route; return; }
      if (route.request().method() === 'PUT') { putCalls++; lastBody = route.request().postDataJSON(); savedBodies.push(lastBody); return route.fulfill({ status: putCalls === 1 ? 503 : 200, json: {} }); }
      return route.fulfill({ status: sessionStatus, json: { login: 'new-user', userId: 'email:new-user', orgId: 'org', orgs: [{ id: 'org', role: 'admin' }] } });
    }
    if (url.pathname === '/billing/status') return route.fulfill({ json: { pro: false, purchasable: true, dailyLimit: 3, usedToday: 0, remainingToday: 3, complimentaryAvailable: true } });
    if (url.pathname.startsWith('/auth/') || ['/health', '/vapid-public-key'].includes(url.pathname)) return route.fulfill({ json: {} });
    if (url.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  await page.goto(origin + '/#/plans');
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await page.getByRole('button', { name: 'Use a password instead', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('new-user@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('private-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: /^Engineer/ }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
  await page.reload();
  await page.getByRole('button', { name: 'Open my feed', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Engineer/ }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Open my feed', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'We could not save that.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open my feed', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Open my feed', exact: true }).click();
  await page.getByLabel('Access code', { exact: true }).waitFor();
  assert.ok(savedBodies.some(body => body.role === 'engineer' && body.locale === 'en' && body.orgId === 'org'));
  assert.equal(new URL(page.url()).hash, '#/plans');
  await page.reload();
  await page.getByLabel('Access code', { exact: true }).waitFor();
  sessionStatus = 503;
  await page.reload();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sessionToken')), 'onboarding-test-token');
  sessionStatus = 200;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByLabel('Access code', { exact: true }).waitFor();
  sessionStatus = 401;
  await page.reload();
  await page.getByRole('button', { name: 'Get started', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sessionToken')), null);
  await page.evaluate(() => { localStorage.setItem('sessionToken', 'onboarding-test-token'); localStorage.setItem('userId', 'new-user'); localStorage.setItem('orgId', 'old-team'); });
  holdSession = true; sessionStatus = 200;
  await page.goto(origin + '/?invite-qa=1#/join/0123456789abcdef0123456789abcdef');
  for (let count = 0; !heldSession && count < 100; count++) await page.waitForTimeout(20);
  assert.ok(heldSession, 'Session restore is held');
  assert.equal(inviteCalls, 0, 'Invite acceptance must wait for session restoration');
  holdSession = false;
  await heldSession.fulfill({ json: { login: 'new-user', userId: 'email:new-user', orgs: [{ id: 'old-team' }, { id: 'new-team' }] } });
  await page.getByRole('status').filter({ hasText: 'You joined the team.' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('orgId')), 'new-team');
  console.log('PASS invite waits for restoration; account-scoped onboarding, refresh draft recovery, failed-save retry, persisted completion, plan deep-link, transient session retry and expired-session clearing');
} finally { await browser?.close(); await server.close(); }
