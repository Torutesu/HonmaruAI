// Explicit production qualification using only disposable ordinary accounts.
// The access code is read from stdin and never printed, placed in a URL, or saved.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

assert.equal(process.env.HONMARU_LIVE_ACCESS_TEST, '1', 'Explicit live test opt-in required');
const base = process.env.QA_API_URL || 'https://tiktokforwork.torubj0904.workers.dev';
const code = readFileSync(0, 'utf8').trim();
assert.ok(code.length >= 8, 'Provide the access code via stdin');
const key = readFileSync(new URL('../../Config/Base.xcconfig', import.meta.url), 'utf8').match(/^REVENUECAT_API_KEY\s*=\s*(appl_\w+)/m)?.[1];
assert.ok(key, 'Public SDK key required');
const recovery = `/private/tmp/honmaru-access-qa-${randomUUID()}.json`;
const accounts = [];
const results = {};
let failed;
async function api(path, token, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(40000),
    headers: { ...(token ? { 'x-session-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
async function sdk(id) {
  const response = await fetch('https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, 'Public SDK customer lookup');
  return (await response.json()).subscriber;
}
function active(customer) {
  const entitlement = customer.entitlements['honmaruai Pro'];
  return Boolean(entitlement && (entitlement.expires_date === null || Date.parse(entitlement.expires_date) > Date.now()));
}
async function signup(email) {
  const credentials = { email: email || `access-qa-${randomUUID()}@example.invalid`, password: randomUUID(), name: 'Disposable access QA' };
  const response = await api('/auth/signup', null, credentials);
  assert.equal(response.status, 200, 'Disposable account signup');
  const account = { ...response.data, credentials };
  accounts.push(account);
  writeFileSync(recovery, JSON.stringify(accounts), { mode: 0o600 });
  assert.equal((await api('/me', account.token, { notifyEmail: false }, 'PUT')).status, 200);
  return account;
}
try {
  const owner = await signup();
  const other = await signup();
  results.signup = true;
  assert.equal((await api('/billing/redeem', null, { code })).status, 401);
  assert.equal((await api('/billing/redeem', owner.token, { code: 'invalid-qa-code' })).status, 400);
  assert.equal((await api('/billing/status', owner.token)).data.pro, false);
  results.invalidCode = true;
  const redeemed = await api('/billing/redeem', owner.token, { code, userId: other.userId });
  assert.equal(redeemed.status, 200, 'Redemption must confirm both Web and iPhone access');
  assert.equal(redeemed.data.complimentary, true);
  assert.equal(redeemed.data.complimentarySyncPending, false);
  assert.equal(redeemed.data.remainingToday, null);
  results.redeemed = true;
  const customer = await sdk(owner.userId);
  assert.equal(active(customer), true, 'Published iOS SDK must see active Pro');
  const entitlement = customer.entitlements['honmaruai Pro'];
  assert.equal(customer.subscriptions[entitlement.product_identifier].store, 'promotional');
  assert.equal(Date.parse(entitlement.expires_date), Date.parse('2226-01-01T00:00:00Z'));
  results.publishedSDKPro = true;
  assert.equal(active(await sdk(other.userId)), false);
  assert.equal((await api('/billing/status', other.token)).data.pro, false);
  results.accountIsolation = true;
  assert.equal((await api('/billing/redeem', owner.token, { code })).status, 200);
  const login = await api('/auth/login', null, owner.credentials);
  assert.equal(login.status, 200);
  assert.equal((await api('/billing/status', login.data.token)).data.complimentary, true);
  results.relogin = true;
  assert.equal((await api('/account', owner.token, null, 'DELETE')).status, 200);
  owner.deleted = true;
  assert.equal(active(await sdk(owner.userId)), false, 'Account deletion must revoke its promotional access');
  assert.equal((await api('/me', login.data.token)).status, 401);
  results.providerRevocation = true;
  const recreated = await signup(owner.credentials.email);
  assert.equal(recreated.userId, owner.userId);
  assert.equal((await api('/billing/status', recreated.token)).data.pro, false);
  results.recreationIsFree = true;
} catch (error) { failed = error; }
finally {
  let clean = true;
  for (const account of [...accounts].reverse()) {
    if (account.deleted) continue;
    try {
      assert.equal((await api('/account', account.token, null, 'DELETE')).status, 200);
      account.deleted = true;
      assert.equal((await api('/me', account.token)).status, 401);
    } catch { clean = false; }
  }
  results.cleanup = clean;
  if (clean) unlinkSync(recovery);
  else console.error('Cleanup recovery file retained: ' + recovery);
  console.log(JSON.stringify(results));
  if (!clean) throw new Error('Disposable account cleanup incomplete');
}
if (failed) throw new Error(failed.message);
