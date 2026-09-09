// Responsive geometry regression gate for Welcome and an isolated local sample.
// Run after starting the local frontend; no Worker or account is needed:
// WEB_QA_URL=http://127.0.0.1:4319 WEB_QA_OUTPUT=/tmp/honmaru-layout node scripts/check-desktop-layout.mjs
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = new URL(process.env.WEB_QA_URL || 'http://127.0.0.1:4319')
assert(['http:', 'https:'].includes(base.protocol), 'Layout QA requires an HTTP(S) frontend')
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Layout QA requires a local frontend')
assert(!base.username && !base.password, 'Do not put credentials in the QA URL')
const sampleURL = new URL(base)
sampleURL.search = '?demo=figma'
sampleURL.hash = ''
const welcomeURL = new URL(base)
welcomeURL.search = ''
welcomeURL.hash = ''
const output = process.env.WEB_QA_OUTPUT || '/tmp/honmaru-desktop-layout-qa'
const viewports = [
  { width: 1024, height: 768 }, { width: 1280, height: 720 },
  { width: 1440, height: 900 }, { width: 1920, height: 1080 },
  { width: 390, height: 844 }, { width: 320, height: 640 },
]
// Allow fractional CSS-pixel rounding, without asserting implementation widths.
const tolerance = 1
const centerTolerance = 2
const clearance = 8
const startedAt = new Date().toISOString()
const results = [], runtimeErrors = [], blockedRequests = []
let allowedDevelopmentSockets = 0
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })

const near = (actual, expected, message) => assert(Math.abs(actual - expected) <= centerTolerance,
  `${message}: ${actual.toFixed(2)} vs ${expected.toFixed(2)} CSS px`)
const insideHorizontally = (box, width, label) => {
  assert(box.width > 0 && box.height > 0, `${label} must have visible dimensions`)
  assert(box.left >= -tolerance && box.right <= width + tolerance, `${label} extends beyond viewport horizontally`)
}
const centered = (box, viewport, label) => {
  insideHorizontally(box, viewport.width, label)
  near(box.centerX, viewport.width / 2, `${label} horizontal center`)
}
const noHorizontalOverflow = (metrics, label) => assert(
  metrics.scrollWidth <= metrics.clientWidth + tolerance,
  `${label} has horizontal overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`,
)

// All DOM evaluation is read-only: wait for fonts/layout, then inspect rectangles.
const ready = async (page) => page.evaluate(async () => {
  await document.fonts.ready
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
})
const geometry = (page, selectors) => page.evaluate((entries) => {
  const measurements = {}
  for (const [name, selector] of Object.entries(entries)) {
    const element = document.querySelector(selector)
    if (!element) throw new Error(`Missing layout element: ${name} (${selector})`)
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`Layout element is hidden: ${name}`)
    }
    measurements[name] = {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height,
      centerX: (rect.left + rect.right) / 2, centerY: (rect.top + rect.bottom) / 2,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    }
  }
  return {
    ...measurements,
    document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: innerWidth },
  }
}, selectors)

const checkContrast = async (page, view) => {
  const selectors = {
    welcome: ['.figma-welcome-main h1', '.figma-welcome-main p', '.figma-welcome-actions .btn-primary', '.figma-welcome-actions .btn-ghost', '.figma-welcome-sample'],
    'sign-in': ['.display', '.lede', '.field label', '#email', '#password', '.btn-primary', '.btn-quiet'],
    feed: ['.page:not([aria-hidden]) .card-title', '.page:not([aria-hidden]) .card-summary', '.page:not([aria-hidden]) .rb-meta', '.page:not([aria-hidden]) .rec-reason', '.page:not([aria-hidden]) .rec-head strong'],
    profile: ['.figma-profile-header h1', '.figma-profile-person h2', '.figma-profile-person p', '.figma-profile-assistant-copy small', '.figma-profile-row'],
    classic: ['.cl-title', '.cl-meta', '.cl-when', '.cl-section h2'],
    compose: ['.sheet-title', '.sheet-hint', '.sheet .field label'],
    'compose-preview': ['.sheet-title', '.sheet .field label', '.sheet .form-note'],
  }[view] || []
  const values = await page.evaluate((selectors) => {
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number)
    const luminance = c => c.slice(0,3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n,v,i) => n + v * [.2126,.7152,.0722][i], 0)
    return selectors.map(selector => {
      const node = document.querySelector(selector)
      if (!node) throw new Error(`Missing contrast target: ${selector}`)
      const fg = rgb(getComputedStyle(node).color)
      let bg = [17,18,20], opacity = 1
      for(let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), color = rgb(style.backgroundColor)
        opacity *= Number(style.opacity)
        if (color.length === 3 || color[3] === 1) { bg = color; break }
      }
      const a = luminance(fg), b = luminance(bg)
      return { selector, foreground:fg, background:bg, opacity, ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05) }
    })
  }, selectors)
  for (const value of values) assert(value.ratio >= 4.5, `${view} unreadable text: ${value.selector}, contrast ${value.ratio.toFixed(2)}:1`)
  return values
}

try {
  for (const colorScheme of ['light', 'dark']) for (const viewport of viewports) {
    const label = `${colorScheme}-${viewport.width}x${viewport.height}`
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block' })
    // Fresh context: no saved session, account cookies, or browser storage are loaded.
    await context.route('**/*', (route) => {
      const request = route.request(), url = new URL(request.url())
      const isStatic = ['GET', 'HEAD'].includes(request.method()) && !['fetch', 'xhr'].includes(request.resourceType())
      if (url.origin !== base.origin || !isStatic) {
        blockedRequests.push({ viewport: label, kind: 'http', method: request.method(), url: `${url.origin}${url.pathname}` })
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    await context.routeWebSocket(/.*/, (socket) => {
      const url = new URL(socket.url()), httpOrigin = new URL(url.href.replace(/^ws/, 'http')).origin
      // Vite's own development connection is infrastructure, not the app relay.
      // A production preview opens none. Every other socket is blocked and fails QA.
      if (httpOrigin === base.origin && url.searchParams.has('token') && url.pathname === base.pathname) {
        allowedDevelopmentSockets++
        socket.connectToServer()
      } else {
        blockedRequests.push({ viewport: label, kind: 'websocket', url: `${url.origin}${url.pathname}` })
        socket.close()
      }
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => runtimeErrors.push({ viewport: label, message: error.message }))
    const current = '.feed .page:not([aria-hidden="true"])'
    const nav = () => page.locator('.tabbar')
    const home = () => nav().locator('[data-tab="feed"]').click()
    const profile = () => nav().locator('[data-tab="you"]').click()
    const checkpoint = async (name, test) => {
      const result = { viewport, colorScheme, check: name, result: 'passed', screenshot: `${label}-${name}.png` }
      try {
        await test(result)
        if (colorScheme === 'dark') result.contrast = await checkContrast(page, name)
        console.log(`PASS ${label} ${name}`)
      } catch (error) {
        result.result = 'failed'
        result.error = error instanceof Error ? error.message : String(error)
        console.error(`FAIL ${label} ${name}: ${result.error}`)
      }
      await ready(page).catch(() => {})
      await page.screenshot({ path: path.join(output, result.screenshot) }).catch((error) => {
        result.result = 'failed'; result.screenshotError = error.message
      })
      results.push(result)
    }
    try {
      await checkpoint('welcome', async (result) => {
        await page.goto(welcomeURL.href, { waitUntil: 'networkidle' })
        await page.locator('.figma-welcome-main h1').waitFor()
        await ready(page)
        const g = await geometry(page, {
          logo: '.figma-welcome-main img', title: '.figma-welcome-main h1',
          intro: '.figma-welcome-main', actions: '.figma-welcome-actions',
          start: '.figma-welcome-actions button:nth-of-type(1)',
          signIn: '.figma-welcome-actions button:nth-of-type(2)',
          sample: '.figma-welcome-actions button:nth-of-type(3)',
        })
        result.geometry = g
        for (const name of ['logo', 'title', 'intro', 'actions', 'start', 'signIn', 'sample']) centered(g[name], viewport, `Welcome ${name}`)
        noHorizontalOverflow(g.document, 'Welcome document')
        noHorizontalOverflow(g.title, 'Welcome title')
        assert(g.intro.bottom <= g.actions.top + tolerance, 'Welcome introduction overlaps its actions')
        assert(g.intro.top >= -tolerance, 'Welcome introduction extends above the viewport')
        for (const name of ['actions', 'start', 'signIn', 'sample']) {
          assert(g[name].top >= -tolerance && g[name].bottom <= viewport.height + tolerance, `Welcome ${name} is not fully inside the viewport`)
        }
      })
      await checkpoint('sign-in', async (result) => {
        await page.getByRole('button', { name: 'I already have an account', exact: true }).click()
        await page.getByLabel('Email', { exact: true }).fill('visual-check@honmaru.invalid')
        await page.getByRole('button', { name: 'Use a password instead', exact: true }).click()
        await page.getByLabel('Password', { exact: true }).fill('Visual-check-only')
        await ready(page)
        const g = await geometry(page, { body: '.auth-screen .screen-body', email: '#email', password: '#password', submit: '.auth-screen button[type=submit]' })
        result.geometry = g
        for (const name of ['body', 'email', 'password', 'submit']) centered(g[name], viewport, `Sign-in ${name}`)
        noHorizontalOverflow(g.document, 'Sign-in document')
        assert(g.submit.bottom <= viewport.height, 'Sign-in action extends below viewport')
        // No credentials are submitted; this is only an editable form check.
      })
      await page.goto(sampleURL.href, { waitUntil: 'networkidle' })
      await page.locator(`${current} .card`).waitFor()
      await checkpoint('feed', async (result) => {
        await ready(page)
        const g = await geometry(page, {
          recommendation: `${current} .recommendation`, card: `${current} .card`, title: `${current} .card-title`, summary: `${current} .card-summary`,
          topbar: '.topbar', actions: `${current} .decide-row`, ask: `${current} .ask-bar`, nav: '.tabbar',
        })
        result.geometry = g
        for (const name of ['card', 'topbar', 'actions', 'ask', 'nav']) centered(g[name], viewport, name)
        for (const name of ['document', 'card', 'title', 'summary']) noHorizontalOverflow(g[name], name)
        assert(g.title.left >= g.card.left - tolerance && g.title.right <= g.card.right + tolerance, 'Title extends outside its card')
        assert(g.summary.left >= g.card.left - tolerance && g.summary.right <= g.card.right + tolerance, 'Summary extends outside its card')
        assert(g.topbar.top >= -tolerance && g.topbar.bottom <= g.card.top + tolerance, 'Topbar overlaps the visible card')
        if (viewport.width >= 900) assert(g.recommendation.bottom <= g.card.bottom + tolerance, 'Standard desktop recommendation is clipped')
        assert(g.card.bottom <= g.actions.top + tolerance, 'Card overlaps decision actions')
        assert(g.actions.bottom <= g.ask.top + tolerance, 'Decision actions overlap the composer')
        assert(g.ask.bottom + clearance <= g.nav.top + tolerance, `Composer needs at least ${clearance}px clearance above navigation`)
        assert(g.nav.bottom <= viewport.height + tolerance && g.ask.top >= 0, 'Composer or navigation is outside the viewport')
      })
      await checkpoint('profile', async (result) => {
        await profile()
        await page.locator('.figma-profile-identity').waitFor()
        await ready(page)
        const g = await geometry(page, { body: '.figma-profile-body', identity: '.figma-profile-identity', nav: '.tabbar' })
        result.geometry = g
        for (const name of ['body', 'identity', 'nav']) centered(g[name], viewport, `Profile ${name}`)
        noHorizontalOverflow(g.document, 'Profile document')
        noHorizontalOverflow(g.body, 'Profile content')
        assert(await nav().isVisible(), 'Profile navigation is not visible')
      })
      await checkpoint('classic', async (result) => {
        await home()
        assert.equal(await page.locator('.figma-profile').count(), 0, 'Profile Home navigation did not close Profile')
        await page.getByRole('tab', { name: 'Classic', exact: true }).click()
        await page.locator('.classic-inner').waitFor()
        await ready(page)
        const g = await geometry(page, { content: '.classic-inner', header: '.cl-workspace-header', nav: '.tabbar' })
        result.geometry = g
        for (const name of ['content', 'header', 'nav']) centered(g[name], viewport, `Classic ${name}`)
        noHorizontalOverflow(g.document, 'Classic document')
        noHorizontalOverflow(g.content, 'Classic content')
      })
      const dialog = page.getByRole('dialog', { name: 'Tell your AI', exact: true })
      const inspectDialog = async (result) => {
        await dialog.waitFor()
        await ready(page)
        const g = await geometry(page, { dialog: '.sheet[role="dialog"]', actions: '.sheet[role="dialog"] .compose-actions' })
        result.geometry = g
        centered(g.dialog, viewport, 'Compose dialog')
        noHorizontalOverflow(g.document, 'Compose document')
        noHorizontalOverflow(g.dialog, 'Compose dialog')
        assert(g.dialog.top >= -tolerance && g.dialog.bottom <= viewport.height + tolerance, 'Compose dialog extends beyond the viewport vertically')
        assert(g.actions.top >= g.dialog.top - tolerance && g.actions.bottom <= g.dialog.bottom + tolerance, 'Compose actions are not visible inside the dialog')
        if (viewport.width >= 1024) near(g.dialog.centerY, viewport.height / 2, 'Desktop compose dialog vertical center')
      }
      await checkpoint('compose', async (result) => {
        await profile()
        await nav().locator('[data-tab="compose"]').click()
        assert.equal(await page.locator('.figma-profile').count(), 0, 'Profile compose navigation did not close Profile')
        await inspectDialog(result)
      })
      await checkpoint('compose-preview', async (result) => {
        await dialog.getByLabel('Recipient', { exact: true }).selectOption('sample:maya')
        await dialog.getByLabel('What needs your attention?', { exact: true }).fill('Please review the updated launch plan before Thursday. Confirm the owner and share any remaining questions.')
        await dialog.getByRole('button', { name: 'Review request', exact: true }).click()
        await dialog.getByLabel('Subject', { exact: true }).waitFor()
        await inspectDialog(result)
        // Preview remains a local draft. This test never presses Send.
      })
    } catch (error) {
      results.push({ viewport, check: 'navigation', result: 'failed', error: error instanceof Error ? error.message : String(error) })
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}

const failed = results.filter((result) => result.result === 'failed')
const passed = failed.length === 0 && runtimeErrors.length === 0 && blockedRequests.length === 0
await writeFile(path.join(output, 'checks.json'), JSON.stringify({
  startedAt, checkedAt: new Date().toISOString(), result: passed ? 'passed' : 'failed',
  environment: 'Fresh local Welcome and sample contexts; no account state, Worker, or external provider used',
  viewports, constraints: { roundingToleranceCSSPixels: tolerance, centerToleranceCSSPixels: centerTolerance, minimumComposerNavigationClearanceCSSPixels: clearance },
  checksPassed: results.length - failed.length, checksFailed: failed.length,
  runtimeErrors, blockedRequests, allowedDevelopmentSockets, checks: results,
  limitations: 'Browser geometry and sample navigation only; no external integration, production deployment, or physical-device qualification',
}, null, 2) + '\n')
assert(passed, `Layout QA failed: ${failed.length} checks, ${runtimeErrors.length} runtime errors, ${blockedRequests.length} unexpected requests. See ${path.join(output, 'checks.json')}`)
console.log(`Responsive layout checks passed: ${results.length}; evidence: ${output}`)
