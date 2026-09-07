// Web Push, from the browser's side.
//
// A subscription is a URL at a push service plus two keys, minted by this
// browser and handed to the Worker, which encrypts every notification to them.
// Nothing here works without a service worker, and on iOS nothing here works
// until the site has been added to the home screen — `pushSupport()` tells
// the UI which of those it is looking at.

import { getLocale } from './locale'

export type PushSupport = 'ready' | 'needs-install' | 'unsupported' | 'denied'

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
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // Safari on iOS only exposes PushManager to an installed web app.
    return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  return 'ready'
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing) return existing
  return navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

/// Is this browser already subscribed on this account? Cheap, no prompt.
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ready') return null
  try {
    const reg = await registration()
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

/// Ask, subscribe, and tell the Worker. Call from a click: browsers only
/// honour a permission prompt that a person asked for.
export async function enableWebPush(httpBase: string, sessionToken: string): Promise<'on' | 'denied' | 'unavailable'> {
  if (pushSupport() !== 'ready') return 'unavailable'
  const keyRes = await fetch(`${httpBase}/push/vapid`)
  if (!keyRes.ok) return 'unavailable'
  const { publicKey } = await keyRes.json()

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const reg = await registration()
  const subscription = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })

  const res = await fetch(`${httpBase}/push/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
    body: JSON.stringify(subscription.toJSON()),
  })
  return res.ok ? 'on' : 'unavailable'
}

/// Unsubscribe here and forget it on the Worker, so signing out on a shared
/// machine stops the next person seeing your decisions.
export async function disableWebPush(httpBase: string, sessionToken: string): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  try {
    await fetch(`${httpBase}/push/subscriptions`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
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
