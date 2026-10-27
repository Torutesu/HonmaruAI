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
const japanese = /[぀-ヿ一-鿿]/
const valueOf = (selector) => page.$eval(selector, (el) => el.value)
const clear = (selector) => page.$eval(selector, (el) => { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })) })

const COMPOSER = '.slk-composer textarea.slk-input'
await step('the Mac app opens a channel, signed in', async () => {
  await page.goto(`${WEB}/#/list`, { waitUntil: 'load' })
  await page.waitForSelector('.cl-thread[data-view="b:kitchen"]', { timeout: 30000 })
  await page.click('.cl-thread[data-view="b:kitchen"]')
  await page.waitForSelector(COMPOSER, { timeout: 15000 })
})

await step('にほんご becomes 日本語 in the message box, and confirming it sends nothing', async () => {
  const before = (await said()).length
  await page.click(COMPOSER)
  await typeJapanese('nihongo␣⏎')
  const value = await valueOf(COMPOSER)
  await page.screenshot({ path: `${SHOTS}/01-composer.png` })
  if (latin.test(value) || !japanese.test(value)) throw new Error(`the box holds ${JSON.stringify(value)}`)
  if ((await said()).length !== before) throw new Error('the Enter that confirmed the conversion sent the message')
  await clear(COMPOSER)
})

if (MAC) {
  // What the field report describes: fast typing, across a 。, and every key
  // still going through the input method.
  await step('a long sentence typed fast stays Japanese all the way through', async () => {
    await page.click(COMPOSER)
    await typeJapanese('korehasiyoukana.watasinokankyounomondaikana.nidotoonajikotowosinaiyouni⏎', { ms: 25 })
    const value = await valueOf(COMPOSER)
    await page.screenshot({ path: `${SHOTS}/02-fast.png` })
    if (latin.test(value) || !japanese.test(value)) throw new Error(`letters leaked as Latin: ${JSON.stringify(value)}`)
    await clear(COMPOSER)
  })
  await step('typing again after the window loses and regains focus still converts', async () => {
    execFileSync('osascript', ['-e', 'tell application "Finder" to activate'])
    await page.waitForTimeout(800)
    await page.click(COMPOSER).catch(() => {})
    await typeJapanese('nihongo␣⏎')
    const value = await valueOf(COMPOSER)
    await page.screenshot({ path: `${SHOTS}/03-refocus.png` })
    if (latin.test(value) || !japanese.test(value)) throw new Error(`after refocusing the box holds ${JSON.stringify(value)}`)
    await clear(COMPOSER)
  })
}

await step('the Harness home box keeps 請求書 and builds nothing on the confirming Enter', async () => {
  await api('PUT', '/orgs/mode', { mode: 'harness' })
  const builds = []
  const watch = (r) => { if (r.method() === 'POST' && /\/apps\/generate$/.test(new URL(r.url()).pathname)) builds.push(r.url()) }
  page.on('request', watch)
  // The window was open in the other mode: it learns of the switch on a
  // reload, and only a harness has a home to go to.
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('[data-tab="apps"], .harness-workspace', { timeout: 30000 })
  const box = '.hx-home-ask input'
  for (let i = 0; i < 3 && !(await page.$(box)); i++) {
    await page.evaluate(() => { location.hash = '#/home' })
    await page.waitForSelector(box, { timeout: 10000 }).catch(() => {})
  }
  await page.waitForSelector(box, { timeout: 10000 })
  await page.click(box)
  await typeJapanese('seikyuusho␣⏎')
  const value = await valueOf(box)
  await page.screenshot({ path: `${SHOTS}/04-harness-home.png` })
  page.off('request', watch)
  if (builds.length) throw new Error(`confirming the conversion started a build (box: ${JSON.stringify(value)})`)
  if (latin.test(value) || !japanese.test(value)) throw new Error(`the box holds ${JSON.stringify(value)}`)
})

if (thrown.length) results.push(`  note  page errors: ${thrown.join(' | ')}`)
await browser.close().catch(() => {})
shell.kill()
console.log(`\nMac app Japanese input (${MAC ? 'macOS, real keystrokes through Japanese – Romaji' : 'Chromium IME emulation'}):\n${results.join('\n')}`)
process.exit(failures ? 1 : 0)
