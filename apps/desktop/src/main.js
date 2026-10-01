// Honmaru AI for the desktop: the web app in its own window, with what a
// browser tab cannot do — it stays running in the tray when closed (so
// notifications keep coming, as Discord's does), shows the unread count on
// the taskbar or dock, opens honmaru:// links, and remembers where it was.
//
// Security baseline (docs/architecture/discord-model-platform-plan.md §11.4):
// context isolation, a sandboxed renderer without Node, a two-call preload,
// permissions only for the app's own origin, a Content-Security-Policy on the
// app's pages, navigation kept to the app, the API and sign-in, and every
// other link sent to the browser.

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerMonitor, screen, session, shell } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowedOrigins, apiOriginsFrom, appUrlFrom, updatesEnabled } from './config.js'
import { buildCsp, withCsp } from './csp.js'
import { PROTOCOL, deepLinkToHash, deepLinkToUrl, isSafeExternal, linkFromArgv, navigationDecision, windowTitle } from './links.js'
import { countFromTitle, shouldAttract, trayTooltip } from './badge.js'
import { fitBounds, loadWindowState, saveWindowState, MIN_SIZE } from './windowState.js'
import { crashVerdict } from './crashes.js'
import { startUpdates } from './updates.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const asset = (name) => path.join(here, '..', 'assets', name)

const APP_ID = 'com.honmaru.ai'
const APP_NAME = 'Honmaru AI'
// `--app-url`, HONMARU_APP_URL and HONMARU_API_ORIGINS count only while
// developing (`npm start`, `npm run dev`): an installed app always loads the
// production web app and talks to the production API.
const PACKAGED = app.isPackaged
const APP_URL = appUrlFrom(process.env, process.argv, { packaged: PACKAGED })
const APP_ORIGIN = new URL(APP_URL).origin
const ORIGINS = allowedOrigins(APP_URL, process.env, { packaged: PACKAGED })
const API_ORIGINS = apiOriginsFrom(process.env, { packaged: PACKAGED })
/// The policy the shell adds to the app's pages (src/csp.js). Vite's dev
/// server needs inline scripts for hot reload; that is the only time it gets
/// them.
const CSP = buildCsp({ apiOrigins: API_ORIGINS, dev: !PACKAGED && APP_URL.startsWith('http:') })
/// What the app's own pages may ask for: notifications, a microphone and
/// camera for Jam calls, full screen, and writing to the clipboard.
const PERMISSIONS = new Set(['notifications', 'media', 'fullscreen', 'clipboard-sanitized-write'])
/// How long a blank window a page opened may wait to be pointed somewhere
/// before it is closed.
const BLANK_CHILD_MS = 30 * 1000

let win = null
let tray = null
let quitting = false
let count = 0
let pendingLink = linkFromArgv(process.argv)
// Whether the window has the app loaded and running, so a link can move it
// by its hash instead of loading it again.
let appLoaded = false

// Windows shows a notification only for an app with an identity, and groups
// the taskbar under it.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
app.setName(APP_NAME)

// honmaru:// opens this app. While developing (`electron .`) the command
// has to carry the script path for Windows to start it the same way.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function openLink(link) {
  const url = deepLinkToUrl(link, APP_URL)
  if (!url) return
  if (!win) { pendingLink = link; return }
  showWindow()
  // With the app already running, the link moves it by its hash route, as a
  // click inside the app would: no reload, so a half-written message stays.
  // Only a window that is not on the app (still loading, failed, mid
  // sign-in) loads the link's address afresh.
  if (appLoaded && onAppPage()) {
    const hash = deepLinkToHash(link)
    if (hash) {
      win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => { void win?.loadURL(url) })
    }
    return
  }
  void win.loadURL(url)
}

function onAppPage() {
  try { return Boolean(win) && new URL(win.webContents.getURL()).origin === APP_ORIGIN } catch { return false }
}

// ---- The count: taskbar, dock, tray ----

let overlay = null
function setCount(next) {
  const previous = count
  count = next
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(next)
  if (process.platform === 'win32' && win) {
    overlay ||= nativeImage.createFromPath(asset('overlay.png'))
    win.setOverlayIcon(next > 0 ? overlay : null, next > 0 ? trayTooltip(next, APP_NAME) : '')
  }
  tray?.setToolTip(trayTooltip(next, APP_NAME))
  if (win && shouldAttract(previous, next, win.isFocused())) {
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    else win.flashFrame(true)
  }
}

// ---- Where a window may go ----

/// Guards every page this app ever shows: the main window, and any window a
/// page opens (connecting a tool opens a blank one, then points it at the
/// tool's sign-in — that goes to the browser, and the blank one closes).
function guard(contents, { child = false } = {}) {
  // A company sign-in in progress: the one identity provider origin the API
  // redirected this window to, and until when (src/links.js).
  let signIn = null
  let startedAt = ''
  const decide = (event, target, redirect) => {
    const d = navigationDecision({ target, from: startedAt || contents.getURL(), origins: ORIGINS, apiOrigins: API_ORIGINS, signIn, redirect })
    signIn = d.signIn
    if (d.allow && !(child && new URL(target).origin !== APP_ORIGIN)) return
    event.preventDefault()
    if ((d.external || child) && isSafeExternal(target)) void shell.openExternal(target)
    if (child) BrowserWindow.fromWebContents(contents)?.close()
  }
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) startedAt = details.url
  })
  contents.on('will-navigate', (event) => decide(event, event.url, false))
  contents.on('will-redirect', (event) => decide(event, event.url, true))
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    // A blank window, to be pointed somewhere once the page knows where:
    // allowed, hidden, and guarded like a child.
    if (url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: webPreferences() } }
    }
    let origin = ''
    try { origin = new URL(url).origin } catch { return { action: 'deny' } }
    if (origin === APP_ORIGIN) { void win?.loadURL(url); return { action: 'deny' } }
    if (isSafeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (childWindow) => {
    guard(childWindow.webContents, { child: true })
    // A blank window the page never pointed anywhere (the tool's address
    // never came back) would otherwise stay open, hidden, for good.
    const timer = setTimeout(() => {
      if (childWindow.isDestroyed()) return
      const url = childWindow.webContents.getURL()
      if (!url || url === 'about:blank') childWindow.close()
    }, BLANK_CHILD_MS)
    childWindow.on('closed', () => clearTimeout(timer))
  })
}

function webPreferences() {
  return {
    preload: path.join(here, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: true,
    // Hidden in the tray, the socket and its timers keep running: that is
    // what lets a message arrive as a notification.
    backgroundThrottling: false,
  }
}

/// Every response from the app's own origin carries the policy, added beside
/// whatever the server sent.
function enforceCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: withCsp(details.responseHeaders, details.url, { appOrigin: APP_ORIGIN, policy: CSP }) })
  })
}

function lockPermissions() {
  const ours = (url) => {
    try { return new URL(url).origin === APP_ORIGIN } catch { return false }
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(PERMISSIONS.has(permission) && ours(details.requestingUrl || contents.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    return PERMISSIONS.has(permission) && ours(requestingOrigin || contents?.getURL() || '')
  })
}

// ---- The window ----

function createWindow() {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json')
  const saved = loadWindowState(stateFile)
  const bounds = fitBounds(saved.bounds, screen.getAllDisplays().map((d) => d.workArea))
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: APP_NAME,
    icon: asset('icon.png'),
    backgroundColor: '#1a1d21',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: webPreferences(),
  })
  if (saved.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())

  guard(win.webContents)
  // On the app the title is the page's, and carries the count. Anywhere else
  // (a sign-in) it names the site instead, as the window has no address bar.
  win.webContents.on('page-title-updated', (event, title) => {
    if (onAppPage()) { setCount(countFromTitle(title)); return }
    event.preventDefault()
    win?.setTitle(windowTitle({ url: win.webContents.getURL(), appOrigin: APP_ORIGIN, pageTitle: title, appName: APP_NAME }))
  })
  win.webContents.on('did-navigate', (_event, url) => {
    if (!onAppPage()) win?.setTitle(windowTitle({ url, appOrigin: APP_ORIGIN, appName: APP_NAME }))
  })
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) appLoaded = false
  })
  win.webContents.on('did-finish-load', () => { appLoaded = onAppPage() })
  // A navigation the guard stopped reports as aborted (-3) while the app is
  // still there; anything else means it did not load.
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) appLoaded = false
  })

  // A renderer that dies is reloaded — unless it keeps dying (src/crashes.js),
  // when reloading again would only loop: then the app says so and lets the
  // person try again or quit.
  let crashes = []
  win.webContents.on('render-process-gone', (_event, details) => {
    appLoaded = false
    if (details.reason === 'clean-exit') return
    const verdict = crashVerdict(crashes, Date.now())
    crashes = verdict.history
    if (verdict.reload) { win?.webContents.reload(); return }
    showWindow()
    void dialog.showMessageBox(win, {
      type: 'error',
      title: APP_NAME,
      message: `${APP_NAME} keeps stopping`,
      detail: `The page stopped ${crashes.length} times in a minute (${details.reason}), so it was not reloaded again. Try again, or quit and start ${APP_NAME} later.`,
      buttons: ['Try again', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) { crashes = []; win?.webContents.reload() } else { quitting = true; app.quit() }
    })
  })
  win.on('focus', () => win?.flashFrame(false))

  let saveTimer = null
  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (win) saveWindowState(stateFile, { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() })
    }, 400)
  }
  win.on('resize', remember)
  win.on('move', remember)
  win.on('maximize', remember)
  win.on('unmaximize', remember)

  // Closing hides it: it keeps running in the tray, and notifications keep
  // arriving. Quit from the tray or the menu ends it.
  win.on('close', (event) => {
    if (win) saveWindowState(stateFile, { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() })
    if (quitting) return
    event.preventDefault()
    win?.hide()
  })
  win.on('closed', () => { win = null; appLoaded = false })
  // Windows logging off, restarting or shutting down: the window has to close
  // rather than hide, or it holds up the session ending.
  win.on('query-session-end', () => { quitting = true })
  win.on('session-end', () => { quitting = true; app.quit() })

  const first = pendingLink ? deepLinkToUrl(pendingLink, APP_URL) : null
  pendingLink = null
  void win.loadURL(first || APP_URL)
}

/// Updates to the shell, in an installed app built by the signed release
/// scripts only (src/updates.js). They mark the packaged package.json.
let updateService
function checkForUpdates() {
  let metadata = {}
  try { metadata = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) } catch { /* no marker, no updates */ }
  if (!updatesEnabled({ packaged: PACKAGED, metadata })) return
  return startUpdates({ appName: APP_NAME, getWindow: () => win, beforeRestart: () => { quitting = true }, version: app.getVersion(), japanese: app.getLocale().startsWith('ja') })
    .catch((error) => console.warn('Updates are off:', error?.message || error))
}

function createTray() {
  // The menu bar on a Mac has the dock instead; a tray icon there is noise.
  if (process.platform === 'darwin') return
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')))
  tray.setToolTip(trayTooltip(count, APP_NAME))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', showWindow)
}

function createMenu() {
  const isMac = process.platform === 'darwin'
  const view = [
    { role: 'reload' },
    { role: 'forceReload' },
    ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: APP_NAME, submenu: [
      { role: 'about' },
      { label: `${app.getLocale().startsWith('ja') ? 'バージョン' : 'Version'} ${app.getVersion()}`, enabled: false },
      { label: app.getLocale().startsWith('ja') ? 'アップデートを確認…' : 'Check for Updates…', click: async () => {
        const service = await updateService
        if (service) await service.check(true)
        else await dialog.showMessageBox({ type: 'info', message: app.getLocale().startsWith('ja') ? 'このビルドでは自動更新を利用できません' : 'Updates are unavailable in this build' })
      } },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] }] : [{ label: 'File', submenu: [{ label: 'Quit', accelerator: 'Ctrl+Q', click: () => { quitting = true; app.quit() } }] }]),
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { role: 'windowMenu' },
  ]))
}

// ---- The page's two calls ----

ipcMain.on('honmaru:show', (event) => {
  // Only the app's own page may bring the window forward.
  if (win && event.sender === win.webContents && new URL(event.senderFrame?.url || win.webContents.getURL()).origin === APP_ORIGIN) showWindow()
})

ipcMain.on('honmaru:notification-settings', (event) => {
  if (!win || event.sender !== win.webContents) return
  try { if (new URL(event.senderFrame?.url || '').origin !== APP_ORIGIN) return } catch { return }
  if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
  else if (process.platform === 'win32') void shell.openExternal('ms-settings:notifications')
})

// ---- One app, however many times it is started ----

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const link = linkFromArgv(argv)
    if (link) openLink(link)
    else showWindow()
  })
  // macOS hands links over as an event, possibly before the app is ready.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (win) openLink(url)
    else pendingLink = url
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault())
  })
  app.on('before-quit', () => { quitting = true })
  app.on('activate', () => { if (win) showWindow(); else createWindow() })
  app.on('window-all-closed', () => {
    // Only when quitting: closing the window hides it.
    if (quitting) app.quit()
  })
  app.whenReady().then(() => {
    // macOS and Linux shutting down: the same, through the power monitor
    // (which can only be used once the app is ready).
    powerMonitor.on('shutdown', () => { quitting = true; app.quit() })
    enforceCsp()
    lockPermissions()
    createMenu()
    createWindow()
    createTray()
    updateService = checkForUpdates()
  })
}
