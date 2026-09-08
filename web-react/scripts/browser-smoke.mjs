// Runs only against a disposable local Worker + web server. No production data.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.WEB_QA_URL || 'http://127.0.0.1:3000'
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Browser QA requires a local disposable environment')
const output = process.env.WEB_QA_OUTPUT || '/tmp/honmaruai-web-qa/screenshots'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light' })
const page = await context.newPage()
const errors = []
await context.route('**/*', (route) => {
  const url = new URL(route.request().url())
  if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    errors.push(`Blocked non-local request during local QA: ${url.origin}`)
    return route.abort('blockedbyclient')
  }
  return route.continue()
})
page.on('pageerror', (error) => errors.push(error.message))
const checks = []
const passed = (name) => { checks.push(name); console.log(`PASS ${name}`) }
const waitFor = async (condition, message) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error(message)
}
const screenshot = (name) => page.screenshot({ path: `${output}/${name}.png` })
try {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  await screenshot('auth-desktop')
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  await page.getByLabel('Full name').fill('Release Review')
  await page.getByLabel('Email address').fill(`web-release-${Date.now()}@example.invalid`)
  await page.getByLabel('Password', { exact: true }).fill('Local-QA-only-2026!')
  await page.getByRole('button', { name: 'Create your account', exact: true }).click()
  await page.getByRole('heading', { name: 'You’re all caught up.' }).waitFor()
  await waitFor(() => page.getByText('Live updates connected', { exact: true }).isVisible(), 'Authenticated socket never became ready')
  passed('Sign up, authenticated WebSocket join, and honest empty state')
  await screenshot('inbox-empty-desktop')
  await page.getByRole('button', { name: 'New request', exact: true }).click()
  await page.getByLabel('What needs to happen?').fill('Please approve the launch brief by Friday. Budget: $2,400 · Owner: Release Review')
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  await waitFor(async () => await page.getByRole('dialog').count() === 0, 'Composer did not receive delivery confirmation')
  await page.locator('.page-title').waitFor()
  assert.equal(await page.locator('.page-inner').count(), 1)
  passed('Route request, persist created card, acknowledge delivery, and show incoming card')
  await screenshot('inbox-decision-desktop')
  await page.locator('.account-button').click()
  await page.getByRole('dialog', { name: 'You', exact: true }).waitFor()
  await page.keyboard.press('a')
  assert.equal(await page.locator('.page-inner').count(), 1)
  assert.equal(await page.locator('[data-workspace][inert]').count(), 2)
  await page.keyboard.press('Escape')
  passed('Modal sheets disable feed shortcuts and background focus')
  const decisionPage = page.locator('.page').first()
  await decisionPage.dispatchEvent('pointerdown', { isPrimary: true, button: 0, pointerId: 1, clientX: 100, clientY: 300 })
  await decisionPage.dispatchEvent('pointermove', { isPrimary: true, pointerId: 1, clientX: 250, clientY: 302 })
  await decisionPage.dispatchEvent('pointercancel', { isPrimary: true, pointerId: 1, clientX: 250, clientY: 302 })
  assert.equal(await page.locator('.page-inner').count(), 1)
  passed('Canceled swipe does not submit a decision')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.getByRole('heading', { name: 'You’re all caught up.' }).waitFor()
  await page.locator('.workspace-nav').getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('dialog', { name: 'Decided', exact: true }).waitFor()
  await page.getByText('Decision: approve').waitFor()
  passed('Approve is persisted and appears in decision history')
  await page.getByRole('button', { name: '↩ Roll back', exact: true }).click()
  await waitFor(async () => await page.getByRole('dialog').locator('.decision-card').count() === 0, 'Undo did not return card to pending')
  await page.keyboard.press('Escape')
  await page.locator('.page-title').waitFor()
  passed('Undo restores the pending card via live state')
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshot('inbox-decision-mobile')
  const geometry = await page.evaluate(() => {
    const body = document.documentElement
    const actions = document.querySelector('.page-actions').getBoundingClientRect()
    const composer = document.querySelector('.compose-fab').getBoundingClientRect()
    return { overflow: body.scrollWidth > innerWidth, bottom: actions.bottom, composerTop: composer.top, viewport: innerHeight }
  })
  assert.equal(geometry.overflow, false, 'Mobile has horizontal overflow')
  assert(geometry.bottom <= geometry.composerTop, 'Floating composer covers decision actions')
  passed('Mobile has no horizontal overflow or composer/action overlap')
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await screenshot('inbox-decision-mobile-dark')
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.getByLabel('Your reply', { exact: true }).fill('Reviewed. Please include the final checklist.')
  await page.getByRole('button', { name: 'Send reply', exact: true }).click()
  await page.getByRole('heading', { name: 'You’re all caught up.' }).waitFor()
  passed('Reply is persisted and removes the card from pending')
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click()
  await page.getByRole('button', { name: 'The record Every decision, per business' }).click()
  await page.getByText('Replied', { exact: false }).first().waitFor()
  passed('Shared decision record loads the persisted reply')
  await page.keyboard.press('Escape')
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'You’re all caught up.' }).waitFor()
  passed('Session and completed state survive reload')
  await page.getByRole('button', { name: 'Tell your AI', exact: true }).click()
  await page.getByLabel('What needs to happen?').fill('Share this update with the team: the weekly report is ready.')
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  await page.locator('.kind-notification').waitFor()
  await page.locator('.page-title').click()
  await page.keyboard.press('a')
  await page.getByRole('heading', { name: 'You’re all caught up.' }).waitFor()
  passed('Notification keyboard action acknowledges instead of approving')
  let releaseRoute
  let routeStarted = false
  const routeRelease = new Promise((resolve) => { releaseRoute = resolve })
  await page.route('**/ai/route', async (route) => {
    const response = await route.fetch()
    routeStarted = true
    await routeRelease
    await route.fulfill({ response }).catch(() => {})
  })
  await page.getByRole('button', { name: 'Tell your AI', exact: true }).click()
  await page.getByLabel('What needs to happen?').fill('Please approve this deliberately delayed local test request.')
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  await waitFor(async () => routeStarted, 'The delayed route was never requested')
  await page.keyboard.press('Escape')
  releaseRoute()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await page.locator('.page-inner').count(), 0)
  passed('Closing a pending composer cancels delivery before the route returns')
  await page.unroute('**/ai/route')
  assert.deepEqual(errors, [], 'Browser runtime errors occurred')
  passed('No browser runtime errors')
  await writeFile(`${output}/checks.json`, JSON.stringify({ checkedAt: new Date().toISOString(), environment: 'Local Worker, disposable D1, Chromium', checks }, null, 2))
} catch (error) {
  await screenshot('failure').catch(() => {})
  console.error((await page.locator('body').innerText().catch(() => '')).slice(-3000))
  throw error
} finally { await browser.close() }
