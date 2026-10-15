// Where the desktop window may go, and what a honmaru:// link opens.
//
// Pure: no Electron here, so every rule is tested (test/links.test.js).

export const PROTOCOL = 'honmaru'

/// The paths a link may open (packages/core/src/links.ts LINK_PATH_PREFIXES):
/// the web app turns them into its own routes on load.
const LINK_HEADS = new Set(['c', 'join'])

/// A honmaru:// link as the web app's own address: `honmaru://c/b%3Ageneral?org=x`
/// → `<app>/c/b%3Ageneral?org=x`. The web app checks the channel and the
/// workspace itself (parseAppLink), so this only moves the path across. Any
/// other honmaru:// link opens the app at its start; anything else is null.
export function deepLinkToUrl(link, appUrl) {
  let url
  try { url = new URL(String(link || '')) } catch { return null }
  if (url.protocol !== `${PROTOCOL}:`) return null
  const target = new URL(appUrl)
  // A custom scheme puts the first segment in the host: honmaru://c/x.
  const head = url.host
  const rest = url.pathname.replace(/^\/+/, '')
  if (LINK_HEADS.has(head) && rest && !rest.includes('..')) {
    target.pathname = `/${head}/${rest}`
    const org = url.searchParams.get('org')
    if (head === 'c' && org) target.search = `?org=${encodeURIComponent(org)}`
  }
  return target.toString()
}

const decode = (part) => {
  try { return decodeURIComponent(part) } catch { return part }
}

/// A honmaru:// link as the web app's hash route, for a window that already
/// has the app open: setting the hash moves the app there without a reload,
/// so nothing typed but unsent is lost. The same routes as the web's own
/// (packages/core/src/links.ts webHashFor): `#/c/<channel>?org=<orgId>` and
/// `#/join/<code>`. Null for any other link, which then only shows the window.
export function deepLinkToHash(link) {
  let url
  try { url = new URL(String(link || '')) } catch { return null }
  if (url.protocol !== `${PROTOCOL}:`) return null
  const head = url.host
  const rest = decode(url.pathname.replace(/^\/+/, ''))
  if (!LINK_HEADS.has(head) || !rest || rest.includes('..')) return null
  if (head === 'join') return `#/join/${encodeURIComponent(rest)}`
  const org = url.searchParams.get('org')
  return `#/c/${encodeURIComponent(rest)}${org ? `?org=${encodeURIComponent(org)}` : ''}`
}

/// The first honmaru:// link among a process's arguments (Windows and Linux
/// hand a link to the app as an argument), or null.
export function linkFromArgv(argv) {
  return (argv || []).find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`)) || null
}

const originOf = (value) => {
  try { return new URL(value).origin } catch { return null }
}

/// Links that are safe to hand to the operating system: the web, and mail.
export function isSafeExternal(value) {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/// How long a company sign-in may stay on its identity provider's page: long
/// enough to type a password and approve a push, short enough that a window
/// left open does not keep the door open.
export const SIGN_IN_MS = 3 * 60 * 1000

/// Whether the app window may go to `target`.
///
/// - The app and the API (and GitHub, for sign-in) are always allowed.
/// - A company's sign-in leaves them: the API redirects to the company's
///   identity provider, which sends the person back to the API when done. A
///   navigation the API redirected elsewhere allows exactly that one origin,
///   over https, for `SIGN_IN_MS` — not any site: a link on the identity
///   provider's page to somewhere else opens in the browser. It ends the
///   moment the window is back on the app or the API.
/// - Anything else stays out of the window and opens in the browser.
///
/// `signIn` is the sign-in in progress (`{ origin, until }`) or null. `from`
/// is where the navigation started (for a redirect, the address the chain
/// began at). Returns `{ allow, external, signIn }`.
export function navigationDecision({ target, from, origins, apiOrigins, signIn = null, now = Date.now(), redirect = false }) {
  const to = originOf(target)
  let protocol = ''
  try { protocol = new URL(target).protocol } catch { /* not a URL */ }
  if (!to || (protocol !== 'https:' && protocol !== 'http:')) {
    return { allow: false, external: isSafeExternal(target), signIn }
  }
  if (origins.includes(to)) return { allow: true, external: false, signIn: null }
  if (protocol !== 'https:') return { allow: false, external: true, signIn }
  if (signIn && signIn.until > now && signIn.origin === to) return { allow: true, external: false, signIn }
  if (redirect && apiOrigins.includes(originOf(from))) {
    return { allow: true, external: false, signIn: { origin: to, until: now + SIGN_IN_MS } }
  }
  return { allow: false, external: true, signIn }
}

/// The window's title. On the app it is the page's own (which carries the
/// unread count); anywhere else — the API, GitHub, a company's sign-in — it
/// names the site, since the window has no address bar to show it.
export function windowTitle({ url, appOrigin, pageTitle = '', appName = 'Honmaru AI' }) {
  let parsed = null
  try { parsed = new URL(url) } catch { /* not a URL */ }
  if (!parsed || parsed.origin === appOrigin || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return pageTitle || appName
  return `${appName} — signing in at ${parsed.host}`
}

/// The Go menu: places in the app, each by its hash route, so a menu item or
/// its shortcut moves the open app there the way a click would. The harness
/// hub (docs/kylon-gap-plan.md) is where a workspace is switched between
/// Simple and Harness; Apps and Workflows show once it is a harness.
export function goMenuItems(locale = 'en') {
  const ja = String(locale || '').startsWith('ja')
  return [
    { label: ja ? 'フィード' : 'Feed', accelerator: 'CmdOrCtrl+1', hash: '#/feed' },
    { label: ja ? '履歴' : 'History', accelerator: 'CmdOrCtrl+2', hash: '#/history' },
    { label: ja ? 'ツール' : 'Tools', accelerator: 'CmdOrCtrl+3', hash: '#/tools' },
    { type: 'separator' },
    { label: ja ? 'ハーネス' : 'Harness', accelerator: 'CmdOrCtrl+Shift+H', hash: '#/harness' },
    { label: ja ? 'アプリ' : 'Apps', hash: '#/apps' },
    { label: ja ? 'ワークフロー' : 'Workflows', hash: '#/workflows' },
    { label: ja ? '承認' : 'Approvals', hash: '#/approvals' },
  ]
}

/// The Workspace menu: Simple or Harness (docs/kylon-gap-plan.md). Each
/// item asks the open app to switch, through its harness hub, which applies
/// it only for an admin and says why not to anyone else.
export function modeMenuItems(locale = 'en') {
  const ja = String(locale || '').startsWith('ja')
  return {
    label: ja ? 'ワークスペース' : 'Workspace',
    items: [
      { label: ja ? 'シンプルにする' : 'Switch to Simple', mode: 'simple' },
      { label: ja ? 'ハーネスにする' : 'Switch to Harness', mode: 'harness' },
    ],
  }
}

/// What the window runs to ask for a mode: leave the request for the hub
/// and open it, or, when the hub is already open, hand it the request.
/// Null for anything but the two modes, so nothing else reaches the page.
export function setModeScript(mode) {
  if (mode !== 'simple' && mode !== 'harness') return null
  const m = JSON.stringify(mode)
  return `(() => {
  if (location.hash === '#/harness') { window.dispatchEvent(new CustomEvent('honmaru:set-mode', { detail: ${m} })); return }
  try { sessionStorage.setItem('hx.wantMode', ${m}) } catch (e) {}
  location.hash = '#/harness'
})()`
}
