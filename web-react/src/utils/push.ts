// Web Push, from the browser's side.
//
// A subscription is a URL at a push service plus two keys, minted by this
// browser and handed to the Worker, which encrypts every notification to them.
// Nothing here works without a service worker, and on iOS nothing here works
// until the site has been added to the home screen — `pushSupport()` tells
// the UI which of those it is looking at.
//
// Firefox and Safari only show a permission prompt while the click that asked
// for it is still "the user's": any network wait before the prompt can spend
// that, and the prompt is then swallowed (Firefox shows a crossed-out bell in
// the address bar instead). So the prompt comes first, and the Worker's key is
// fetched ahead of time or alongside it — never before it.

import { getLocale } from './locale'
import { desktopApp } from './desktop'

/// `desktop`: inside the desktop app, which has no push service and keeps
/// the socket open from the tray instead (utils/desktop.ts).
export type PushSupport = 'ready' | 'needs-install' | 'unsupported' | 'denied' | 'desktop'
/// `dismissed`: the prompt was closed without an answer — ask again later.
/// `denied`: blocked for this site; only the browser's settings undo it.
export type EnableResult = 'on' | 'denied' | 'dismissed' | 'unavailable'

function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document)
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (desktopApp()) return 'desktop'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // Safari on iOS only exposes PushManager to an installed web app.
    return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  return 'ready'
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/// Was this subscription made with this key? A browser that does not say
/// (`options` missing) is taken at its word that it was.
export function sameServerKey(subscription: PushSubscription, publicKey: string): boolean {
  const had = subscription.options?.applicationServerKey
  if (!had) return true
  const a = new Uint8Array(had)
  const b = urlBase64ToUint8Array(publicKey)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

// ---- The Worker's public key, fetched before anyone clicks ----

const vapidKeys = new Map<string, Promise<string | null>>()

/// Fetch (once) the key pushes are signed with. Call it when the bell or the
/// settings screen appears, so the click has nothing to wait for. A failure
/// is not remembered: the next call tries again.
export function prefetchVapidKey(httpBase: string): Promise<string | null> {
  const cached = vapidKeys.get(httpBase)
  if (cached) return cached
  const request = fetch(`${httpBase}/push/vapid`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (data && typeof data.publicKey === 'string' && data.publicKey ? data.publicKey : null))
    .catch(() => null)
  vapidKeys.set(httpBase, request)
  void request.then((key) => { if (!key && vapidKeys.get(httpBase) === request) vapidKeys.delete(httpBase) })
  return request
}

// ---- Permission ----

/// The prompt, in both of its shapes: a promise everywhere current, a
/// callback in older Safari. Never throws; a browser that refuses to ask
/// answers with what it already has.
export function askPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    try {
      const maybe = Notification.requestPermission((answer) => resolve(answer))
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve(Notification.permission))
    } catch {
      resolve(Notification.permission)
    }
  })
}

// ---- The service worker ----

const READY_TIMEOUT_MS = 10_000

/// The registration once its worker is active: `subscribe()` rejects on a
/// registration whose worker is still installing, which is exactly the state
/// of the first visit.
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (!existing) await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('service worker did not start')), READY_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/// Is this browser already subscribed on this account? Cheap, no prompt.
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ready') return null
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    return reg ? await reg.pushManager.getSubscription() : null
  } catch {
    return null
  }
}

// ---- The key, kept for the service worker ----
//
// When a browser drops a subscription without saying which (Firefox for
// Android, Firefox before 137), the service worker subscribes again with the
// key kept here (sw.js pushsubscriptionchange). Kept only while push is on
// in this browser: turning it off forgets it, so nothing turns it back on.

const PUSH_KEY_CACHE = 'honmaru-push'
const PUSH_KEY = '/push-key'

async function keepKey(publicKey: string | null): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(PUSH_KEY_CACHE)
    if (publicKey) await cache.put(PUSH_KEY, new Response(publicKey))
    else await cache.delete(PUSH_KEY)
  } catch { /* storage refused: the next open resyncs instead */ }
}

async function keptKey(): Promise<string | null> {
  try {
    if (typeof caches === 'undefined') return null
    const hit = await (await caches.open(PUSH_KEY_CACHE)).match(PUSH_KEY)
    return hit ? (await hit.text()) || null : null
  } catch {
    return null
  }
}

/// Bumped when push is turned off here (Settings, or signing out), so an
/// enable or a resync that began before it cannot turn push back on when its
/// request comes back.
let generation = 0

/// The end of an enable or a resync: keep the key — unless push was turned
/// off meanwhile, in which case what was just handed over is taken back.
async function finish(started: number, publicKey: string, subscription: PushSubscription, httpBase: string, sessionToken: string): Promise<boolean> {
  if (started === generation) await keepKey(publicKey)
  if (started === generation) return true
  await keepKey(null)
  await forget(httpBase, sessionToken, subscription.endpoint)
  await subscription.unsubscribe().catch(() => false)
  return false
}

async function forget(httpBase: string, sessionToken: string, endpoint: string): Promise<void> {
  await fetch(`${httpBase}/push/subscriptions`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {})
}

/// A subscription made with the Worker's current key: the one the browser
/// has, or a fresh one when the key has changed since (a rotated key makes
/// the push service refuse every send, silently, forever).
async function subscriptionFor(reg: ServiceWorkerRegistration, publicKey: string, httpBase: string, sessionToken: string): Promise<PushSubscription> {
  const existing = await reg.pushManager.getSubscription()
  if (existing && sameServerKey(existing, publicKey)) return existing
  if (existing) {
    await forget(httpBase, sessionToken, existing.endpoint)
    await existing.unsubscribe().catch(() => false)
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
}

async function tellWorker(httpBase: string, sessionToken: string, subscription: PushSubscription): Promise<boolean> {
  const res = await fetch(`${httpBase}/push/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
    body: JSON.stringify(subscription.toJSON()),
  })
  return res.ok
}

/// Ask, subscribe, and tell the Worker. Call from a click: browsers only
/// honour a permission prompt that a person asked for. Never throws.
export async function enableWebPush(httpBase: string, sessionToken: string): Promise<EnableResult> {
  const support = pushSupport()
  if (support === 'denied') return 'denied'
  if (support !== 'ready') return 'unavailable'
  // Started now, awaited after the prompt: the network runs while the
  // person reads the prompt, and never stands between the click and it.
  const key = prefetchVapidKey(httpBase)
  const started = generation
  const permission = Notification.permission === 'granted' ? 'granted' : await askPermission()
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'dismissed'
  try {
    const publicKey = await key
    if (!publicKey) return 'unavailable'
    const reg = await activeRegistration()
    const subscription = await subscriptionFor(reg, publicKey, httpBase, sessionToken)
    if (!(await tellWorker(httpBase, sessionToken, subscription))) return 'unavailable'
    return (await finish(started, publicKey, subscription, httpBase, sessionToken)) ? 'on' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/// On every open: the subscription this browser already has, handed to the
/// Worker again (it keeps one row per endpoint, so this is an upsert), and
/// made again if the key changed — or if the browser dropped it while push
/// was on here (the key is still kept). Without this, a subscription the
/// Worker lost — pruned, re-bound on a shared computer, replaced by
/// Firefox — stops pushes with nothing on screen to say so.
/// Never prompts, never throws. Returns whether pushes will arrive.
export async function resyncWebPush(httpBase: string, sessionToken: string): Promise<boolean> {
  if (pushSupport() !== 'ready' || Notification.permission !== 'granted') return false
  // A tab left open from before someone else signed in (in another tab)
  // holds the old session: handing the Worker this browser's subscription
  // under it would send the new person's decisions to the old account.
  if (!sessionIsCurrent(sessionToken)) return false
  const started = generation
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    if (!reg) return false
    const existing = await reg.pushManager.getSubscription()
    if (!existing && !(await keptKey())) return false
    const publicKey = await prefetchVapidKey(httpBase)
    if (!publicKey) return false
    const subscription = existing && sameServerKey(existing, publicKey) ? existing : await subscriptionFor(reg, publicKey, httpBase, sessionToken)
    if (!(await tellWorker(httpBase, sessionToken, subscription))) return false
    return await finish(started, publicKey, subscription, httpBase, sessionToken)
  } catch {
    return false
  }
}

/// Whether this tab's session is still the one this browser signed in last
/// (or nobody has signed in since it ended).
export function sessionIsCurrent(sessionToken: string): boolean {
  try {
    const saved = localStorage.getItem('sessionToken')
    return !saved || saved === sessionToken
  } catch {
    return true
  }
}

/// Unsubscribe here and forget it on the Worker, so signing out on a shared
/// machine stops the next person seeing your decisions.
///
/// The subscription and its kept key are the browser's, not the session's:
/// once another session has signed in here — before this starts, or while it
/// waits — they are that one's, and are left alone.
export async function disableWebPush(httpBase: string, sessionToken: string): Promise<void> {
  if (!sessionIsCurrent(sessionToken)) return
  generation += 1
  await keepKey(null)
  const subscription = await currentSubscription()
  if (!subscription || !sessionIsCurrent(sessionToken)) return
  try {
    await forget(httpBase, sessionToken, subscription.endpoint)
  } finally {
    await subscription.unsubscribe().catch(() => {})
  }
}

/// Tell the Worker what language this browser reads, so notifications — on
/// any channel, not just this one — arrive in it.
export async function syncLocale(httpBase: string, sessionToken: string, locale?: string): Promise<void> {
  const tag = locale || getLocale()
  if (!tag) return
  try {
    await fetch(`${httpBase}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({ locale: tag }),
    })
  } catch {
    // Not fatal: the Worker seeded a locale from Accept-Language on sign-in.
  }
}
