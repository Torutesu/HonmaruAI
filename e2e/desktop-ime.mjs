// Japanese typed into the Mac app itself: the real Electron shell
// (apps/desktop) on the real local stack, and on a Mac, Apple's own Japanese
// input method fed real keystrokes — romaji in, kana and kanji out.
//
//     E2E_SPEC=e2e/desktop-ime.mjs ./e2e/run.sh
//
// What went wrong in the field is the test: letters leaking through as Latin
// ("watasikoyuunomondaika") while the menu bar still said あ, and the Enter
// that confirms a conversion being taken as the Enter that sends or builds.
// Off a Mac (Linux, for working on this file) the keys go through Chromium's
// IME emulation instead, which checks the plumbing but not the OS.
import { chromium } from '../web-react/node_modules/playwright/index.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const WEB = 'http://127.0.0.1:4173'
const SINK = 'http://127.0.0.1:9099'
const API = 'http://127.0.0.1:8787'
const PORT = 9333
const SHOTS = process.env.E2E_SHOTS || '/tmp/e2e-shots/desktop-ime'
const MAC = process.platform === 'darwin'
const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

const results = []
let failures = 0
async function step(name, fn) {
  try { await fn(); results.push(`  ok    ${name}`) } catch (err) { failures += 1; results.push(`  FAIL  ${name}\n        ${String(err).split('\n').slice(0, 4).join('\n        ')}`) }
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
const email = `desktop-ime-${Date.now()}@example.com`
await fetch(`${API}/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
const signed = await (await fetch(`${API}/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: await codeFor(email), name: 'Toru' }) })).json()
const { token, orgId } = signed
const login = signed.login || signed.userId
if (!token || !orgId) throw new Error(`sign-up failed: ${JSON.stringify(signed)}`)
const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-session-token': token }, body: body ? JSON.stringify({ orgId, ...body }) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.message || ''}`)
  return data
}
await api('POST', '/businesses', { name: 'Kitchen' })
const said = async () => (await api('GET', `/channels/messages?orgId=${encodeURIComponent(orgId)}&channel=b:kitchen`)).messages?.map((m) => m.body) || []

// The Mac app, unpackaged, pointed at this stack.
const electron = createRequire(`${root}apps/desktop/package.json`)('electron')
const shell = spawn(electron, ['.', `--app-url=${WEB}`, `--remote-debugging-port=${PORT}`, ...(MAC ? [] : ['--no-sandbox'])], {
  cwd: `${root}apps/desktop`, env: { ...process.env, HONMARU_API_ORIGINS: API }, stdio: ['ignore', 'inherit', 'inherit'],
})
let browser
for (let i = 0; i < 60 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
  if (!browser) await new Promise((r) => setTimeout(r, 500))
}
if (!browser) throw new Error('the Mac app never opened its window')
let page
for (let i = 0; i < 60 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(WEB))
  if (!page) await new Promise((r) => setTimeout(r, 500))
}
if (!page) throw new Error(`no app window: ${browser.contexts().flatMap((c) => c.pages()).map((p) => p.url())}`)
const thrown = []
page.on('pageerror', (e) => thrown.push(String(e).slice(0, 200)))
await page.evaluate(([t, u, o]) => {
  localStorage.setItem('sessionToken', t); localStorage.setItem('userId', u)
  localStorage.setItem('orgId', o); localStorage.setItem('host', '127.0.0.1:8787')
}, [token, login, orgId])
const cdp = await page.context().newCDPSession(page)

const keys = `${process.env.RUNNER_TEMP || '/tmp'}/mac-keys`
if (MAC) {
  execFileSync('defaults', ['write', 'com.apple.inputmethod.Kotoeri', 'JIMPrefLiveConversionKey', '-bool', 'false'])
  execFileSync('swiftc', ['-O', '-o', keys, `${root}e2e/mac-keys.swift`], { stdio: 'inherit' })
  console.log(execFileSync(keys, ['status']).toString().trim())
}

// Every kana a romaji key makes here, for the emulation off a Mac.
const KANA = { nihongo: ['に', 'にほ', 'にほん', 'にほんご', '日本語'], seikyuusho: ['せ', 'せい', 'せいきゅ', 'せいきゅう', 'せいきゅうしょ', '請求書'] }

/// Type `romaji`, convert with Space and confirm with Return, as a person does.
async function typeJapanese(romaji, { ms = 60 } = {}) {
  if (MAC) {
    execFileSync(keys, ['activate', String(shell.pid)])
    execFileSync(keys, ['japanese'])
    console.log(execFileSync(keys, ['type', String(ms), romaji]).toString().trim())
    await page.waitForTimeout(800)
    return
  }
  const word = romaji.replace(/[␣⏎]/g, '')
  const steps = KANA[word] || [word]
  for (const [i, text] of steps.entries()) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: i === steps.length - 1 ? 'Process' : 'Process', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 36 })
  await cdp.send('Input.insertText', { text: steps.at(-1) })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 })
  await page.waitForTimeout(500)
}
const latin = /[A-Za-z]/
/// Focus a box the way a person does. On a Mac that is a real mouse click
/// at its place on the screen: a click injected into the page focuses the
/// element but not the window's text view that macOS sends keys through.
async function press(selector) {
  if (!MAC) return page.click(selector)
  execFileSync(keys, ['activate', String(shell.pid)])
  const at = await page.$eval(selector, (el) => {
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: window.screenX + r.left + Math.min(40, r.width / 2), y: window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2 }
  })
  console.log(execFileSync(keys, ['click', String(Math.round(at.x)), String(Math.round(at.y))]).toString().trim())
  if (!(await page.$eval(selector, (el) => document.activeElement === el))) throw new Error(`a real click at ${Math.round(at.x)},${Math.round(at.y)} did not focus ${selector}`)
}
const valueOf = (selector) => page.$eval(selector, (el) => el.value)
// Empty, with the keys a person would use, so the app's own state agrees.
async function clear(selector) {
  await page.focus(selector)
  await page.keyboard.press(MAC ? 'Meta+a' : 'Control+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  const left = await valueOf(selector)
  if (left) throw new Error(`could not empty the box: ${JSON.stringify(left)}`)
}
// What the page itself received, so a lost key says where it was lost.
async function listen() {
  await page.evaluate(() => {
    window.__ime = []
    if (window.__imeOn) return
    window.__imeOn = true
    for (const type of ['keydown', 'compositionstart', 'compositionend', 'beforeinput', 'focusin', 'focusout'])
      document.addEventListener(type, (e) => window.__ime?.push(type === 'keydown' ? `kd:${e.key}${e.isComposing ? '*' : ''}${e.keyCode === 229 ? '' : `#${e.keyCode}`}`
        : type.startsWith('focus') ? `${type}:${e.target?.tagName}` : `${type.replace('composition', 'c')}:${e.data ?? ''}`), true)
    // After every handler in the app has had the key: did one of them eat it?
    window.addEventListener('keydown', (e) => { if (e.defaultPrevented) window.__ime?.push(`PREVENTED:${e.key}`) })
  })
}
const heard = () => page.evaluate(() => `${document.hasFocus() ? '' : '[page not focused] '}${(window.__ime || []).join(' ')}`)

/// Types into `selector`, then demands exactly `expected`: a key lost, or one
/// that came through as a Latin letter, is a different string.
async function expectTyped(selector, romaji, expected, { ms = 60, wait = 0, name }) {
  await press(selector)
  // Whatever a step before left behind is not this one's to answer for.
  if (await valueOf(selector)) await clear(selector)
  // The very element clicked: if the app swaps the box out mid-word, the
  // keys typed into the old one are gone, and this says so.
  await page.$eval(selector, (el) => { el.dataset.imeProbe = '1' })
  if (wait) await page.waitForTimeout(wait)
  await listen()
  await typeJapanese(romaji, { ms })
  const value = await valueOf(selector)
  const same = await page.$eval(selector, (el) => ({ kept: el.dataset.imeProbe === '1', focused: document.activeElement === el }))
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
  const log = await heard()
  console.log(`${name}: ${JSON.stringify(value)} (same box: ${same.kept}, focused: ${same.focused})\n  heard: ${log.slice(0, 900)}`)
  if (value !== expected) throw new Error(`expected ${JSON.stringify(expected)}, the box holds ${JSON.stringify(value)}${latin.test(value) ? ' (Latin letters leaked)' : ''}${same.kept ? '' : ' — the box was replaced while typing'}`)
  return value
}

const COMPOSER = '.slk-composer textarea.slk-input'
await step('the Mac app opens a channel, signed in', async () => {
  await page.goto(`${WEB}/#/list`, { waitUntil: 'load' })
  await page.waitForSelector('.cl-thread[data-view="b:kitchen"]', { timeout: 30000 })
  await page.click('.cl-thread[data-view="b:kitchen"]')
  await page.waitForSelector(COMPOSER, { timeout: 15000 })
})

if (MAC) {
  // A Mac in use has had its input method running for hours. Here it has
  // just been switched on: one key wakes it, and what that key does is not
  // the app's to answer for.
  await press(COMPOSER)
  await typeJapanese('a⏎')
  console.log(`warm-up: ${JSON.stringify(await valueOf(COMPOSER))}`)
  await clear(COMPOSER)
}

await step('にほんご becomes 日本語 in the message box, and confirming it sends nothing', async () => {
  const before = (await said()).length
  await expectTyped(COMPOSER, 'nihongo␣⏎', '日本語', { name: '01-composer' })
  if ((await said()).length !== before) throw new Error('the Enter that confirmed the conversion sent the message')
  await clear(COMPOSER)
})

if (MAC) {
  // The sentence from the field report, typed fast, across 。: every key
  // must reach the input method, none lost and none left as a letter.
  await step('a long sentence typed fast arrives whole, kana for every key', async () => {
    await expectTyped(COMPOSER, 'korehasiyoukana.watasinokankyounomondaikana.nidotoonajikotowosinaiyouni⏎',
      'これはしようかな。わたしのかんきょうのもんだいかな。にどとおなじことをしないように', { ms: 25, name: '02-fast' })
    await clear(COMPOSER)
  })
  await step('typing again after the window loses and regains focus still converts', async () => {
    execFileSync('osascript', ['-e', 'tell application "Finder" to activate'])
    await page.waitForTimeout(800)
    await expectTyped(COMPOSER, 'nihongo␣⏎', '日本語', { name: '03-refocus' })
    await clear(COMPOSER)
  })
  // Opening the app and typing at once is what a person does. Each box is
  // tried straight after the page loads and again once it has settled, so a
  // first key lost to the load shows as the difference between the two.
  for (const [i, wait] of [0, 0, 0, 3000].entries()) {
    await step(`straight after the page loads (${wait ? 'settled' : `at once, try ${i + 1}`}), the message box gets every key`, async () => {
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector(`${COMPOSER}, .cl-thread[data-view="b:kitchen"]`, { timeout: 30000 })
      if (!(await page.$(COMPOSER))) await page.click('.cl-thread[data-view="b:kitchen"]')
      await page.waitForSelector(COMPOSER, { timeout: 15000 })
      await expectTyped(COMPOSER, 'sakanawoyaku⏎', 'さかなをやく', { wait, name: `05-composer-after-load-${i}-${wait}` })
      await clear(COMPOSER)
    })
  }
}

await step('the Harness home box keeps what was typed and builds nothing on the confirming Enter', async () => {
  await api('PUT', '/orgs/mode', { mode: 'harness' })
  const builds = []
  const watch = (r) => { if (r.method() === 'POST' && /\/apps\/generate$/.test(new URL(r.url()).pathname)) builds.push(r.url()) }
  page.on('request', watch)
  const box = '.hx-home-ask input'
  try {
    for (const [i, wait] of (MAC ? [0, 0, 0, 3000] : [0]).entries()) {
      // The window was open in the other mode: it learns of the switch on a
      // reload, and only a harness has a home to go to.
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[data-tab="apps"], .harness-workspace', { timeout: 30000 })
      for (let i = 0; i < 3 && !(await page.$(box)); i++) {
        await page.evaluate(() => { location.hash = '#/home' })
        await page.waitForSelector(box, { timeout: 10000 }).catch(() => {})
      }
      await page.waitForSelector(box, { timeout: 10000 })
      if (MAC) await expectTyped(box, 'seikyuusho⏎', 'せいきゅうしょ', { wait, name: `04-harness-home-${i}-${wait}` })
      else await expectTyped(box, 'seikyuusho␣⏎', '請求書', { name: '04-harness-home-0' })
      if (builds.length) throw new Error('the Enter that confirmed the conversion started a build')
    }
  } finally { page.off('request', watch) }
})

if (thrown.length) results.push(`  note  page errors: ${thrown.join(' | ')}`)
await browser.close().catch(() => {})
shell.kill()
console.log(`\nMac app Japanese input (${MAC ? 'macOS, real keystrokes through Japanese – Romaji' : 'Chromium IME emulation'}):\n${results.join('\n')}`)
process.exit(failures ? 1 : 0)
