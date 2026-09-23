// Local browser regressions. APIs are mocked; no real codes or purchases.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const free = { pro: false, purchasable: true, dailyLimit: 3, usedToday: 1, remainingToday: 2, complimentaryAvailable: true, complimentary: false }
const granted = { ...free, pro: true, remainingToday: null, complimentary: true, accessSource: 'complimentary' }
const pendingGrant = { ...granted, complimentarySyncPending: true }
const server = await createServer({
  root,
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: { host: '127.0.0.1', port: 3012, strictPort: true },
  plugins: [{
    name: 'billing-test-harness',
    resolveId(id) { if (id === 'virtual:billing-harness') return '\0billing-harness' },
    load(id) {
      if (id !== '\0billing-harness') return
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Plans } from '/src/screens/Plans.tsx';
        import { changeLocale } from '/src/utils/i18n.ts';
        import '/src/theme.css';
        import '/src/screens/screens.css';
        const root = createRoot(document.getElementById('root'));
        window.showAccount = (sessionToken) => root.render(React.createElement(Plans, { httpBase: location.origin, sessionToken, onClose: () => root.render(null) }));
        window.changeLocale = changeLocale;
        window.showAccount('first');
      `
    },
    configureServer(vite) {
      vite.middlewares.use('/__billing_test', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/__billing_test', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:billing-harness"></script></body></html>'))
      })
    },
  }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort()
    return route.continue()
  })
  let pendingRedemption, pendingStatus, redemptions = 0
  let delayStatusFor = null
  let failStatusFor = null
  const accountStatus = new Map(), statusReads = new Map()
  await page.route('**/billing/status', async (route) => {
    const account = route.request().headers()['x-session-token']
    statusReads.set(account, (statusReads.get(account) || 0) + 1)
    if (account === delayStatusFor) { pendingStatus = route; return }
    if (account === failStatusFor) return route.fulfill({ status: 503, json: { message: 'private-fixture' } })
    await route.fulfill({ json: accountStatus.get(account) || free })
  })
  await page.route('**/billing/redeem', async (route) => {
    redemptions++
    assert.equal(route.request().method(), 'POST')
    assert.equal(route.request().postDataJSON().code, 'private-fixture')
    assert(!route.request().url().includes('private-fixture'))
    pendingRedemption = route
  })
  const waitFor = async (condition) => {
    const end = Date.now() + 5000
    while (!condition()) {
      if (Date.now() > end) throw new Error('Timed out waiting for mocked request')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const show = async (account) => {
    const before = statusReads.get(account) || 0
    await page.evaluate((token) => window.showAccount(token), account)
    await waitFor(() => (statusReads.get(account) || 0) > before)
  }
  const input = () => page.getByLabel('Access code', { exact: true })
  const submit = () => page.getByRole('button', { name: 'Activate free access', exact: true })
  await page.goto('http://127.0.0.1:3012/__billing_test')
  await input().waitFor()
  assert.equal(await submit().isDisabled(), true)
  assert.equal(await page.getByText(/3-day free trial|\$10|\$15|Business/).count(), 0)
  await input().fill('private-fixture')
  await page.getByRole('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await waitFor(() => pendingRedemption)
  assert.equal(redemptions, 1, 'Repeated submit made duplicate requests')
  assert.equal(await input().isDisabled(), true)
  await pendingRedemption.fulfill({ status: 400, json: { message: 'private-fixture' } })
  await page.getByRole('alert').filter({ hasText: 'That access code is not valid.' }).waitFor()
  assert(!(await page.locator('body').innerText()).includes('private-fixture'), 'Error exposed the code')

  // A status retry must finish before a new code POST can race its old Free reply.
  delayStatusFor = 'first'; pendingStatus = null
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await waitFor(() => pendingStatus)
  assert.equal(await input().isDisabled(), true)
  assert.equal(await submit().isDisabled(), true)
  await page.getByRole('form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(redemptions, 1, 'A code POST started while a stale status GET was pending')
  delayStatusFor = null
  await pendingStatus.fulfill({ json: free })
  await submit().waitFor()
  await page.waitForFunction(() => !document.querySelector('#complimentary-access-code').disabled)

  pendingRedemption = null
  await submit().click()
  await waitFor(() => pendingRedemption)
  await show('second')
  await input().waitFor()
  assert.equal(await input().inputValue(), '')
  await pendingRedemption.fulfill({ json: granted }).catch(() => {})
  await page.waitForTimeout(100)
  assert.equal(await page.getByText('Pro · Free access', { exact: true }).count(), 0, 'Old response unlocked another account')

  delayStatusFor = 'third'
  await show('third')
  await waitFor(() => pendingStatus)
  await show('fourth')
  await input().waitFor()
  await pendingStatus.fulfill({ json: granted }).catch(() => {})
  await page.waitForTimeout(100)
  assert.equal(await page.getByText('Pro · Free access', { exact: true }).count(), 0, 'Old status leaked to another account')

  pendingRedemption = null
  await input().fill('private-fixture')
  await submit().click()
  await waitFor(() => pendingRedemption)
  await pendingRedemption.fulfill({ json: granted })
  await page.getByText('Pro · Free access', { exact: true }).waitFor()
  assert.equal(await input().count(), 0)
  assert.equal(await page.getByText('Lifetime access. No payment or renewal.', { exact: true }).count(), 1)
  assert.equal(await page.getByRole('status').filter({ hasText: 'does not cancel an existing Apple subscription' }).count(), 1)
  await page.evaluate(() => window.changeLocale('ja'))
  await page.getByText('Pro・無料アクセス', { exact: true }).waitFor()
  const output = '/tmp/honmaruai-billing-qa'
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: `${output}/complimentary-mobile-ja.png`, fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)

  // A successful local grant can remain pending in the installed iPhone app.
  await page.evaluate(() => window.changeLocale('en'))
  await show('sync-pending')
  await input().waitFor()
  pendingRedemption = null
  await input().fill('private-fixture')
  await submit().click()
  await waitFor(() => pendingRedemption)
  accountStatus.set('sync-pending', pendingGrant)
  await pendingRedemption.fulfill({ status: 503, json: { ...pendingGrant, message: 'private-fixture' } })
  const retrySync = () => page.getByRole('button', { name: 'Retry iPhone sync', exact: true })
  await retrySync().waitFor()
  await waitFor(() => statusReads.get('sync-pending') >= 2)
  assert.equal(await input().count(), 0, 'A durable grant must not require another code')
  await page.getByText('Pro is ready on the web. We are still syncing free access to the iPhone app.', { exact: true }).waitFor()
  assert(!(await page.locator('body').innerText()).includes('private-fixture'))
  failStatusFor = 'sync-pending'
  await retrySync().click()
  await page.getByRole('alert').filter({ hasText: 'Could not load plans.' }).waitFor()
  assert.equal(await page.getByText('Pro · Free access', { exact: true }).count(), 1)
  assert.equal(await retrySync().count(), 1, 'Sync retry disappeared after a grant/status failure')
  failStatusFor = null
  accountStatus.set('sync-pending', { ...granted, complimentarySyncPending: false })
  await retrySync().click()
  await page.getByText('Free access is synced. Open the iPhone app and sign in with the same account. The app may take up to 5 minutes to refresh your access.', { exact: true }).waitFor()
  assert.equal(await retrySync().count(), 0)

  // Older 503 replies have no grant body: recover durable state with a GET.
  await show('legacy-sync-pending')
  await input().waitFor()
  pendingRedemption = null
  await input().fill('private-fixture')
  await submit().click()
  await waitFor(() => pendingRedemption)
  accountStatus.set('legacy-sync-pending', pendingGrant)
  await pendingRedemption.fulfill({ status: 503, json: { message: 'private-fixture' } })
  await retrySync().waitFor()
  assert.equal(await input().count(), 0)
  assert.equal(await page.getByRole('alert').count(), 0)
  await page.evaluate(() => window.changeLocale('ja'))
  await page.getByRole('button', { name: 'iPhoneへの同期を再試行', exact: true }).waitFor()
  await page.screenshot({ path: `${output}/complimentary-sync-pending-mobile-ja.png`, fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert(!(await page.locator('body').innerText()).includes('private-fixture'))
  assert.deepEqual(errors, [])
  console.log('PASS private code form, duplicate submit, safe errors, status retry blocks racing redemption, account isolation, pending iPhone sync after HTTP 503, retry after status failure, confirmed sync, legacy 503 recovery, cancellation notice, Japanese mobile layout')
} finally {
  await browser?.close()
  await server.close()
}
