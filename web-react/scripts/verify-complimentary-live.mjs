// Runs the public Web login and redemption journey with one disposable account.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
assert.equal(process.env.HONMARU_LIVE_ACCESS_TEST, '1');
const code = readFileSync(0, 'utf8').trim();
assert.ok(code.length >= 8);
const base = 'https://tiktokforwork.torubj0904.workers.dev';
const site = process.env.QA_WEB_URL || 'https://honmaru-web.pages.dev';
const credentials = { email: `web-access-qa-${randomUUID()}@example.invalid`, password: randomUUID(), name: 'Disposable Web QA' };
let account, browser, failed;
const evidence = '/private/tmp/honmaru-complimentary-live';
mkdirSync(evidence, { recursive: true });
const recovery = `${evidence}/recovery-${randomUUID()}.json`;
async function api(path, body, token, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(40000),
    headers: { ...(token ? { 'x-session-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200, path + ' status');
  return response.json();
}
try {
  account = await api('/auth/signup', credentials);
  writeFileSync(recovery, JSON.stringify(account), { mode: 0o600 });
  await api('/me', { notifyEmail: false }, account.token, 'PUT');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(site + '/#/plans');
  await page.getByRole('button', { name: 'I already have an account', exact: true }).click();
  await page.getByRole('button', { name: 'Use a password instead', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const input = page.getByLabel('Access code', { exact: true });
  await input.waitFor({ timeout: 30000 });
  assert.equal(new URL(page.url()).hash, '#/plans');
  await input.fill(code);
  await page.getByRole('button', { name: 'Activate free access', exact: true }).click();
  await page.getByText('Free access is synced. Open the iPhone app and sign in with the same account. The app may take up to 5 minutes to refresh your access.', { exact: true }).waitFor({ timeout: 40000 });
  assert.equal(await input.count(), 0);
  assert.equal(await page.getByText('Pro · Free access', { exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(!(await page.locator('body').innerText()).includes(code));
  await page.screenshot({ path: `${evidence}/activated-mobile.png`, fullPage: true });
  await page.reload();
  await page.getByText('Pro · Free access', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal((await api('/billing/status', null, account.token)).complimentarySyncPending, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ publicPasswordLogin: true, plansDeepLink: true, mobileRedemption: true, iphoneSynced: true, reloadPersists: true, screenshot: evidence + '/activated-mobile.png' }));
} catch (error) { failed = error; }
finally {
  await browser?.close();
  if (account) {
    await api('/account', null, account.token, 'DELETE');
    unlinkSync(recovery);
    console.log('PASS disposable browser account cleaned up');
  }
}
if (failed) throw new Error(failed.message);
