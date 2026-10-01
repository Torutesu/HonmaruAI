import { t } from './i18n'
import { getLocale, primary } from './locale'
import { desktopNotificationsEnabled } from './desktopNotifications'
import { desktopApp, bringForward } from './desktop'
import { isQuiet } from './quiet'

// The tab's own notifications, for while the app is open but not in front:
// a decision for you, a direct message, an @mention. Web Push (utils/push.ts)
// is the channel that works with the tab closed; these are the ones that
// arrive the moment the socket hears them, a push's delay sooner.
//
// They are shown through the service worker, not `new Notification()`:
// Chrome on Android throws on the constructor, and a notification the worker
// shows gets the worker's click handling (sw.js) — the right workspace, the
// right conversation, the tab brought forward. They carry the same tag as
// the Worker's push for the same thing (`<cardId>`, `<orgId>|<view>`), so the
// push that follows replaces this one quietly instead of ringing twice
// (sw.js checks the id before it rings again).
//
// All no-ops where unsupported or not permitted.

/// The same words, written by the Worker in the reader's language — which
/// this page's own tables have only for the five languages its screens are
/// in. Taken from GET /me.
type NotificationCopy = { locale: string; newDecision: string; from: string }
let serverCopy: NotificationCopy | null = null

export function setNotificationCopy(copy: NotificationCopy | null | undefined): void {
  if (copy && typeof copy.newDecision === 'string' && typeof copy.from === 'string') serverCopy = copy
}

function words(from: string): { heading: string; byline: string } {
  // Only while it is still the language being read: a language changed since
  // /me was read goes back to the page's own table until it is read again.
  if (serverCopy && serverCopy.locale === primary(getLocale())) {
    return { heading: serverCopy.newDecision, byline: serverCopy.from.replace('{name}', from) }
  }
  return { heading: t('New decision for you'), byline: t('From {name}', { name: from }) }
}

const ICON = '/icon-192.png'
const BADGE = '/badge-96.png'

function permitted(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted' && (!desktopApp() || desktopNotificationsEnabled())
}

/// The person is looking at this tab, in a window that has focus.
export function lookingHere(): boolean {
  if (typeof document === 'undefined') return false
  if (document.visibilityState !== 'visible') return false
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true
}

// ---- Which tab speaks for a workspace ----
//
// Several tabs may be open, on one workspace or on several. For each
// workspace exactly one tab shows its notifications (a Web Lock per
// workspace, so a tab on another workspace never silences it), and that tab
// stays quiet while any tab on the same workspace is being looked at (each
// tab says so on a BroadcastChannel). Without Web Locks every tab notifies;
// the shared tags still make that one notification.

type Locks = { request: (name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) => Promise<void> }
const locksHere = (): Locks | undefined => (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: Locks }).locks : undefined)

const tabId = Math.random().toString(36).slice(2)
/// Other tabs being looked at right now, and the workspace each is on.
const lookers = new Map<string, string>()
let watching: string | null = null
let lead = true
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('honmaru-looking') : null
// Node (the tests) keeps a process alive for an open channel; a page does not care.
;(channel as unknown as { unref?: () => void } | null)?.unref?.()

// A tab that crashes while being read never says it stopped. So each tab
// holds a lock named after itself for as long as it lives — the browser
// frees it when the tab goes, however it went — and the others wait on that
// lock to forget it.
let holdingOwnLock = false
function holdOwnLock(): void {
  if (holdingOwnLock) return
  const locks = locksHere()
  if (!locks?.request) return
  holdingOwnLock = true
  locks.request(`honmaru-tab:${tabId}`, {}, () => new Promise<void>(() => { /* held while the tab lives */ })).catch(() => { holdingOwnLock = false })
}
const followed = new Set<string>()
function follow(id: string): void {
  const locks = locksHere()
  if (!locks?.request || followed.has(id)) return
  followed.add(id)
  locks.request(`honmaru-tab:${id}`, {}, async () => { lookers.delete(id); followed.delete(id) }).catch(() => { followed.delete(id) })
}

function announce(looking = lookingHere()): void {
  if (looking) markSeen()
  channel?.postMessage({ type: 'looking', id: tabId, orgId: watching, looking })
}

if (channel) {
  channel.onmessage = (event: MessageEvent) => {
    const d = event.data || {}
    if (typeof d.id !== 'string' || d.id === tabId) return
    // A tab just opened asks where everyone is.
    if (d.type === 'hello') { announce(); return }
    if (d.type !== 'looking') return
    if (d.looking && typeof d.orgId === 'string') { lookers.set(d.id, d.orgId); follow(d.id) }
    else lookers.delete(d.id)
  }
}

/// Someone is reading this workspace: in this tab, or in another one.
export function someoneLookingAt(orgId: string): boolean {
  if (lookingHere()) return true
  for (const org of lookers.values()) if (org === orgId) return true
  return false
}

/// Whether this tab should show a notification for `orgId` now.
function mayNotify(orgId?: string): boolean {
  if (!orgId || watching === null) return !lookingHere()
  return lead && !someoneLookingAt(orgId)
}

/// This tab is showing `orgId`: take part in choosing the tab that notifies
/// for it, and tell the other tabs whenever this one is looked at or left.
/// Returns the cleanup, for when the tab moves to another workspace.
export function watchWorkspace(orgId: string): () => void {
  watching = orgId
  // Before the first announcement, so any tab that hears it can wait on it.
  holdOwnLock()
  const locks = locksHere()
  const abort = typeof AbortController !== 'undefined' ? new AbortController() : null
  let release: (() => void) | null = null
  if (locks?.request) {
    lead = false
    locks.request(`honmaru-notify:${orgId}`, { signal: abort?.signal }, () => {
      // Granted after this tab already moved on: let the next one have it.
      if (watching !== orgId) return Promise.resolve()
      lead = true
      return new Promise<void>((resolve) => { release = resolve })
    }).catch(() => { /* aborted, or no locks here after all */ })
  } else {
    lead = true
  }
  // Focus moving into a frame of this page (a video player in a link card)
  // blurs the window while the person is still reading here. So a blur is
  // judged once it has settled, and while a frame holds focus — when no
  // later event will say it left — it is looked at again every second.
  let poll: ReturnType<typeof setInterval> | null = null
  let settle: ReturnType<typeof setTimeout> | null = null
  const stopWatching = () => {
    if (poll) { clearInterval(poll); poll = null }
    if (settle) { clearTimeout(settle); settle = null }
  }
  const onChange = () => { stopWatching(); announce() }
  const onBlur = () => {
    stopWatching()
    settle = setTimeout(() => {
      settle = null
      const still = lookingHere()
      announce(still)
      if (still) poll = setInterval(() => { if (!lookingHere()) { stopWatching(); announce(false) } }, 1000)
    }, 0)
  }
  const onLeave = () => channel?.postMessage({ type: 'looking', id: tabId, orgId, looking: false })
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onChange)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onLeave)
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onChange)
  channel?.postMessage({ type: 'hello', id: tabId })
  announce()
  return () => {
    stopWatching()
    onLeave()
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onChange)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onLeave)
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onChange)
    if (watching === orgId) watching = null
    lead = true
    release?.()
    abort?.abort()
  }
}

const directNotifications = new Map<string, { notification: Notification; data: Record<string, unknown> }>()

interface Shown { tag: string; body: string; data: Record<string, unknown>; renotify?: boolean; timestamp?: number }

/// Show one, through the service worker when there is one, else directly —
/// with a click that brings this tab forward.
function show(title: string, { tag, body, data, renotify = false, timestamp = Date.now() }: Shown): void {
  const options = { body, tag, data, icon: ICON, badge: BADGE, renotify, timestamp } as NotificationOptions
  const direct = () => {
    try {
      directNotifications.get(tag)?.notification.close()
      const n = new Notification(title, options)
      directNotifications.set(tag, { notification: n, data })
      n.onclose = () => { if (directNotifications.get(tag)?.notification === n) directNotifications.delete(tag) }
      n.onclick = () => {
        bringForward()
        n.close()
        const hash = typeof data.hash === 'string' ? data.hash : ''
        if (hash && typeof location !== 'undefined') location.hash = hash
      }
    } catch {
      // Chrome on Android throws: a phone without the worker gets the push.
    }
  }
  if (desktopApp()) { direct(); return }
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  if (!sw) { direct(); return }
  sw.getRegistration('/')
    .then((reg) => (reg ? reg.showNotification(title, options) : direct()))
    .catch(direct)
}

/// A decision now waiting on you. `cardId` makes it the same notification
/// as the Worker's push for this card.
export function notifyNewDecision(title: string, from: string, cardId?: string, orgId?: string): void {
  if (!permitted() || !mayNotify(orgId) || isQuiet()) return
  const { heading, byline } = words(from)
  show(heading, {
    tag: cardId || 'honmaru-decision',
    body: `${title}\n${byline}`,
    data: { cardId: cardId || null, orgId: orgId || null, kind: 'created', hash: cardId ? `#/feed/${encodeURIComponent(cardId)}${orgId ? `/${encodeURIComponent(orgId)}` : ''}` : '' },
  })
}

/// The sender also needs to hear that somebody answered their request.
export function notifyDecisionReply(title: string, cardId: string, orgId: string): void {
  if (!permitted() || !mayNotify(orgId) || isQuiet()) return
  show(t('A reply to your request'), {
    tag: cardId, body: title,
    data: { cardId, orgId, kind: 'decided', hash: `#/feed/${encodeURIComponent(cardId)}/${encodeURIComponent(orgId)}` },
  })
}

/// A ||spoiler|| — or an inline code span, matched first so the `||` of
/// `a || b` never pairs with a real spoiler's bars. A spoiler may hold code.
/// The same rule as the Worker's pushPreview (worker/src/pushes.js).
const SPOILER = /`[^`\n]+`|\|\|(?:`[^`\n]+`|[^|\n])+?\|\|/g

/// Marks taken off words, only where they stand at a word's edges: a
/// snake_case name, 2*3*4 and __init__.py stay as they are.
const unmark = (text: string) => text
  .replace(/(^|[\s(])(\*\*|__|~~)(\S(?:[^\n]*?\S)?)\2(?=$|[\s,!?)]|[.:;](?:\s|$))/g, '$1$3')
  .replace(/(^|[\s(])([*_~])([^*_~\n]+)\2(?=$|[\s.,!?)])/g, '$1$3')

/// What a message says, as a notification can show it: one line, marks
/// taken off, and a ||spoiler|| never given away. Inline code and links are
/// kept whole, as the chat itself shows them (MessageParts inline).
export function notificationText(body: string, max = 180): string {
  const flat = String(body || '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, '').trim())
    .replace(SPOILER, (m) => (m[0] === '`' ? m : '▇▇▇'))
    .replace(/^(?:#{1,3}|-#)\s+/gm, '')
    .replace(/^\s*(?:>|&gt;)\s?/gm, '')
    .split(/(`[^`\n]+`|https?:\/\/[^\s<>"）」]+)/)
    .map((part, i) => (i % 2 ? part.replace(/^`|`$/g, '') : unmark(part)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Mentions and direct messages that came in while the tab was not in front:
// they count in the title and on the icon until the tab is looked at again.
let away = 0
let pending = 0

/// A direct message or an @mention, while the tab is not in front. The
/// caller has decided it deserves one (utils/sound.ts soundForMessage says
/// "mention" — not muted, not yours, not a quiet channel message).
export function notifyMessage(m: { id: string; orgId: string; channel: string; author: string; where?: string | null; body: string; hasFiles?: boolean; createdAt?: string }): void {
  if (!permitted() || !mayNotify(m.orgId) || isQuiet()) return
  away += 1
  paintBadge()
  const at = Date.parse(m.createdAt || '')
  show(m.where ? `${m.author} · ${m.where}` : m.author, {
    tag: `${m.orgId}|${m.channel}`,
    body: notificationText(m.body) || (m.hasFiles ? '📎' : ''),
    // A new message in the same conversation replaces the last one and must
    // still be heard, as the Worker's pushes are.
    renotify: true,
    timestamp: Number.isFinite(at) ? at : Date.now(),
    // `at` is the server's time for the message: the Worker's push carries
    // the same, so the service worker can tell an older push from a newer
    // notification already on screen (sw.js showPush).
    data: { messageId: m.id, orgId: m.orgId, channel: m.channel, kind: 'message', at: m.createdAt || null, hash: `#/m/${encodeURIComponent(m.id)}/${encodeURIComponent(m.orgId)}` },
  })
}

/// These messages' notifications, taken down: they were read in Activity
/// (here or on another device), or unsent — a message taken back must not
/// stay on the lock screen.
export function closeMessageNotifications(ids: string[]): void {
  for (const [tag, item] of directNotifications) if (ids.includes(String(item.data.messageId || ''))) { item.notification.close(); directNotifications.delete(tag) }
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  if (!sw || !ids.length) return
  const wanted = new Set(ids)
  sw.getRegistration('/')
    .then((reg) => reg?.getNotifications())
    .then((list) => { for (const n of list || []) if (wanted.has((n.data as { messageId?: string } | null)?.messageId || '')) n.close() })
    .catch(() => { /* nothing shown, nothing to take down */ })
}

/// Cards that stopped waiting on you (decided here or anywhere): their
/// notifications are no longer true, so they come off the screen.
export function closeCardNotifications(cardIds: string[]): void {
  for (const tag of cardIds) { directNotifications.get(tag)?.notification.close(); directNotifications.delete(tag) }
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  if (!sw || !cardIds.length) return
  sw.getRegistration('/')
    .then((reg) => Promise.all(cardIds.map((tag) => reg?.getNotifications({ tag }))))
    .then((lists) => { for (const n of lists.flat()) if (n) n.close() })
    .catch(() => { /* nothing shown, nothing to take down */ })
}

// ---- The count: in the tab's title, on its icon, on the app's icon ----

const BASE_TITLE = 'Honmaru AI'

/// Decisions waiting on you. The title reads "(3) Honmaru AI"; the tab's
/// icon and an installed app's icon carry the same number.
export function setTabBadge(count: number): void {
  pending = Math.max(0, count | 0)
  paintBadge()
}

/// The tab is being looked at: what came in while it was away is seen.
export function markSeen(): void {
  if (!away) return
  away = 0
  paintBadge()
}

export function badgeCount(): number { return pending + away }

function paintBadge(): void {
  const count = badgeCount()
  if (typeof document !== 'undefined') document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE
  paintFavicon(count)
  // An installed app's icon (Chrome, Edge, Safari); a no-op in a plain tab.
  // A push sets it too, with the count across every workspace — this tab
  // knows only its own, so it never takes down a badge it did not put up.
  const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> } : null
  if (!nav?.setAppBadge || !nav.clearAppBadge) return
  if (count > 0) { appBadgeOurs = true; void nav.setAppBadge(count).catch(() => {}) }
  else if (appBadgeOurs) { appBadgeOurs = false; void nav.clearAppBadge().catch(() => {}) }
}
let appBadgeOurs = false

/// "9+" past nine, as every chat app's badge does.
export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

let faviconImage: HTMLImageElement | null = null
let faviconPainted = -1

function paintFavicon(count: number): void {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
  if (count === faviconPainted) return
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'))
  if (!links.length) return
  for (const link of links) if (!link.dataset.plain) link.dataset.plain = link.href
  faviconPainted = count
  if (count <= 0) {
    for (const link of links) if (link.dataset.plain) link.href = link.dataset.plain
    return
  }
  const draw = () => {
    if (faviconPainted !== count || !faviconImage || !faviconImage.naturalWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = 64; canvas.height = 64
    const g = canvas.getContext('2d')
    if (!g) return
    // A badge that cannot be drawn is no reason for the app to fall over.
    try { g.drawImage(faviconImage, 0, 0, 64, 64) } catch { return }
    const label = badgeLabel(count)
    const r = label.length > 1 ? 20 : 17
    g.beginPath()
    g.arc(64 - r, r, r, 0, Math.PI * 2)
    g.fillStyle = '#e5484d'
    g.fill()
    g.lineWidth = 4
    g.strokeStyle = '#ffffff'
    g.stroke()
    g.fillStyle = '#ffffff'
    g.font = `bold ${label.length > 1 ? 22 : 26}px system-ui, -apple-system, Segoe UI, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(label, 64 - r, r + 1)
    let url = ''
    try { url = canvas.toDataURL('image/png') } catch { return }
    for (const link of links) link.href = url
  }
  if (faviconImage?.complete && faviconImage.naturalWidth > 0) { draw(); return }
  // None yet, or one that failed to load (a broken image is "complete" too):
  // fetch it again rather than draw nothing forever.
  if (!faviconImage || faviconImage.complete) {
    faviconImage = new Image()
    faviconImage.src = ICON
  }
  faviconImage.addEventListener('load', draw, { once: true })
}
