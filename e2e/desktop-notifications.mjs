// Focused Mac notification regression against real local Worker, D1 and sockets.
// The Electron bridge and native Notification presentation are test adapters;
// OS delivery still requires verification in the signed Mac application.
// Run: E2E_SPEC=e2e/desktop-notifications.mjs ./e2e/run.sh
import { chromium } from '../web-react/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const WEB = 'http://127.0.0.1:4173'
const SINK = 'http://127.0.0.1:9099'
const API = 'http://127.0.0.1:8787'
const SHOTS = process.env.E2E_SHOTS || '/tmp/e2e-shots'
mkdirSync(SHOTS, { recursive: true })

const results = []
let failures = 0

async function step(name, fn, { after } = {}) {
  try {
    await fn()
    console.log(`ok ${name}`); results.push(`  ok    ${name}`)
  } catch (err) {
    console.error(name, String(err)); failures += 1
    results.push(`  FAIL  ${name}\n        ${String(err).split('\n').filter((l) => l.trim()).slice(0, 4).join('\n        ')}`)
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
  // A Jam needs a microphone: a fake one, allowed without asking.
  args: ['--headless=new', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

async function instrument(ctx) {
 await ctx.addInitScript(() => {
  window.honmaruDesktop={isDesktop:true,platform:'darwin',show(){},setBadge(){}};
  window.__notifications=[];
  window.Notification=class {static permission='granted';static async requestPermission(){return 'granted'};constructor(title,options){window.__notifications.push({title,...options})}close(){}};
  localStorage.setItem('honmaru.desktop-notifications','on');
  Object.defineProperty(document,'hasFocus',{value:()=>false});
 });
}

// One person, signing up from scratch, on a phone.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
await instrument(phone)
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
const EXPECTED_REFUSALS = [/^503 \/connectors/, /^503 \/push\/vapid/, /^503 \/ai\/ask/, /^503 \/ai\/draft/, /^503 \/cards\/[^/]+\/localize/, /^503 \/oauth\/github\/config/]

/// Back to the feed, whatever is open on top of it. Several steps were each
/// rolling their own version of this loop, and each one that got it slightly
/// wrong failed for a reason that belonged to the step before it.
async function closeEverything() {
  for (let i = 0; i < 4; i++) {
    // A conversation in the list hides the tab bar on a phone; back out
    // of it (and of a decision open over it) the way a person would.
    const open = await page.$('.sheet .close, .screen .back, .slk-back.pane:visible, .slk-head .slk-back:visible')
    if (!open) break
    await open.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  // The feed's tab bar, or on a phone in the list, the list's own.
  await page.waitForSelector('.tabbar:visible, .cl-tabs:visible', { timeout: 10000 })
}

/// Mint an invite link from the team screen, and hand back the code inside it.
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
  await page.waitForSelector('.screen .invite .invite-link', { timeout: 15000 })
  if (shotName) await shot(shotName)
  // No code on the screen any more: an invitation is a link, and a code
  // printed beside it was one more thing to paste wrong.
  if (await page.$('.screen .invite .invite-code')) throw new Error('the invite still prints a bare code')

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

  const link = (await page.getAttribute('.screen .invite .invite-link', 'href')) || ''
  const code = (link.match(/#\/join\/([0-9a-f]{32})$/) || [])[1]
  if (!code) throw new Error(`no invite link was minted: ${link}`)
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
// The teammate who joins by code, kept so a later step can take them out.
let joiner
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` })

await step('the welcome screen loads', async () => {
  await page.goto(WEB, { waitUntil: 'load' })
  await page.waitForSelector('text=Get started', { timeout: 15000 })
  await shot('01-welcome')
})

// The first thing anyone sees on a laptop, signed out. It was offset by the
// width of a navigation rail that does not exist until you are signed in,
// which left a bare white column down the left edge of the window.
// GitHub sign-in is offered on the web only where the deployment registered a
// web callback. This one has not, so the button must not be there — a button
// that leads to a 503 is worse than none.
await step('GitHub sign-in is not offered where it is not set up', async () => {
  await page.waitForTimeout(800)
  if (await page.$('.btn-github')) throw new Error('a "Continue with GitHub" button on a deployment with no web callback')
})

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
  await page.click('.screen-foot .btn-primary:has-text("Next")')
  // The daily report, set up before the first card: 08:00 and 22:00 where
  // the person is, into a channel made for it.
  await page.waitForSelector('.ob-daily input[type="time"]', { timeout: 15000 })
  const am = await page.$eval('.daily-part[data-part="morning"] input[type="time"]', (el) => el.value)
  const pm = await page.$eval('.daily-part[data-part="evening"] input[type="time"]', (el) => el.value)
  if (am !== '08:00' || pm !== '22:00') throw new Error(`onboarding does not offer 08:00 and 22:00: ${am} / ${pm}`)
  const name = await page.$eval('.ob-daily input[aria-label="New channel name"]', (el) => el.value)
  if (name !== 'daily-reports') throw new Error(`onboarding does not propose a channel for it: ${name}`)
  await shot('06b-onboarding-daily')
  await page.click('text=Keep these times and continue')
  await page.waitForSelector('[data-onboarding="notifications"]')
  await page.click('.screen-foot .btn-primary')
  await page.waitForSelector('.tabbar', { timeout: 20000 })
  await shot('07-feed-empty')
})

await step('a second person joins by invite and the card reaches them', async () => {
  await closeEverything()

  const invite = await mintInvite('engineer', '18-invite')

  // B signs up with it, in their own browser.
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } })
  mate = second
  await instrument(second)
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
  await b.click('.screen-foot .btn-primary:has-text("Next")'); await b.waitForSelector('.ob-daily input[type="time"]', { timeout: 15000 })
  // Joining a team whose first member set up a daily report: the same
  // channel is offered, not a second one beside it.
  const offered = await b.$eval('.ob-daily select[aria-label="Post to"]', (el) => el.value)
  if (offered !== 'b:daily-reports') throw new Error(`a teammate is not offered the team's daily-report channel: ${offered}`)
  await b.click('text=Keep these times and continue')
  await b.waitForSelector('[data-onboarding="notifications"]')
  await b.click('.screen-foot .btn-primary')
  await b.waitForSelector('[data-connected="1"]', { state: 'attached', timeout: 25000 })

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


await step('request notification and answer notification cross two accounts', async()=> {
 const b=mate.pages()[0];
 await b.waitForFunction(()=>window.__notifications.some(n=>n.data?.cardId),null,{timeout:15000});
 const received=await b.evaluate(()=>window.__notifications.find(n=>n.data?.cardId));
 await b.click('.decide.approve');
 await page.waitForFunction(id=>window.__notifications.some(n=>n.data?.kind==='decided'&&n.data?.cardId===id),received.data.cardId,{timeout:20000});
 console.log('PASS: actual local Worker + D1 + two WebSocket clients delivered request and reply to native Notification adapter');
});
await browser.close();console.log(results.join('\n'));process.exit(failures?1:0);
