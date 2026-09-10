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

// A browser this machine already has, when it has one: some images ship
// Chromium at a fixed path and skip the download. Everywhere else — a clean
// clone, a CI runner — fall through to the one Playwright installed for
// itself, rather than launching nothing and calling the product broken.
const browser = await chromium.launch({
  ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}),
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

/// Back to the feed, whatever is open on top of it. Several steps were each
/// rolling their own version of this loop, and each one that got it slightly
/// wrong failed for a reason that belonged to the step before it.
async function closeEverything() {
  for (let i = 0; i < 4; i++) {
    const open = await page.$('.sheet .close, .screen .back')
    if (!open) break
    await open.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.waitForSelector('.tabbar', { timeout: 10000 })
}

/// Mint an invite code from the team screen, and hand it back.
///
/// The code is 32 hex characters and was once set like a six-digit PIN, so it
/// ran out of its box and pushed the Copy button clean off the screen —
/// hence the overflow check on the way past. Nothing here may sit outside the
/// viewport.
async function mintInvite(role, shotName) {
  await closeEverything()
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await page.click('.screen .row:has-text("Your team")')
  await page.waitForSelector('.screen .invite select', { timeout: 10000 })
  await page.selectOption('.screen .invite select', role)
  await page.click('.screen .invite .btn-primary')
  await page.waitForSelector('.screen .invite-code', { timeout: 15000 })
  if (shotName) await shot(shotName)

  const spill = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('.screen *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.left < -1 || r.right > window.innerWidth + 1) {
        bad.push(`${el.className || el.tagName} @ ${Math.round(r.left)} ${Math.round(r.width)}w`)
      }
    }
    return bad.slice(0, 5)
  })
  if (spill.length) throw new Error(`the team screen spills off the phone: ${spill.join(' ; ')}`)

  const code = (await page.textContent('.screen .invite-code')).trim()
  if (!code) throw new Error('no invite code was minted')
  await closeEverything()
  return code
}

/// A screen that is not a tab. On a phone the bar holds three — feed, compose,
/// you — so History and Tools are reached the way a person reaches them:
/// through You. On the rail they are tabs, and that route is tested there.
async function openViaYou(rowText, marker) {
  await closeEverything()
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await page.click(`.screen .row:has-text("${rowText}")`)
  await page.waitForSelector(marker, { timeout: 10000 })
}

const email = `e2e-${Date.now()}@example.com`
let mate
// Browser contexts the later steps open, closed together at the end.
const extras = []
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

// The tab bar was a row of text glyphs — ⌂ ↺ ⚯ ◯ — which are characters, not
// icons: they change shape with the system font and there is no ⚯ that means
// "tools". Every tab must carry the drawn icon instead.
await step('the tab bar is drawn, not typed', async () => {
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('nav .tab')]
      // What the phone actually shows: the rail's extra two are display:none.
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
      tab: el.dataset.tab,
      svg: el.querySelectorAll('svg').length,
      // Any leftover glyph shows up as text content on the button itself.
      text: (el.textContent || '').trim(),
      size: (() => { const s = el.querySelector('svg'); if (!s) return null
        const r = s.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}` })(),
    }))
  )
  // Three, as the design draws it — the other two are rows under You.
  if (tabs.length !== 3) throw new Error(`expected 3 tabs on a phone, found ${tabs.length}`)
  if (tabs.map((t) => t.tab).join(',') !== 'feed,compose,you') {
    throw new Error(`the phone bar is ${tabs.map((t) => t.tab).join(',')}`)
  }
  for (const t of tabs) {
    if (t.svg < 1) throw new Error(`the ${t.tab} tab has no icon`)
    if (t.text) throw new Error(`the ${t.tab} tab still shows a glyph: ${JSON.stringify(t.text)}`)
    if (!/^2[0-9]x2[0-9]$/.test(t.size || '')) {
      throw new Error(`the ${t.tab} icon is ${t.size}, not the 24px the design draws`)
    }
  }
  await shot('07b-tabbar')
})

// The same problem lived in every row icon on every screen: a character
// standing in for a drawing. A glyph is whatever the system font decides.
await step('no screen falls back to a text glyph for an icon', async () => {
  const found = []
  for (const [tab, marker] of [['Tools', '.rows'], ['You', '.profile-stats']]) {
    if (tab === 'You') { await closeEverything(); await page.click('nav [data-tab="you"]') }
    else await openViaYou(tab, marker)
    await page.waitForSelector(marker, { timeout: 10000 })
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll('.screen .row-icon')]
        .filter((el) => !el.querySelector('svg'))
        .map((el) => (el.textContent || '').trim())
    )
    found.push(...bad.map((g) => `${tab}: ${g}`))
    await closeEverything()
  }
  if (found.length) throw new Error(`glyphs still standing in for icons — ${found.join(' , ')}`)
})

await step('the relay is connected', async () => {
  await page.waitForSelector('.dot.on', { timeout: 20000 })
})

await step('telling your AI something produces a decision', async () => {
  await page.click('[data-tab="compose"]')
  await page.waitForSelector('.sheet-bottom')
  const box = await page.$('.create-decision textarea')
  if (!box) throw new Error('the compose sheet has no text field')
  // A sentence longer than the field used to scroll out of sight, leaving you
  // unable to read what you were about to send — which is the interaction.
  const sentence = 'Approve the new supplier price for the cafe before the weekend, and tell Kenji either way'
  await box.fill(sentence)
  await page.waitForTimeout(200)
  const readable = await page.evaluate(() => {
    const el = document.querySelector('.create-decision textarea')
    // Its own scroll height is what it would need to show everything.
    return { shown: el.clientHeight, needed: el.scrollHeight, right: el.getBoundingClientRect().right }
  })
  if (readable.needed > readable.shown + 2) {
    throw new Error(`the compose box hides ${readable.needed - readable.shown}px of what you typed`)
  }
  if (readable.right > 391) throw new Error('the compose box runs off the phone')
  await shot('08-compose')
  await box.fill('Approve the new supplier price for the cafe')
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
  await openViaYou('History', '.seg')
  const text = await page.evaluate(() => document.body.innerText)
  if (!/Approved|承認/.test(text)) throw new Error('the decision is not in history after a reload')
  await shot('11-history')
})

// The other half of the feed. Cards is one decision at a time; Classic is the
// same decisions as a list, and it had never been opened by anything here.
await step('the list view shows the same decisions', async () => {
  await closeEverything()
  await page.click('.mode-switch button >> nth=1')
  await page.waitForSelector('.classic', { timeout: 10000 })
  await shot('09b-classic')
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.cl-row')].map((el) => el.innerText)
  )
  if (!rows.length) throw new Error('the list is empty although the feed is not')
  const joined = rows.join(' ')
  if (/u:|email:|@example\.com/.test(joined)) {
    throw new Error(`the list shows a raw account id: ${joined.slice(0, 140)}`)
  }
  // Nothing may sit outside the phone here either.
  const spill = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('.classic *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.left < -1 || r.right > window.innerWidth + 1) bad.push(el.className || el.tagName)
    }
    return bad.slice(0, 5)
  })
  if (spill.length) throw new Error(`the list spills off the phone: ${spill.join(' ; ')}`)
  // The same decision must not read as "approve" here and "Approved" in
  // History — the list was showing the API's verb rather than the word.
  if (/\b(approve|decline|revise|delegate)\b/.test(joined)) {
    throw new Error(`the list shows the raw action verb: ${joined.slice(0, 140)}`)
  }
  await page.click('.mode-switch button >> nth=0')
  await page.waitForSelector('.feed', { timeout: 10000 })
})

await step('every other screen opens', async () => {
  await closeEverything()
  await openViaYou('Tools', '.rows')
  await shot('12-tools')
  await closeEverything()
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await shot('13-profile')
  await page.click('.screen .back')
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
  await closeEverything()
  await openViaYou('Tools', '.rows')
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
  await closeEverything()
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
  // The rows are Japanese now, so they are named in Japanese — which also
  // checks that the route into them survived the translation.
  for (const [label, row, marker] of [
    ['history', '履歴', '.seg'],
    ['tools', 'ツール', '.rows'],
    ['you', null, '.profile-stats'],
  ]) {
    if (row) await openViaYou(row, marker)
    else { await closeEverything(); await page.click('nav [data-tab="you"]') }
    await page.waitForSelector(marker, { timeout: 10000 })
    await page.screenshot({ path: `${SHOTS}/17-japanese-${label}.png` })
    // Chrome only. A card's title and summary are whatever language they were
    // written in and are not retranslated when you change yours — a decision
    // already taken does not get rewritten under the person who took it.
    const text = await page.evaluate(() =>
      [...document.querySelectorAll(
        '.screen .head-title, .screen .rows-title, .screen .seg button,'
        + ' .screen .row-main, .screen .lede, .screen .empty, .screen .form-note'
      )]
        // History's rows are card titles wearing a chrome class.
        .filter((el) => !el.closest('.hist-group'))
        .map((el) => el.innerText)
        .join('\n')
    )
    // A ratio of Japanese characters fights the proper nouns that stay in
    // English on purpose — "GitHub", "Issue", "Pull Request". What actually
    // means "untranslated" is a whole line with no Japanese in it at all.
    const english = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /[A-Za-z]{4}/.test(line) && !/[ぁ-んァ-ヶ一-龯]/.test(line))
      .filter((line) => !/^(Gmail|Slack|Notion|GitHub|AI|Pro|Free|E2E Person)\b/.test(line))
      .filter((line) => !/^[\w.+-]+@[\w.-]+$/.test(line))
    if (english.length) {
      throw new Error(`${label} still shows English: ${english.slice(0, 3).join(' | ').slice(0, 160)}`)
    }
    await page.click('.screen .back')
    await page.waitForTimeout(300)
  }
  // A card written while this is the language must arrive in it: the title and
  // the routing line are the Worker's own words, not the sender's. Compose
  // from the feed — on a phone an open screen hides the tab bar, which is the
  // point of it, so the nav is not clickable from under one.
  await page.click('nav [data-tab="compose"]')
  await page.waitForSelector('.sheet-bottom .create-decision textarea', { timeout: 10000 })
  await page.fill('.sheet-bottom .create-decision textarea', '来週の値上げを承認してほしい')
  await page.click('.sheet-bottom .create-decision button')
  await page.waitForTimeout(2500)
  await closeEverything()
  await page.waitForSelector('.card-title', { timeout: 15000 })
  await shot('17-japanese-card')
  const cardTitle = await page.evaluate(() => document.querySelector('.card-title').innerText)
  if (!/[ぁ-んァ-ヶ一-龯]/.test(cardTitle)) {
    throw new Error(`a card made in 日本語 is titled in English: ${cardTitle}`)
  }
  // The feed is not a screen and was missed by the loop above: its own chrome
  // — the Cards/Classic tabs, the card's kind and its priority legend, the
  // role under a name — was still English behind a Japanese card.
  const feedChrome = await page.evaluate(() =>
    [...document.querySelectorAll(
      '.mode-switch button, .card-kind, .priority-legend, .rb-label, .rb-meta, .ask-bar input'
    )].map((el) => (el.placeholder || el.innerText || '').trim()).filter(Boolean)
  )
  const feedEnglish = feedChrome.filter(
    (line) => /[A-Za-z]{4}/.test(line) && !/[ぁ-んァ-ヶ一-龯]/.test(line)
  )
  if (feedEnglish.length) {
    throw new Error(`the feed's own chrome is still English: ${feedEnglish.slice(0, 4).join(' | ')}`)
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
  await d.waitForSelector('.create-decision textarea')
  await d.fill('.create-decision textarea', 'Ask the designer to review the new card layout')
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
  await closeEverything()

  const invite = await mintInvite('engineer', '18-invite')

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
  await closeEverything()
})

// Everything above is somebody's first day. These are the second: an account
// that already exists, on a machine that has never seen it. Each one of these
// used to fail — the invite code was read and dropped, and a sign-in reply
// that named no workspace sent the client to a placeholder org nobody is a
// member of, so the feed simply never connected.

/// A whole browser that has never been here, signing in with a code.
async function freshSignIn(email, { inviteCode } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  extras.push(ctx)
  const p = await ctx.newPage()
  const before = (await (await fetch(`${SINK}/sent`)).json())
    .filter((m) => (m.to || []).includes(email)).length
  await p.goto(WEB, { waitUntil: 'load' })
  await p.click('text=I already have an account')
  await p.waitForSelector('#email')
  await p.fill('#email', email)
  if (inviteCode) await p.fill('#invite', inviteCode)
  await p.click('text=Email me a code')
  await p.waitForSelector('.otp-boxes', { timeout: 15000 })
  await typeCode(p, await codeFor(email, { after: before }))
  return p
}

await step('signing in on a machine that has never seen you reaches the feed', async () => {
  // No localStorage, and the sign-in reply used to carry no org either, so the
  // client fell back to a hardcoded `web-team` — an org nobody belongs to. The
  // relay refused the socket and this dot never came on.
  const p = await freshSignIn(email)
  await p.waitForSelector('.dot.on', { timeout: 25000 })
  await p.screenshot({ path: `${SHOTS}/23-second-browser.png` })
})

await step('an invite reaches someone who already has an account', async () => {
  const invite = await mintInvite('designer')

  // C already has an account of their own, made before the invite existed.
  const already = `e2e-already-${Date.now()}@example.com`
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  extras.push(ctx)
  const c = await ctx.newPage()
  await c.goto(WEB, { waitUntil: 'load' })
  await c.click('text=Get started')
  await c.waitForSelector('#email')
  await c.fill('#name', 'Aya')
  await c.fill('#email', already)
  await c.click('text=Email me a code')
  await c.waitForSelector('.otp-boxes', { timeout: 15000 })
  await typeCode(c, await codeFor(already))
  await c.waitForSelector('.ob-art', { timeout: 20000 })
  await c.click('text=Next'); await c.waitForSelector('.ob-art-route')
  await c.click('text=Next'); await c.waitForSelector('.ob-demo')
  await c.click('text=Set me up'); await c.waitForSelector('.radio')
  await c.click('text=Open my feed')
  await c.waitForSelector('.dot.on', { timeout: 25000 })

  // Now they are handed a code. They are already signed in, so the place to
  // put it is You → Join a team — which is the surface that did not exist.
  await c.click('nav [data-tab="you"]')
  await c.waitForSelector('.profile-stats', { timeout: 10000 })
  await c.click('.screen .row.join-team')
  await c.waitForSelector('.join-code', { timeout: 10000 })
  await c.fill('.join-code', invite)
  await c.click('.screen .row.static .pill-btn')

  // Landed in the team: the switcher now lists more than one workspace, and
  // the one they just joined is the one they are in.
  await c.waitForSelector('nav [data-tab="you"]', { timeout: 15000 })
  await c.waitForSelector('.dot.on', { timeout: 25000 })
  await c.click('nav [data-tab="you"]')
  await c.waitForSelector('.profile-stats', { timeout: 10000 })
  await c.waitForSelector('[data-org][aria-current="true"]', { timeout: 10000 })
  await c.screenshot({ path: `${SHOTS}/24-joined-a-team.png` })
  const workspaces = await c.$$eval('[data-org]', (els) => els.length)
  if (workspaces < 2) throw new Error(`joining a team left ${workspaces} workspace(s) to choose from`)
  await c.click('.screen .back')

  // And a card A sends now arrives, which is the whole point of joining.
  await page.click('nav [data-tab="compose"]')
  await page.waitForSelector('.sheet-bottom textarea, .sheet-bottom input', { timeout: 10000 })
  const box = (await page.$('.sheet-bottom textarea')) || (await page.$('.sheet-bottom input'))
  await box.fill('ask the designer to sign off on the new menu photography')
  await page.click('.sheet-bottom .btn-primary, .sheet-bottom button:has-text("Send")')

  await c.waitForSelector('.card', { timeout: 25000 })
  const seen = await c.evaluate(() => document.querySelector('.card').innerText)
  if (/photograph|menu/i.test(seen) === false) {
    throw new Error(`the card that arrived is not the one that was sent: ${seen.slice(0, 140)}`)
  }
  await closeEverything()
})

await step('a code that is not a code is said out loud, not swallowed', async () => {
  // The same surface, given something that is not an invite. Silence here is
  // the failure that started all of this: a code was read and nothing
  // happened to it, with no error and no membership.
  //
  // Driven from the signed-in screen rather than through sign-in, because a
  // second code for one address inside a minute is refused by the resend
  // cooldown — the product being right, and the test being impatient. The
  // sign-in variant is pinned in worker/test/join-a-team.test.js.
  await closeEverything()
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await page.click('.screen .row.join-team')
  await page.waitForSelector('.join-code', { timeout: 10000 })
  await page.fill('.join-code', '0'.repeat(32))
  await page.click('.screen .row.static .pill-btn')

  await page.waitForSelector('.screen .form-error', { timeout: 15000 })
  const said = (await page.textContent('.screen .form-error')) || ''
  if (!said.trim()) throw new Error('a rejected invite code said nothing')
  // And it did not move them anywhere: still the same feed, still connected.
  await page.click('.screen .back')
  await page.waitForSelector('.dot.on', { timeout: 20000 })
})

await step('the team screen shows who is here, and Kenji is', async () => {
  // Inviting was the whole of team management: you could add somebody and
  // then never see them again. /orgs/:owner/:repo/graph answered "who is
  // here" only for a repository-backed org and only to a GitHub session — so
  // for every account the web client can sign in, it answered nothing.
  await closeEverything()
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await page.click('.screen .row:has-text("Your team")')
  await page.waitForSelector('.screen .team-member', { timeout: 15000 })
  await shot('25-team')

  const names = await page.$$eval('.screen .team-member .row-main', (els) =>
    els.map((e) => e.textContent || ''))
  if (names.length < 2) throw new Error(`the team lists ${names.length} people`)
  if (!names.some((n) => /Kenji/.test(n))) {
    throw new Error(`the person who joined by invite is not in the team: ${names.join(' | ')}`)
  }
  // Nobody is listed by the id they sign in with.
  const raw = names.filter((n) => /u:|email:|@example\.com/.test(n))
  if (raw.length) throw new Error(`the team shows raw account ids: ${raw.join(' | ')}`)
  // And exactly one of them is you.
  const you = names.filter((n) => /you/.test(n))
  if (you.length !== 1) throw new Error(`${you.length} people on this team are you`)
  await closeEverything()
})

await step('a code you have out can be found and revoked', async () => {
  // There was no way to see a code you had already handed over, and no way to
  // close it — the only way to stop one was to wait a week for it to expire.
  const doomed = await mintInvite('member')

  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await page.click('.screen .row:has-text("Your team")')
  await page.waitForSelector('.screen .team-invite', { timeout: 15000 })
  const listed = await page.$$eval('.screen .team-invite .invite-code', (els) =>
    els.map((e) => (e.textContent || '').trim()))
  if (!listed.includes(doomed)) {
    throw new Error(`the code just minted is not listed: ${listed.join(' | ')}`)
  }
  await shot('26-codes-out')

  const before = listed.length
  await page.click(`.screen .team-invite:has-text("${doomed.slice(0, 8)}") .btn-text.danger`)
  await page.waitForFunction(
    (n) => document.querySelectorAll('.screen .team-invite').length < n,
    before,
    { timeout: 15000 }
  )
  const after = await page.$$eval('.screen .team-invite .invite-code', (els) =>
    els.map((e) => (e.textContent || '').trim()))
  if (after.includes(doomed)) throw new Error('a revoked code is still listed')
  await closeEverything()

  // And it no longer opens anything. Through the screen a person would use,
  // not a bare request: an unauthenticated POST is refused whether or not the
  // code is dead, which would have made this assertion prove nothing.
  await page.click('nav [data-tab="you"]')
  await page.waitForSelector('.profile-stats', { timeout: 10000 })
  await page.click('.screen .row.join-team')
  await page.waitForSelector('.join-code', { timeout: 10000 })
  await page.fill('.join-code', doomed)
  await page.click('.screen .row.static .pill-btn')
  await page.waitForSelector('.screen .form-error', { timeout: 15000 })
  await closeEverything()
})

await step('GitHub is not claimed where it cannot run', async () => {
  // The Tools screen printed "Always on · Built in" for everyone. In a
  // workspace made at sign-up there is no repository to open an issue in and
  // no GitHub token to write with, so that was simply not true.
  await openViaYou('Tools', '.screen')
  await page.waitForSelector('[data-github]', { timeout: 15000 })
  const state = await page.getAttribute('[data-github]', 'data-github')
  if (state !== 'off') throw new Error(`GitHub is claimed as "${state}" in a workspace with no repository`)
  const said = await page.textContent('[data-github] .row-sub')
  if (!said || !said.trim()) throw new Error('GitHub is switched off without saying why')
  await shot('27-github-off')
  await closeEverything()
})

for (const ctx of extras) await ctx.close()
if (mate) await mate.close()
await browser.close()

const report = results.join('\n')
writeFileSync(`${SHOTS}/report.txt`, report)
console.log('\n' + report)
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`} — screenshots in ${SHOTS}`)
process.exit(failures === 0 ? 1 * 0 : 1)
