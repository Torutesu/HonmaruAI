import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webBillingLink, webPurchaseBase } from '../src/webBilling.js';
import { signup } from '../src/auth.js';
import worker from '../src/index.js';
let account;
const configured = () => ({ ...env, REVENUECAT_SECRET_KEY: 'test-key', REVENUECAT_WEB_BILLING_ENABLED: 'true', REVENUECAT_WEB_PURCHASE_URL: 'https://pay.rev.cat/production-fixture' });
beforeEach(async () => { account = await signup(env, { email: 'webbuyer@example.com', password: 'password123', name: 'Web Buyer' }); });
afterEach(() => vi.unstubAllGlobals());
test('both endpoints require authentication', async () => {
  for (const path of ['web-checkout', 'manage']) expect((await SELF.fetch(`https://example.com/billing/${path}`, { method: 'POST' })).status).toBe(401);
});
test('disabled or unsafe configurations fail closed', () => {
  expect(webPurchaseBase(env)).toBeNull();
  for (const url of ['https://evil.example/x', 'http://pay.rev.cat/x', 'https://pay.rev.cat/x?app_user_id=victim', 'https://user@pay.rev.cat/x', 'https://pay.rev.cat/x/victim']) expect(webPurchaseBase({ ...configured(), REVENUECAT_WEB_PURCHASE_URL: url })).toBeNull();
});
test('forged account identity and redirect are ignored', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ subscriber: { entitlements: {} } })));
  const response = await worker.fetch(new Request('https://example.com/billing/web-checkout', { method: 'POST', headers: { 'x-session-token': account.token, 'content-type': 'application/json' }, body: JSON.stringify({ app_user_id: 'victim', redirect: 'https://evil.example' }) }), configured(), {});
  expect(response.status).toBe(200);
  expect((await response.json()).url).toBe('https://pay.rev.cat/production-fixture/email%3Awebbuyer%40example.com');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
test('outages and malformed responses do not offer duplicate purchases', async () => {
  for (const response of [new Response('', { status: 503 }), Response.json({ subscriber: {} })]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect((await webBillingLink(configured(), 'email:webbuyer@example.com', 'checkout')).status).toBe(503);
  }
});
test('active or invalid expiry blocks a second purchase', async () => {
  for (const expires_date of [null, 'invalid', '2099-01-01T00:00:00Z']) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ subscriber: { entitlements: { 'honmaruai Pro': { expires_date } } } })));
    expect((await webBillingLink(configured(), 'email:webbuyer@example.com', 'checkout')).status).toBe(409);
  }
});
test('expired subscriptions can repurchase; management redirects must be trusted', async () => {
  const subscriber = { entitlements: { 'honmaruai Pro': { expires_date: '2020-01-01T00:00:00Z' } }, management_url: 'https://billing.stripe.com/p/session/test' };
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ subscriber })));
  expect((await webBillingLink(configured(), 'email:webbuyer@example.com', 'checkout')).status).toBe(200);
  expect((await webBillingLink(configured(), 'email:webbuyer@example.com', 'manage')).url).toBe(subscriber.management_url);
  subscriber.management_url = 'https://evil.example';
  expect((await webBillingLink(configured(), 'email:webbuyer@example.com', 'manage')).status).toBe(409);
});
