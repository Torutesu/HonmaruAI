// The things that go wrong on a Windows office PC and nowhere else, against
// the real stack (./e2e/run.sh with E2E_SPEC=e2e/windows.mjs). CI runs it on
// a Windows runner in Microsoft Edge; anywhere else it runs in Chromium.
//
// - The Enter that confirms a Japanese conversion must not send the message,
//   and Esc that cancels one must not close what it was typed in.
// - Shortcuts are Ctrl, not ⌘.
// - At 1366×768, the most common office laptop, nothing spills sideways.

import { chromium } from '../web-react/node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WEB = 'http://127.0.0.1:4173'
const SINK = 'http://127.0.0.1:9099'
const SHOTS = process.env.E2E_SHOTS || join(tmpdir(), 'e2e-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
let failures = 0
async function step(name, fn) {
  try {
    await fn()
    results.push(`  ok    ${name}`)
  } catch (err) {
    failures += 1
    results.push(`  FAIL  ${name}\n        ${String(err).split('\n').filter((l) => l.trim()).slice(0, 4).join('\n        ')}`)
  }
}

async function codeFor(email) {
  for (let i = 0; i < 60; i++) {
    const sent = await (await fetch(`${SINK}/sent`)).json()
    const mine = sent.filter((m) => (m.to || []).includes(email))
    const match = mine.length && (mine[mine.length - 1].text || '').match(/\b\d{6}\b/)
    if (match) return match[0]
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no sign-in code was emailed to ${email}`)
}

// Edge where there is one (E2E_CHANNEL=msedge on the Windows runner), the
// machine's own Chromium where the image ships one, Playwright's otherwise.
const browser = await chromium.launch({
  ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}),
})
console.log(`browser: ${process.env.E2E_CHANNEL || 'chromium'} ${browser.version()} on ${process.platform}`)
const thrown = []

// Signed up the way the main spec does it (on a phone-sized window, the path
// it has always taken), then used on a laptop.
const email = `e2e-win-${Date.now()}@example.com`
const phone = await browser.newContext({ viewport: { width: 390, height: 844 } })
let d
await step('a person signs up', async () => {
  const p = await phone.newPage()
  await p.goto(WEB, { waitUntil: 'load' })
  await p.click('text=Get started')
  await p.waitForSelector('#email')
  await p.fill('#name', 'Windows Person')
  await p.fill('#email', email)
  await p.click('text=Email me a code')
  await p.waitForSelector('.otp-boxes', { timeout: 15000 })
  await p.click('.otp-box >> nth=0')
  await p.keyboard.type(await codeFor(email), { delay: 40 })
  await p.waitForSelector('.ob-art', { timeout: 20000 })
  await p.click('text=Next'); await p.waitForSelector('.ob-art-route')
  await p.click('text=Next'); await p.waitForSelector('.ob-demo')
  await p.click('text=Set me up'); await p.waitForSelector('.radio')
  await p.click('.screen-foot .btn-primary:has-text("Next")'); await p.waitForSelector('.ob-daily input[type="time"]', { timeout: 15000 })
  await p.click('text=Keep these times and continue')
  await p.waitForSelector('[data-onboarding="notifications"]')
  await p.click('.screen-foot .btn-primary')
  await p.waitForSelector('[data-connected="1"]', { state: 'attached', timeout: 25000 })
  const laptop = await browser.newContext({ storageState: await phone.storageState(), viewport: { width: 1366, height: 768 } })
  d = await laptop.newPage()
  d.on('pageerror', (e) => thrown.push(String(e).slice(0, 200)))
})

const channel = 'Windows check'
await step('a channel opens on a 1366×768 laptop, and nothing spills sideways', async () => {
  await d.goto(`${WEB}/#/list`, { waitUntil: 'load' })
  await d.waitForSelector('.slk-side', { timeout: 20000 })
  await d.click('.cl-add')
  await d.fill('.cl-add-form input', channel)
  await d.keyboard.press('Enter')
  await d.waitForSelector(`.cl-thread:has-text("${channel}")`, { timeout: 15000 })
  await d.click(`.cl-thread:has-text("${channel}") .cl-open`)
  await d.waitForSelector(`.slk-head h1:has-text("${channel}")`, { timeout: 10000 })
  const wide = await d.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (wide > 1) throw new Error(`the page scrolls sideways by ${wide}px`)
})

/// A keydown the way an input method sends it: Chrome and Edge mark the Enter
/// that confirms a conversion `isComposing`, with keyCode 229; Safari leaves
/// only the 229. Dispatched rather than typed, because a headless browser
/// has no input method to drive.
const imeKey = (selector, key, isComposing) => d.$eval(selector, (el, [k, flag]) => {
  const ev = new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true, isComposing: flag })
  Object.defineProperty(ev, 'keyCode', { get: () => 229 })
  Object.defineProperty(ev, 'which', { get: () => 229 })
  el.dispatchEvent(ev)
}, [key, isComposing])

const half = '日本語で書いている途中'
await step('the Enter that confirms a Japanese conversion does not send', async () => {
  await d.fill('.slk-input', half)
  await imeKey('.slk-input', 'Enter', true)
  await d.waitForTimeout(1200)
  if (await d.$(`.slk-msg:has-text("${half}")`)) throw new Error('the message went out while it was still being converted')
  const left = await d.$eval('.slk-input', (el) => el.value)
  if (left !== half) throw new Error(`the composer lost what was being typed: "${left}"`)
})

await step('nor does the one Safari leaves behind after a conversion', async () => {
  await imeKey('.slk-input', 'Enter', false)
  await d.waitForTimeout(1200)
  if (await d.$(`.slk-msg:has-text("${half}")`)) throw new Error('a keyCode 229 Enter sent the message')
})

await step('a plain Enter sends it, in Japanese, as written', async () => {
  await d.fill('.slk-input', '日本語のメッセージ：会議は15時から')
  await d.keyboard.press('Enter')
  await d.waitForSelector('.slk-msg:has-text("会議は15時から")', { timeout: 10000 })
    .catch(() => { throw new Error('Enter did not send the message') })
  // The message can arrive over the live connection a moment before the send
  // returns and the composer is cleared: wait for that, not for a snapshot.
  await d.waitForFunction(() => document.querySelector('.slk-input')?.value === '', null, { timeout: 5000 })
    .catch(async () => { throw new Error(`the composer kept "${await d.$eval('.slk-input', (el) => el.value)}" after sending`) })
  await d.screenshot({ path: join(SHOTS, 'win-01-channel-ja.png') })
})

await step('Ctrl+K opens search, and Esc during a conversion does not close it', async () => {
  await d.keyboard.press('Control+k')
  await d.waitForSelector('.palette-input', { timeout: 5000 })
    .catch(() => { throw new Error('Ctrl+K did not open search') })
  await d.fill('.palette-input', 'かいぎ')
  await imeKey('.palette-input', 'Escape', true)
  await d.waitForTimeout(500)
  if (!(await d.$('.palette-input'))) throw new Error('Esc that cancels a conversion closed search')
  await d.screenshot({ path: join(SHOTS, 'win-02-palette.png') })
  await d.keyboard.press('Escape')
  await d.waitForSelector('.palette-input', { state: 'detached', timeout: 5000 })
    .catch(() => { throw new Error('a plain Esc did not close search') })
})

await step('nothing threw in the browser', async () => {
  if (thrown.length) throw new Error(thrown.slice(0, 3).join(' | '))
})

await browser.close()
console.log(`\nWindows checks (${process.platform}):\n${results.join('\n')}\n`)
if (failures) {
  console.log(`${failures} failed`)
  process.exit(1)
}
