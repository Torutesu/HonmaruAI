// What a person actually does, against the real thing.
//
// No fake relay, no injected WebSocket, no seeded localStorage: the browser
// signs up with a code it reads out of the message the Worker sent, lands in
// the feed, tells its AI something, and the decision comes back. Every screen
// is visited and photographed at both sizes on the way past.
//
// Failures are loud and specific — the point of this file is to be the thing
// that finds them before anyone else does.

import { chromium } from '../web-react/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const WEB = 'http://127.0.0.1:4173'
const SINK = 'http://127.0.0.1:9099'
const SHOTS = process.env.E2E_SHOTS || '/tmp/e2e-shots'
mkdirSync(SHOTS, { recursive: true })

const results = []
let failures = 0

async function step(name, fn, { after } = {}) {
  try {
    await fn()
    results.push(`  ok    ${name}`)
  } catch (err) {
    failures += 1
    results.push(`  FAIL  ${name}\n        ${String(err).split('\n')[0]}`)
  } finally {
    // A step that changes global state has to put it back even when it
    // fails, or every step after it fails for a reason that is not its own.
    if (after) await after().catch(() => {})
  }
}

/// The code the Worker put in an email, for the address given. Polls, because
/// the send happens while the request is in flight.
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

/// Type a code the way a person does: one digit at a time, into the box that
/// has focus. `fill` on the first box relies on the paste path and did not
/// always reach React, which made the test flaky rather than the product.
async function typeCode(p, code) {
  await p.click('.otp-box >> nth=0')
  await p.keyboard.type(code, { delay: 40 })
  // Six digits submit themselves. If they have not after a moment, press the
  // button, so a failure here means the flow is broken and not merely slow.
  await p.waitForTimeout(600)
  // Only if we are still here: six digits usually submit themselves, and a
  // click landing after the screen has changed presses whatever took its
  // place — which silently skipped an onboarding page and made the next
  // assertion look like a product failure.
  if (await p.$('.otp-boxes')) {
    const button = await p.$('.screen .btn-primary:not([disabled])')
    if (button) await button.click().catch(() => {})
  }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  ignoreDefaultArgs: ['--headless=old'],
  args: ['--headless=new'],
})

// One person, signing up from scratch, on a phone.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const page = await phone.newPage()
const thrown = []
page.on('pageerror', (e) => thrown.push(String(e).slice(0, 200)))

// Console errors do not carry the URL that caused them, and this deployment
// legitimately answers 503 on endpoints whose credentials it does not have.
// So watch responses instead: then "which request failed" is a fact rather
// than a guess, and an expected refusal can be told from a broken screen.
const badResponses = []
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`)
})

// What this configuration is *supposed* to refuse: connectors need a Composio
// key, web push needs a VAPID pair, and the screens for both say so out loud.
const EXPECTED_REFUSALS = [/^503 \/connectors/, /^503 \/push\/vapid/]

const email = `e2e-${Date.now()}@example.com`
let mate
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` })

await step('the welcome screen loads', async () => {
  await page.goto(WEB, { waitUntil: 'load' })
  await page.waitForSelector('text=Get started', { timeout: 15000 })
  await shot('01-welcome')
})

// The first thing anyone sees on a laptop, signed out. It was offset by the
// width of a navigation rail that does not exist until you are signed in,
// which left a bare white column down the left edge of the window.
await step('the welcome screen is not offset by a rail that is not there', async () => {
  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const w = await wide.newPage()
  await w.goto(WEB, { waitUntil: 'load' })
  await w.waitForSelector('.welcome', { timeout: 15000 })
  await w.waitForTimeout(400)
  await w.screenshot({ path: `${SHOTS}/20-desktop-welcome.png` })
  const gap = await w.evaluate(() => {
    const el = document.querySelector('.screen.welcome')
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), width: Math.round(r.width) }
  })
  if (gap.left > 1) throw new Error(`the welcome screen starts ${gap.left}px in from the left`)
  // And the column inside it is centred rather than pinned to an edge.
  const column = await w.evaluate(() => {
    const r = document.querySelector('.welcome-body').getBoundingClientRect()
    return { mid: Math.round(r.left + r.width / 2), centre: Math.round(window.innerWidth / 2) }
  })
  if (Math.abs(column.mid - column.centre) > 24) {
    throw new Error(`the welcome column sits at ${column.mid}, not near the centre ${column.centre}`)
  }
  await wide.close()
})

await step('an email gets a code sent to it', async () => {
  await page.click('text=Get started')
  await page.waitForSelector('#email')
  await page.fill('#name', 'E2E Person')
  await page.fill('#email', email)
  await shot('02-signup')
  await page.click('text=Email me a code')
  await page.waitForSelector('.otp-boxes', { timeout: 15000 })
  await shot('03-otp')
})

let code
await step('the code that arrives signs the person in', async () => {
  code = await codeFor(email)
  await typeCode(page, code)
  // Six digits submit themselves; onboarding is what comes next for a new account.
  await page.waitForSelector('.ob-art', { timeout: 20000 })
  await shot('04-onboarding-1')
})

await step('a wrong code is refused', async () => {
  // A second account, so the first one's session is untouched.
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const p2 = await other.newPage()
  const addr = `e2e-bad-${Date.now()}@example.com`
  await p2.goto(WEB, { waitUntil: 'load' })
  await p2.click('text=Get started')
  await p2.fill('#email', addr)
  await p2.click('text=Email me a code')
  await p2.waitForSelector('.otp-boxes')
  const real = await codeFor(addr)
  const wrong = real === '000000' ? '111111' : '000000'
  await typeCode(p2, wrong)
  await p2.waitForSelector('.form-error', { timeout: 15000 })
  await other.close()
})

await step('onboarding runs to the end and saves', async () => {
  await page.click('text=Next')
  await page.waitForSelector('.ob-art-route')
  await page.click('text=Next')
  await page.waitForSelector('.ob-demo')
  await page.click('[aria-label="Approve"]')
  await shot('05-onboarding-swiped')
  await page.click('text=Set me up')
  await page.waitForSelector('.radio')
  await shot('06-onboarding-role')
  await page.click('text=Open my feed')
  await page.waitForSelector('.tabbar', { timeout: 20000 })
  await shot('07-feed-empty')
})

await step('the relay is connected', async () => {
  await page.waitForSelector('.dot.on', { timeout: 20000 })
})

await step('telling your AI something produces a decision', async () => {
  await page.click('[data-tab="compose"]')
  await page.waitForSelector('.sheet-bottom')
  const box = await page.$('.create-decision input')
  if (!box) throw new Error('the compose sheet has no text field')
  await box.fill('Approve the new supplier price for the cafe')
  await shot('08-compose')
  const send = await page.$('.create-decision button')
  if (!send) throw new Error('the compose sheet has no send button')
  await send.click()
  // The keyword router has no teammates in a one-person org, so the card comes
  // back to the person who asked. Either way a card must appear.
  await page.waitForSelector('.card-title', { timeout: 25000 })
  await shot('09-card')
})

await step('the decision can be taken, and it sticks', async () => {
  await page.click('.decide.approve')
  await page.waitForTimeout(1200)
  await shot('10-after-decision')
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('.tabbar', { timeout: 20000 })
  // Approved, so it is off the pending feed and in history.
  await page.click('[data-tab="history"]')
  await page.waitForSelector('.seg', { timeout: 10000 })
  const text = await page.evaluate(() => document.body.innerText)
  if (!/Approved|承認/.test(text)) throw new Error('the decision is not in history after a reload')
  await shot('11-history')
})

await step('every other screen opens', async () => {
  await page.click('.screen .back')
  for (const [label, marker, name] of [
    ['tools', '.rows', '12-tools'],
    ['you', '.profile-stats', '13-profile'],
  ]) {
    await page.click(`nav [data-tab="${label}"]`)
    await page.waitForSelector(marker, { timeout: 10000 })
    await shot(name)
    await page.click('.screen .back')
  }
  await page.click('nav [data-tab="you"]')
  await page.click('text=Notifications')
  await page.waitForSelector('.switch', { timeout: 10000 })
  await shot('14-notifications')
  await page.click('.screen .back')
  await page.click('nav [data-tab="you"]')
  await page.click('text=Plan')
  await page.waitForSelector('.plan-card, .empty', { timeout: 10000 })
  await shot('15-plans')
})

await step('nothing threw in the browser', async () => {
  if (thrown.length) throw new Error(`uncaught: ${thrown.slice(0, 3).join(' | ')}`)
})

await step('no request failed that was not meant to', async () => {
  const unexpected = [...new Set(badResponses)].filter(
    (r) => !EXPECTED_REFUSALS.some((ok) => ok.test(r))
  )
  if (unexpected.length) throw new Error(unexpected.join(' ; '))
})

await step('an unconfigured connector is said out loud, not hidden', async () => {
  // Close whatever is open, however many layers, and get back to the feed.
  for (let i = 0; i < 3; i++) {
    const close = await page.$('.screen .back')
    if (!close) break
    await close.click()
    await page.waitForTimeout(300)
  }
  await page.waitForSelector('nav [data-tab="tools"]', { timeout: 10000 })
  await page.click('nav [data-tab="tools"]')
  await page.waitForSelector('.screen .head-title:has-text("Tools")', { timeout: 10000 })
  await shot('16-tools-unconfigured')
  const text = await page.evaluate(() => document.querySelector('.screen').innerText)
  if (!/not switched on|No connectors/i.test(text)) {
    throw new Error(`the Tools screen does not say connectors are unavailable: ${text.slice(0, 120)}`)
  }
})

// The setting the complaint named: choosing 日本語 wrote the preference and
// changed nothing on the screen, because only card content was ever
// translated. Switching it must repaint the interface, and switching back
// must return it — a one-way door would be worse than none.
await step('choosing a language changes the interface, and changing back returns it', async () => {
  for (let i = 0; i < 3; i++) {
    const close = await page.$('.screen .back')
    if (!close) break
    await close.click()
    await page.waitForTimeout(300)
  }
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })

  const pick = async (value) => {
    const select = await page.$('select[aria-label="Language"], select[aria-label="言語"]')
    if (!select) throw new Error('the language picker is not on the You screen')
    await select.selectOption(value)
    await page.waitForTimeout(600)
  }

  await pick('ja')
  await shot('17-japanese')
  const ja = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    screen: document.querySelector('.screen')?.innerText || '',
    rail: [...document.querySelectorAll('nav .tab')].map((b) => b.getAttribute('aria-label')).join(' '),
  }))
  if (ja.lang !== 'ja') throw new Error(`<html lang> stayed "${ja.lang}"`)
  // Kana or kanji on the screen is the whole point; without it the setting
  // is still doing nothing visible.
  if (!/[ぁ-んァ-ン一-龯]/.test(ja.screen)) {
    throw new Error(`the You screen is still English: ${ja.screen.slice(0, 120)}`)
  }
  if (!/[ぁ-んァ-ン一-龯]/.test(ja.rail)) {
    throw new Error(`the tab bar is still English: ${ja.rail}`)
  }

  // Every screen, not just this one: a single untranslated screen is exactly
  // the kind of thing that survives a spot check.
  await page.click('.screen .back')
  await page.waitForTimeout(300)
  for (const [label, marker] of [['history', '.seg'], ['tools', '.rows'], ['you', '.profile-stats']]) {
    await page.click(`nav [data-tab="${label}"]`)
    await page.waitForSelector(marker, { timeout: 10000 })
    const text = await page.evaluate(() => document.querySelector('.screen').innerText)
    // Ignore the parts no language owns: the address, brand names, and digits.
    const words = text
      .replace(/[\w.+-]+@[\w.-]+/g, ' ')
      .replace(/\b(Gmail|Slack|Notion|GitHub|AI|Honmaru|Pro|E2E Person)\b/g, ' ')
      .replace(/[^\p{L}]/gu, '')
    const japanese = (words.match(/[ぁ-んァ-ヶ一-龯]/g) || []).length
    if (japanese < words.length * 0.5) {
      throw new Error(`${label} is mostly untranslated in 日本語: ${text.replace(/\n/g, ' ').slice(0, 140)}`)
    }
    await page.click('.screen .back')
    await page.waitForTimeout(300)
  }
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })

  await pick('en');
  const back = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    screen: document.querySelector('.screen')?.innerText || '',
  }))
  if (back.lang !== 'en') throw new Error(`<html lang> stayed "${back.lang}"`)
  if (!/Language|Role/.test(back.screen)) {
    throw new Error(`English did not come back: ${back.screen.slice(0, 120)}`)
  }
  await page.click('.screen .back')
  await page.waitForTimeout(300)
}, {
  after: async () => {
    // Whatever happened above, the app goes back to English and to the feed.
    await page.evaluate(() => localStorage.setItem('locale', 'en'))
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.tabbar', { timeout: 20000 })
  },
})

// The same account, on a laptop. This is the size the design was not drawn for
// and the one the complaint was about, so it is signed in and photographed
// rather than glanced at from the welcome screen.
let desk
await step('the app is usable on a laptop', async () => {
  // The session this run just created, carried over — a laptop showing the
  // welcome screen proves nothing about the feed.
  desk = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: await phone.storageState(),
  })
  const d = await desk.newPage()
  await d.goto(WEB, { waitUntil: 'load' })
  await d.waitForSelector('.tabbar', { timeout: 20000 })
  await d.waitForTimeout(1200)
  await d.screenshot({ path: `${SHOTS}/20-desktop-empty.png` })

  // A feed with nothing in it proves nothing about the feed. Compose one from
  // the laptop, which also puts the compose sheet on this size under test.
  await d.click('[data-tab="compose"]')
  await d.waitForSelector('.create-decision input')
  await d.fill('.create-decision input', 'Ask the designer to review the new card layout')
  await d.click('.create-decision button')
  await d.waitForSelector('.card-title', { timeout: 25000 })
  await d.waitForTimeout(600)
  await d.screenshot({ path: `${SHOTS}/20-desktop-feed.png` })
  // Nothing may sit outside the viewport horizontally, and nothing may be
  // cut off at the top — both of which is what "表示崩れ" looked like.
  const overflow = await d.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.left < -1 || r.right > window.innerWidth + 1 || r.top < -1) {
        bad.push(`${el.className || el.tagName} @ ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
    }
    return bad.slice(0, 6)
  })
  if (overflow.length) throw new Error(`off-screen on a laptop: ${overflow.join(' ; ')}`)

  // Navigation has to be reachable with a pointer, which on a laptop means
  // labelled and to the side rather than a row of glyphs under the thumb.
  const rail = await d.$('.tabbar')
  const box = await rail.boundingBox()
  if (!box || box.width > 400 || box.height < 400) {
    throw new Error(`the tab bar is not a rail on a laptop: ${JSON.stringify(box)}`)
  }
  const labelled = await d.evaluate(() =>
    [...document.querySelectorAll('.tab')].every((t) => {
      const after = getComputedStyle(t, '::after').content
      return after && after !== 'none' && after !== '""'
    })
  )
  if (!labelled) throw new Error('the rail buttons have no words on them')
})

await step('the other screens hold up on a laptop', async () => {
  const d = desk.pages()[0]
  for (const [label, marker, name] of [
    ['history', '.seg', '21-desktop-history'],
    ['you', '.profile-stats', '22-desktop-profile'],
  ]) {
    await d.click(`nav [data-tab="${label}"]`)
    await d.waitForSelector(marker, { timeout: 10000 })
    await d.screenshot({ path: `${SHOTS}/${name}.png` })
    // The rail stays: a screen is a place in the app, not a takeover.
    const railVisible = await d.evaluate(() => {
      const el = document.querySelector('.tabbar')
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.left < 10
    })
    if (!railVisible) throw new Error(`the rail disappears on ${label}`)
    await d.click('.screen .back')
    await d.waitForTimeout(400)
  }
  await desk.close()
})

// The claim the whole product rests on: two people, and a card that crosses
// between them without either of them touching a channel. Everything before
// this is one person talking to their own AI, which proves the plumbing but
// not the point.
await step('a second person joins by invite and the card reaches them', async () => {
  for (let i = 0; i < 3; i++) {
    const close = await page.$('.screen .back')
    if (!close) break
    await close.click()
    await page.waitForTimeout(300)
  }

  // A mints a code for an engineer.
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await page.click('text=Invite a teammate')
  // The invite is a sheet over the You screen, not a screen of its own, so
  // its controls are inside .sheet — .screen would find the Role picker
  // underneath it instead.
  await page.waitForSelector('.sheet .invite select', { timeout: 10000 })
  await page.selectOption('.sheet .invite select', 'engineer')
  await page.click('.sheet .invite .btn-primary')
  await page.waitForSelector('.sheet .invite-code', { timeout: 15000 })
  await shot('18-invite')
  const invite = (await page.textContent('.sheet .invite-code')).trim()
  if (!invite) throw new Error('no invite code was minted')
  // The code is 32 hex characters and was set like a six-digit PIN, so it ran
  // out of its box and pushed the Copy button clean off the screen. Nothing
  // in a sheet may sit outside the viewport.
  const spill = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('.sheet *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.left < -1 || r.right > window.innerWidth + 1) {
        bad.push(`${el.className || el.tagName} @ ${Math.round(r.left)} ${Math.round(r.width)}w`)
      }
    }
    return bad.slice(0, 5)
  })
  if (spill.length) throw new Error(`the invite sheet spills off the phone: ${spill.join(' ; ')}`)
  await page.click('.sheet .close')
  await page.waitForTimeout(400)

  // B signs up with it, in their own browser.
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } })
  mate = second
  const b = await second.newPage()
  const mateEmail = `e2e-mate-${Date.now()}@example.com`
  await b.goto(WEB, { waitUntil: 'load' })
  await b.click('text=Get started')
  await b.waitForSelector('#email')
  await b.fill('#name', 'Kenji')
  await b.fill('#email', mateEmail)
  await b.fill('#invite', invite)
  await b.click('text=Email me a code')
  await b.waitForSelector('.otp-boxes', { timeout: 15000 })
  await typeCode(b, await codeFor(mateEmail))
  await b.waitForSelector('.ob-art', { timeout: 20000 })
  await b.click('text=Next'); await b.waitForSelector('.ob-art-route')
  await b.click('text=Next'); await b.waitForSelector('.ob-demo')
  await b.click('text=Set me up'); await b.waitForSelector('.radio')
  await b.click('text=Open my feed')
  await b.waitForSelector('.dot.on', { timeout: 25000 })

  // A tells their AI something meant for the engineer.
  await page.click('nav [data-tab="compose"]')
  await page.waitForSelector('.sheet-bottom textarea, .sheet-bottom input', { timeout: 10000 })
  const box = (await page.$('.sheet-bottom textarea')) || (await page.$('.sheet-bottom input'))
  await box.fill('ask the engineer to fix the booking form before Friday')
  await page.click('.sheet-bottom .btn-primary, .sheet-bottom button:has-text("Send")')

  // …and it turns up in B's feed, on its own, without a reload.
  await b.waitForSelector('.card', { timeout: 25000 })
  await b.screenshot({ path: `${SHOTS}/19-mate-received.png` })
  const seen = await b.evaluate(() => document.querySelector('.card').innerText)
  if (/booking/i.test(seen) === false) {
    throw new Error(`the card that arrived is not the one that was sent: ${seen.slice(0, 140)}`)
  }
  // And it does not arrive wearing an account id.
  if (/u:|email:|@example\.com/.test(seen)) {
    throw new Error(`the card shows a raw account id: ${seen.slice(0, 140)}`)
  }
  for (let i = 0; i < 4; i++) {
    const close = await page.$('.sheet .close, .screen .back')
    if (!close) break
    await close.click().catch(() => {})
    await page.waitForTimeout(300)
  }
})

if (mate) await mate.close()
await browser.close()

const report = results.join('\n')
writeFileSync(`${SHOTS}/report.txt`, report)
console.log('\n' + report)
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`} — screenshots in ${SHOTS}`)
process.exit(failures === 0 ? 1 * 0 : 1)
