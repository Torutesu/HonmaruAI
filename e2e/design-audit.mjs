// Every screen, at every width, as a person would see it — the input to a
// design pass. Runs against the same stack as spec.mjs:
//
//     E2E_SPEC=e2e/design-audit.mjs ./e2e/run.sh
//
// Writes /tmp/design-shots/<width>-<screen>.png (override with DESIGN_SHOTS).
import { chromium } from '../web-react/node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'

const WEB = 'http://127.0.0.1:4173'
const SINK = 'http://127.0.0.1:9099'
const OUT = process.env.DESIGN_SHOTS || '/tmp/design-shots'
mkdirSync(OUT, { recursive: true })
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'small-laptop', width: 1024, height: 768 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide', width: 1920, height: 1080 },
]

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: ['--no-sandbox'],
})

async function codeFor(email, { after = 0 } = {}) {
  for (let i = 0; i < 40; i++) {
    const sent = await (await fetch(`${SINK}/sent`)).json()
    const mine = sent.filter((m) => (m.to || []).includes(email))
    if (mine.length > after) {
      const match = (mine[mine.length - 1].text || '').match(/\b\d{6}\b/)
      if (match) return match[0]
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no sign-in code was emailed to ${email}`)
}

const shot = (p, name, opts = {}) => p.screenshot({ path: `${OUT}/${name}.png`, ...opts })

// Signed out, at every width: the welcome and the sign-in form.
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height } })
  const p = await ctx.newPage()
  await p.goto(WEB, { waitUntil: 'load' })
  await p.waitForSelector('text=Get started', { timeout: 15000 })
  await shot(p, `${w.width}-00-welcome`)
  await p.click('text=Get started')
  await p.waitForSelector('#email')
  await shot(p, `${w.width}-01-signup`)
  await ctx.close()
}

// One account, made on a phone, then reopened at every width.
const email = `design-${Date.now()}@example.com`
const first = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await first.newPage()
await page.goto(WEB, { waitUntil: 'load' })
await page.click('text=Get started')
await page.waitForSelector('#email')
await page.fill('#name', 'Toru')
await page.fill('#email', email)
await page.click('text=Email me a code')
await page.waitForSelector('.otp-boxes', { timeout: 15000 })
await shot(page, `1440-02-code`)
await page.click('.otp-box >> nth=0')
await page.keyboard.type(await codeFor(email), { delay: 40 })
await page.waitForSelector('.ob-art', { timeout: 20000 })
await shot(page, `1440-03-onboarding-1`)
await page.click('text=Next'); await page.waitForSelector('.ob-art-route')
await shot(page, `1440-04-onboarding-2`)
await page.click('text=Next'); await page.waitForSelector('.ob-demo')
await shot(page, `1440-05-onboarding-3`)
await page.click('text=Set me up'); await page.waitForSelector('.radio')
await shot(page, `1440-06-onboarding-4`)
await page.click('text=Open my feed')
await page.waitForSelector('.dot.on', { timeout: 25000 })

// A few cards, so the feed has something to show.
const asks = [
  'approve the new supplier price for the cafe, +8% from Friday',
  'ask the designer to sign off on the new menu photography by Thursday',
  'urgent: decide whether we close the Shibuya shop on the 30th for the inspection',
  'review the Q4 hiring plan for the kitchen, two cooks and one barista',
]
for (const text of asks) {
  await page.keyboard.press('n')
  await page.waitForSelector('.create-decision textarea, .create-decision input', { timeout: 10000 })
  const box = (await page.$('.create-decision textarea')) || (await page.$('.create-decision input'))
  await box.fill(text)
  await page.click('.create-decision button:not(.mic):has-text("Send"), .create-decision .btn-primary')
  await page.waitForTimeout(1500)
  await page.keyboard.press('Escape')
}
await page.waitForTimeout(1500)
const state = await first.storageState()

for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height }, storageState: state })
  const p = await ctx.newPage()
  const go = async (hash, marker, name, full = false) => {
    await p.goto(`${WEB}/${hash}`, { waitUntil: 'load' })
    await p.waitForSelector(marker, { timeout: 20000 }).catch(() => {})
    await p.waitForTimeout(1200)
    await shot(p, `${w.width}-${name}`, { fullPage: full })
  }
  await go('#/feed', '.card, .inbox', '10-feed')
  await go('#/list', '.classic, .list', '11-list', true)
  await go('#/history', '.screen, .rows', '12-history', true)
  await go('#/team', '.team-name', '13-team', true)
  await go('#/you', '.profile-stats', '14-you', true)
  await go('#/tools', '.screen', '15-tools', true)
  await go('#/insights', '.screen', '16-insights', true)
  await go('#/feed', '.card, .inbox', '17-feed-again')
  await p.keyboard.press('n')
  await p.waitForSelector('.create-decision', { timeout: 10000 }).catch(() => {})
  await p.waitForTimeout(500)
  await shot(p, `${w.width}-18-compose`)
  await p.keyboard.press('Escape')
  if (w.width >= 1080) {
    await p.keyboard.press('Control+k')
    await p.waitForSelector('.palette-input', { timeout: 5000 }).catch(() => {})
    await p.waitForTimeout(400)
    await shot(p, `${w.width}-19-palette`)
    await p.keyboard.press('Escape')
  }
  await ctx.close()
}
await browser.close()
console.log(`design shots in ${OUT}`)
