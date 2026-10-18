import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { askPermission, disableWebPush, enableWebPush, prefetchVapidKey, resyncWebPush, sameServerKey, urlBase64ToUint8Array } from './push'

// A browser, as far as Web Push touches it: a permission, a service worker
// with a push manager, and the Worker at the other end of fetch.

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
const OTHER = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'

type Sub = { endpoint: string; options: { applicationServerKey: ArrayBuffer | null }; unsubscribe: () => Promise<boolean>; toJSON: () => object }

function sub(endpoint: string, key: string | null): Sub {
  return {
    endpoint,
    options: { applicationServerKey: key ? urlBase64ToUint8Array(key).buffer : null },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
  }
}

let calls: string[]
let permission: NotificationPermission
let answer: NotificationPermission
let current: Sub | null
let requests: Array<{ url: string; method: string; body?: string }>
let vapidOk: boolean
let base = 0

function install() {
  calls = []
  permission = 'default'
  answer = 'granted'
  current = null
  requests = []
  vapidOk = true
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (opts: { applicationServerKey: Uint8Array }) => {
      calls.push('subscribe')
      const key = btoa(String.fromCharCode(...opts.applicationServerKey)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      current = sub('https://push.example/new', key)
      return current
    }),
  }
  const reg = { pushManager }
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), PushManager: function PushManager() {} })
  vi.stubGlobal('document', {})
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0',
    serviceWorker: {
      getRegistration: vi.fn(async () => reg),
      register: vi.fn(async () => reg),
      ready: Promise.resolve(reg),
    },
  })
  const N = function Notification() {} as unknown as { permission: NotificationPermission; requestPermission: (cb?: (p: NotificationPermission) => void) => Promise<NotificationPermission> }
  Object.defineProperty(N, 'permission', { get: () => permission })
  N.requestPermission = vi.fn(() => {
    calls.push('prompt')
    permission = answer === 'default' ? 'default' : answer
    return Promise.resolve(answer)
  })
  vi.stubGlobal('Notification', N)
  ;(window as unknown as { Notification: unknown }).Notification = N
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    requests.push({ url, method: init?.method || 'GET', body: init?.body })
    if (url.endsWith('/push/vapid')) {
      calls.push('vapid')
      return { ok: vapidOk, json: async () => ({ publicKey: KEY }) }
    }
    return { ok: true, json: async () => ({}) }
  }))
}

// Each test gets its own Worker address, so the key cache starts empty.
const http = () => `https://api${(base += 1)}.example`

beforeEach(install)
afterEach(() => vi.unstubAllGlobals())

describe('turning push on', () => {
  it('asks before anything waits on the network, so Firefox and Safari still see a click', async () => {
    const httpBase = http()
    const promise = enableWebPush(httpBase, 'tok')
    // Synchronously, inside the click, before any await: the prompt is up.
    // The key's request was started too, but nothing waited on it.
    expect(calls).toContain('prompt')
    expect(await promise).toBe('on')
    expect(calls).toEqual(['vapid', 'prompt', 'subscribe'])
    const posted = requests.find((r) => r.method === 'POST')
    expect(posted?.url).toBe(`${httpBase}/push/subscriptions`)
    expect(JSON.parse(posted!.body!)).toMatchObject({ endpoint: 'https://push.example/new' })
  })

  it('tells a closed prompt apart from a blocked site', async () => {
    answer = 'default'
    expect(await enableWebPush(http(), 'tok')).toBe('dismissed')
    answer = 'denied'
    expect(await enableWebPush(http(), 'tok')).toBe('denied')
    // Blocked: it does not even ask again.
    calls.length = 0
    expect(await enableWebPush(http(), 'tok')).toBe('denied')
    expect(calls).toEqual([])
  })

  it('does not prompt when permission was already granted', async () => {
    permission = 'granted'
    expect(await enableWebPush(http(), 'tok')).toBe('on')
    expect(calls).not.toContain('prompt')
  })

  it('reports trouble instead of throwing, so the button never sticks on "busy"', async () => {
    vapidOk = false
    expect(await enableWebPush(http(), 'tok')).toBe('unavailable')
    vapidOk = true
    ;(navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no worker'))
    expect(await enableWebPush(http(), 'tok')).toBe('unavailable')
  })

  it('replaces a subscription made with a key the Worker no longer uses, and forgets the old one there', async () => {
    permission = 'granted'
    const stale = sub('https://push.example/old', OTHER)
    current = stale
    expect(await enableWebPush(http(), 'tok')).toBe('on')
    expect(stale.unsubscribe).toHaveBeenCalled()
    expect(requests.find((r) => r.method === 'DELETE')?.body).toContain('https://push.example/old')
    expect(calls).toContain('subscribe')
  })

  it('keeps a subscription made with the same key', async () => {
    permission = 'granted'
    current = sub('https://push.example/kept', KEY)
    expect(await enableWebPush(http(), 'tok')).toBe('on')
    expect(calls).not.toContain('subscribe')
    expect(JSON.parse(requests.find((r) => r.method === 'POST')!.body!)).toMatchObject({ endpoint: 'https://push.example/kept' })
  })
})

describe('keeping it on', () => {
  it('hands an existing subscription to the Worker again on open, without prompting', async () => {
    permission = 'granted'
    current = sub('https://push.example/kept', KEY)
    expect(await resyncWebPush(http(), 'tok')).toBe(true)
    expect(calls).not.toContain('prompt')
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  describe('the key kept for the service worker', () => {
    let kept: Map<string, string>
    beforeEach(() => {
      kept = new Map()
      vi.stubGlobal('caches', {
        open: async () => ({
          put: async (key: string, res: Response) => { kept.set(key, await res.text()) },
          delete: async (key: string) => kept.delete(key),
          match: async (key: string) => (kept.has(key) ? new Response(kept.get(key)) : undefined),
        }),
      })
    })

    it('is kept once push is on, and forgotten when it is turned off', async () => {
      const httpBase = http()
      expect(await enableWebPush(httpBase, 'tok')).toBe('on')
      expect(kept.get('/push-key')).toBe(KEY)
      await disableWebPush(httpBase, 'tok')
      expect(kept.has('/push-key')).toBe(false)
    })

    it('is not written back by a resync that was still in flight when push was turned off', async () => {
      permission = 'granted'
      const kept1 = sub('https://push.example/kept', KEY)
      current = kept1
      const httpBase = http()
      await prefetchVapidKey(httpBase)
      // The resync's POST hangs until we let it go.
      let letGo: () => void = () => {}
      const held = new Promise<void>((resolve) => { letGo = resolve })
      const realFetch = fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'POST') await held
        return (realFetch as unknown as (u: string, i?: object) => Promise<Response>)(url, init)
      }))
      const resync = resyncWebPush(httpBase, 'tok')
      await new Promise((resolve) => setTimeout(resolve, 0))
      await disableWebPush(httpBase, 'tok')
      letGo()
      expect(await resync).toBe(false)
      expect(kept.has('/push-key')).toBe(false)
      expect(kept1.unsubscribe).toHaveBeenCalled()
    })

    // A tab left open as A, after B signed in in another: signing A out
    // there must not turn B's push off.
    it('is left alone, with the subscription, by a tab whose session is no longer this browser’s', async () => {
      const saved: Record<string, string> = { sessionToken: 'tok' }
      vi.stubGlobal('localStorage', { getItem: (k: string) => saved[k] ?? null })
      const httpBase = http()
      expect(await enableWebPush(httpBase, 'tok')).toBe('on')
      const theirs = current!
      saved.sessionToken = 'tok-b'
      await disableWebPush(httpBase, 'tok-a')
      expect(kept.get('/push-key')).toBe(KEY)
      expect(theirs.unsubscribe).not.toHaveBeenCalled()
      expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
    })

    it('keeps the subscription when another session signs in while turning off waits', async () => {
      const saved: Record<string, string> = { sessionToken: 'tok' }
      vi.stubGlobal('localStorage', { getItem: (k: string) => saved[k] ?? null })
      const httpBase = http()
      expect(await enableWebPush(httpBase, 'tok')).toBe('on')
      const theirs = current!
      const off = disableWebPush(httpBase, 'tok')
      saved.sessionToken = 'tok-b'
      await off
      expect(theirs.unsubscribe).not.toHaveBeenCalled()
      // Its own session, still current: off as before.
      saved.sessionToken = 'tok-b'
      await disableWebPush(httpBase, 'tok-b')
      expect(theirs.unsubscribe).toHaveBeenCalled()
    })

    it('makes again a subscription the browser dropped while push was on here', async () => {
      permission = 'granted'
      kept.set('/push-key', KEY)
      current = null
      expect(await resyncWebPush(http(), 'tok')).toBe(true)
      expect(calls).toContain('subscribe')
      expect(calls).not.toContain('prompt')
    })
  })

  it('does nothing for a browser that never turned it on', async () => {
    expect(await resyncWebPush(http(), 'tok')).toBe(false)
    permission = 'granted'
    expect(await resyncWebPush(http(), 'tok')).toBe(false)
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0)
  })
})

describe('the key', () => {
  it('is fetched once per Worker, and fetched again after a failure', async () => {
    const httpBase = http()
    await prefetchVapidKey(httpBase)
    await prefetchVapidKey(httpBase)
    expect(calls.filter((c) => c === 'vapid')).toHaveLength(1)
    const other = http()
    vapidOk = false
    expect(await prefetchVapidKey(other)).toBeNull()
    await Promise.resolve()
    vapidOk = true
    expect(await prefetchVapidKey(other)).toBe(KEY)
  })

  it('compares a subscription\'s key byte for byte, and trusts a browser that does not say', () => {
    expect(sameServerKey(sub('e', KEY) as unknown as PushSubscription, KEY)).toBe(true)
    expect(sameServerKey(sub('e', OTHER) as unknown as PushSubscription, KEY)).toBe(false)
    expect(sameServerKey(sub('e', null) as unknown as PushSubscription, KEY)).toBe(true)
  })
})

describe('the prompt', () => {
  it('works with the old callback form, as older Safari has it', async () => {
    const N = Notification as unknown as { requestPermission: unknown }
    N.requestPermission = (cb: (p: NotificationPermission) => void) => { cb('granted'); return undefined }
    expect(await askPermission()).toBe('granted')
  })

  it('answers with what the browser has when asking throws', async () => {
    permission = 'denied'
    const N = Notification as unknown as { requestPermission: unknown }
    N.requestPermission = () => { throw new TypeError('not allowed') }
    expect(await askPermission()).toBe('denied')
  })
})
