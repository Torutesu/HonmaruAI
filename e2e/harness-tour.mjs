// The harness screens, against the real stack (docs/kylon-gap-plan.md).
//
//     E2E_SPEC=e2e/harness-tour.mjs ./e2e/run.sh
//
// Signs up through the Worker's own email code, turns the workspace into a
// harness, builds an app and a workflow through the API, then opens every
// harness screen in a browser at laptop and phone widths and photographs it.
// A step that throws, or a screen that logs a page error, fails the run.

import { chromium } from '../web-react/node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'
import { setModeScript } from '../apps/desktop/src/links.js'

const WEB = 'http://127.0.0.1:4173'
const SINK = 'http://127.0.0.1:9099'
const API = 'http://127.0.0.1:8787'
const SHOTS = process.env.E2E_SHOTS || '/tmp/e2e-shots/harness'
mkdirSync(SHOTS, { recursive: true })

let failures = 0
const results = []
async function step(name, fn) {
  try { await fn(); results.push(`  ok    ${name}`) } catch (err) { failures += 1; results.push(`  FAIL  ${name}\n        ${String(err).split('\n').slice(0, 3).join('\n        ')}`) }
}

async function codeFor(email) {
  for (let i = 0; i < 40; i++) {
    const sent = await (await fetch(`${SINK}/sent`)).json()
    const mine = sent.filter((m) => (m.to || []).includes(email))
    const match = mine.length && (mine[mine.length - 1].text || '').match(/\b\d{6}\b/)
    if (match) return match[0]
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no code for ${email}`)
}

const email = `harness-${Date.now()}@example.com`
await fetch(`${API}/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
const signed = await (await fetch(`${API}/auth/otp/verify`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, code: await codeFor(email), name: 'Toru' }),
})).json()
const { token, orgId } = signed
const login = signed.login || signed.userId
if (!token || !orgId) throw new Error(`sign-up failed: ${JSON.stringify(signed)}`)
const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-session-token': token }, body: body ? JSON.stringify({ orgId, ...body }) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.message || ''}`)
  return data
}

let invoices, crm
await step('the workspace becomes a harness, with apps and a workflow in it', async () => {
  await api('PUT', '/orgs/mode', { mode: 'harness' })
  invoices = (await api('POST', '/apps', { template: 'invoices', channel: 'b:ops' })).app
  crm = (await api('POST', '/apps', { template: 'crm' })).app
  const rows = (await api('GET', `/tables/${invoices.tableId}?orgId=${encodeURIComponent(orgId)}`)).rows
  await api('PATCH', `/tables/${invoices.tableId}/rows/${rows[0].id}`, { values: { Due: '2026-09-01', Status: 'Overdue' } })
  await api('POST', '/workflows', {
    name: 'Chase overdue invoices',
    trigger: { type: 'row', tableId: invoices.tableId, on: 'changed', where: { Status: ['Overdue'] } },
    steps: [
      { type: 'post', channel: 'b:ops', text: '{{row.Client}} is overdue on {{row.Invoice #}}.' },
      { type: 'approval', to: login, title: 'Send {{row.Client}} a reminder?', summary: '{{row.Amount}} overdue' },
    ],
  })
  await api('POST', '/skills', { name: 'Dunning', description: 'How we chase a late invoice', body: 'Day 7: a polite nudge. Day 14: a call.' })
  // A second overdue row starts the workflow, which waits on an approval.
  await api('PATCH', `/tables/${invoices.tableId}/rows/${rows[1].id}`, { values: { Status: 'Sent' } })
  await api('PATCH', `/tables/${invoices.tableId}/rows/${rows[1].id}`, { values: { Status: 'Overdue' } })
})

const browser = await chromium.launch({
  ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}),
  args: ['--headless=new'],
})

for (const [label, viewport] of [['laptop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  await ctx.addInitScript(([t, u, o, h]) => {
    localStorage.setItem('sessionToken', t); localStorage.setItem('userId', u)
    localStorage.setItem('orgId', o); localStorage.setItem('host', h)
  }, [token, login, orgId, '127.0.0.1:8787'])
  const page = await ctx.newPage()
  const thrown = []
  page.on('pageerror', (e) => thrown.push(String(e).slice(0, 200)))
  const shot = (name) => page.screenshot({ path: `${SHOTS}/${label}-${name}.png`, fullPage: false })
  const visit = async (hash, selector) => {
    await page.goto(`${WEB}/${hash}`, { waitUntil: 'load' })
    await page.waitForSelector(selector, { timeout: 15000 })
    await page.waitForTimeout(400)
  }

  await step(`${label}: the rail offers Apps and Harness in a harness workspace`, async () => {
    await page.goto(WEB, { waitUntil: 'load' })
    if (label === 'laptop') await page.waitForSelector('[data-tab="apps"]', { timeout: 20000 })
    else await page.waitForSelector('.tabbar, .cl-tabs', { timeout: 20000 })
    await shot('00-home')
  })
  await step(`${label}: a harness workspace opens on its home: what waits on me, the apps' numbers, how workflows ran`, async () => {
    await page.goto(WEB, { waitUntil: 'load' })
    await page.waitForSelector('[data-screen="home"] [data-home-app]', { timeout: 20000 })
    await page.waitForSelector('[data-screen="home"] [data-card]')
    await page.waitForTimeout(400)
    await shot('00b-home')
  })
  await step(`${label}: the hub switches the mode and leads everywhere`, async () => {
    await visit('#/harness', '[data-open="apps"]')
    await shot('01-hub')
  })
  await step(`${label}: apps, and one opened as a table, a board and its numbers`, async () => {
    await visit('#/apps', `[data-app="${invoices.id}"]`)
    await shot('02-apps')
    await page.click(`[data-app="${invoices.id}"]`)
    await page.waitForSelector('.hx-table', { timeout: 10000 })
    await shot('03-app-table')
    await page.click('.hx-tabs button >> nth=1')
    await page.waitForSelector('.hx-board')
    await shot('04-app-board')
    await page.click('.hx-tabs button >> nth=2')
    await page.waitForSelector('.hx-metric')
    const overdue = await page.$$eval('.hx-metric', (els) => els.map((e) => e.textContent))
    if (!overdue.some((t) => /Overdue/.test(t) && /[12]/.test(t))) throw new Error(`metrics read ${JSON.stringify(overdue)}`)
    await shot('05-app-metrics')
  })
  await step(`${label}: workflows, the builder, and a run waiting on approval`, async () => {
    await visit('#/workflows', '[data-workflow]')
    await shot('06-workflows')
    await page.click('[data-workflow]')
    await page.waitForSelector('[data-run]')
    const status = await page.textContent('[data-run] .hx-status')
    if (!/waiting|承認待ち/.test(status || '')) throw new Error(`the run reads ${status}`)
    await shot('07-workflow-runs')
    await page.click('.screen .back.hx-back')
    await page.waitForSelector('[data-workflow]')
    await page.click('.hx-head-actions .pill-btn')
    await page.waitForSelector('.hx-builder')
    await shot('08-workflow-builder')
  })
  await step(`${label}: approvals list what waits on me`, async () => {
    await visit('#/approvals', '[data-card]')
    await shot('09-approvals')
  })
  await step(`${label}: skills and the agent team`, async () => {
    await visit('#/skills', '[data-skill]')
    await shot('10-skills')
    await visit('#/agent-team', '.hx-screen')
    await shot('11-agent-team')
  })
  if (label === 'laptop') {
    await step('laptop: the desktop menu switches the workspace to Simple and back, through the hub', async () => {
      const modeNow = async () => (await (await fetch(`${API}/orgs/mode?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': token } })).json()).mode
      const until = async (want) => { for (let i = 0; i < 40; i++) { if (await modeNow() === want) return; await page.waitForTimeout(250) } throw new Error(`the mode never became ${want}`) }
      await visit('#/feed', '.tabbar')
      // The hub closed: the request is left for it, and it opens.
      await page.evaluate(setModeScript('simple'))
      await until('simple')
      await page.waitForSelector('[data-mode="simple"][aria-checked="true"]')
      await shot('12-switched-simple')
      // The hub open: the request is handed to it.
      await page.evaluate(setModeScript('harness'))
      await until('harness')
      // Switched to Harness, the workspace's home opens.
      await page.waitForSelector('[data-screen="home"]')
    })
  }
  await step(`${label}: no page errors`, async () => { if (thrown.length) throw new Error(thrown.join('\n')) })
  await ctx.close()
}

await browser.close()
console.log(`\nHarness tour\n${results.join('\n')}\n\nscreenshots: ${SHOTS}`)
process.exit(failures ? 1 : 0)
