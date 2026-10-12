import { describe, it, expect, beforeEach } from 'vitest'
import source from '../public/sw.js?raw'

// public/sw.js itself, run with just enough of a service worker around it
// (its globals handed in as parameters): what a push shows, and where a
// click goes.

type Handler = (event: Record<string, unknown>) => void
interface Shown { title: string; options: Record<string, unknown> & { data: Record<string, unknown> } }

type Existing = { title?: string; body?: string; timestamp?: number; data: Record<string, unknown> }

function worker(opts: { windows?: Array<Record<string, unknown>>; existing?: Existing[]; cached?: Record<string, Record<string, string>>; subscribed?: boolean } = {}) {
  const handlers: Record<string, Handler> = {}
  const shown: Shown[] = []
  const subscribed: unknown[] = []
  const store = new Map(Object.entries(opts.cached || {}).map(([name, entries]) => [name, new Map(Object.entries(entries))]))
  const deleted: string[] = []
  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map())
      const entries = store.get(name)!
      return {
        match: async (key: string) => (entries.has(key) ? { text: async () => entries.get(key) } : undefined),
        put: async () => {},
        addAll: async () => {},
      }
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => { deleted.push(name); return store.delete(name) },
  }
  const opened: string[] = []
  const posted: Array<{ id: string; message: Record<string, unknown> }> = []
  const focused: string[] = []
  const windows = (opts.windows || []).map((w) => ({
    ...w,
    postMessage: (message: Record<string, unknown>) => posted.push({ id: String(w.id), message }),
    focus: async () => { focused.push(String(w.id)) },
  }))
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener: (name: string, fn: Handler) => { handlers[name] = fn },
    skipWaiting: async () => {},
    registration: {
      scope: 'https://app.example/',
      showNotification: async (title: string, options: Shown['options']) => { shown.push({ title, options }) },
      getNotifications: async () => opts.existing || [],
      pushManager: {
        getSubscription: async () => (opts.subscribed ? {} : null),
        subscribe: async (o: unknown) => { subscribed.push(o); return {} },
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url) },
      claim: async () => {},
    },
  }
  new Function('self', 'caches', 'fetch', 'navigator', source)(self, caches, () => Promise.reject(new Error('offline')), {})
  const fire = async (name: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> = Promise.resolve()
    handlers[name]({ ...event, waitUntil: (p: Promise<unknown>) => { work = p } })
    await work
  }
  const push = (data: Record<string, unknown>) => fire('push', { data: { json: () => data, text: () => JSON.stringify(data) } })
  const click = (data: Record<string, unknown>) => fire('notificationclick', { notification: { data, close: () => {} } })
  return { shown, opened, posted, focused, push, click, fire, subscribed, deleted }
}

describe('a push, shown', () => {
  it('uses raster icons, keeps the workspace, and rings again for a new message in the same conversation', async () => {
    const w = worker()
    await w.push({ title: 'Mika Â· #cafe', body: 'Hi', kind: 'message', tag: 'org1|b:cafe', orgId: 'org1', channel: 'b:cafe', messageId: 'm1' })
    expect(w.shown).toHaveLength(1)
    const { options } = w.shown[0]
    expect(options.icon).toBe('/icon-192.png')
    expect(options.badge).toBe('/badge-96.png')
    expect(options.tag).toBe('org1|b:cafe')
    expect(options.renotify).toBe(true)
    expect(options.data).toMatchObject({ messageId: 'm1', orgId: 'org1', channel: 'b:cafe' })
    expect(typeof options.timestamp).toBe('number')
  })

  it('replaces, without a second sound, a message the open tab already showed', async () => {
    const w = worker({ existing: [{ data: { messageId: 'm1' } }] })
    await w.push({ title: 'Mika', body: 'Hi', kind: 'message', tag: 'org1|dm:mika', orgId: 'org1', messageId: 'm1' })
    expect(w.shown[0].options.renotify).toBe(false)
  })

  it('still rings for the next message in that conversation', async () => {
    const w = worker({ existing: [{ data: { messageId: 'm1' } }] })
    await w.push({ title: 'Mika', body: 'Again', kind: 'message', tag: 'org1|dm:mika', orgId: 'org1', messageId: 'm2' })
    expect(w.shown[0].options.renotify).toBe(true)
  })

  it('never rolls a conversation back to an older message the tab already moved past', async () => {
    const w = worker({ existing: [{ title: 'Bob', body: 'second', timestamp: 2000, data: { messageId: 'm2', kind: 'message', at: '2026-01-01T00:00:02.000Z' } }] })
    await w.push({ title: 'Bob', body: 'first', kind: 'message', tag: 'org1|dm:bob', orgId: 'org1', messageId: 'm1', at: '2026-01-01T00:00:01.000Z' })
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0].title).toBe('Bob')
    expect(w.shown[0].options).toMatchObject({ body: 'second', renotify: false, tag: 'org1|dm:bob' })
    expect(w.shown[0].options.data).toMatchObject({ messageId: 'm2' })
  })

  it('still rings for a message newer than the one on screen', async () => {
    const w = worker({ existing: [{ title: 'Bob', body: 'first', data: { messageId: 'm1', kind: 'message', at: '2026-01-01T00:00:01.000Z' } }] })
    await w.push({ title: 'Bob', body: 'second', kind: 'message', tag: 'org1|dm:bob', orgId: 'org1', messageId: 'm2', at: '2026-01-01T00:00:02.000Z' })
    expect(w.shown[0].options).toMatchObject({ body: 'second', renotify: true })
    expect(w.shown[0].options.data).toMatchObject({ at: '2026-01-01T00:00:02.000Z' })
  })

  it('rings for something new on a card already on screen, not for the same thing again, and always has a tag', async () => {
    // A comment on a card whose request is still on screen used to replace
    // it without a sound: it looked as if the comment never came.
    const comment = worker({ existing: [{ data: { cardId: 'c1', kind: 'created' } }] })
    await comment.push({ title: 'Mika commented', body: 'Can we wait?', kind: 'commented', cardId: 'c1' })
    expect(comment.shown[0].options).toMatchObject({ tag: 'c1', renotify: true })
    const again = worker({ existing: [{ data: { cardId: 'c1', kind: 'created' } }] })
    await again.push({ title: 'New decision', body: 'Budget', kind: 'created', cardId: 'c1' })
    expect(again.shown[0].options).toMatchObject({ tag: 'c1', renotify: false })
    await again.push({ title: 'Plain' })
    expect(again.shown[1].options.tag).toBe('honmaru')
  })
})

describe('a notification, clicked', () => {
  let w: ReturnType<typeof worker>

  it('opens the message in its own workspace when no window is open', async () => {
    w = worker()
    await w.click({ messageId: 'm1', orgId: 'org 2' })
    expect(w.opened).toEqual(['https://app.example/#/m/m1/org%202'])
  })

  it('opens the card when no window is open', async () => {
    w = worker()
    await w.click({ cardId: 'c1' })
    expect(w.opened).toEqual(['https://app.example/#/feed/c1'])
  })

  describe('with windows open', () => {
    beforeEach(() => {
      w = worker({
        windows: [
          { id: 'privacy', url: 'https://app.example/privacy.html', focused: true, visibilityState: 'visible' },
          { id: 'background', url: 'https://app.example/#/list', focused: false, visibilityState: 'hidden' },
          { id: 'front', url: 'https://app.example/index.html#/feed', focused: false, visibilityState: 'visible' },
        ],
      })
    })

    it('brings forward the app window that can be seen â€” never the privacy page â€” and tells it where to go', async () => {
      await w.click({ messageId: 'm1', orgId: 'org1' })
      expect(w.opened).toEqual([])
      expect(w.focused).toEqual(['front'])
      expect(w.posted).toEqual([{ id: 'front', message: { type: 'open-message', messageId: 'm1', orgId: 'org1', hash: '#/m/m1/org1' } }])
    })

    it('sends a card to the card', async () => {
      await w.click({ cardId: 'c1', orgId: 'org1' })
      expect(w.posted[0].message).toEqual({ type: 'open-card', cardId: 'c1', orgId: 'org1', hash: '#/feed/c1/org1' })
    })
  })
})

describe('a subscription the browser replaced', () => {
  it('asks every open window to hand the new one to the Worker', async () => {
    const w = worker({ windows: [{ id: 'a', url: 'https://app.example/' }] })
    await w.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: new ArrayBuffer(65) } }, newSubscription: null })
    expect(w.subscribed).toHaveLength(1)
    expect(w.posted).toEqual([{ id: 'a', message: { type: 'push-resync' } }])
  })

  it('subscribes again with the kept key when the browser does not say which one it dropped (Firefox for Android)', async () => {
    const w = worker({ cached: { 'honmaru-push': { '/push-key': 'BKEY' } } })
    await w.fire('pushsubscriptionchange', { oldSubscription: null, newSubscription: null })
    expect(w.subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: 'BKEY' }])
  })

  it('stays off when push was turned off here (no key kept), or already has a subscription', async () => {
    const off = worker()
    await off.fire('pushsubscriptionchange', { oldSubscription: null, newSubscription: null })
    expect(off.subscribed).toEqual([])
    const has = worker({ cached: { 'honmaru-push': { '/push-key': 'BKEY' } }, subscribed: true })
    await has.fire('pushsubscriptionchange', { oldSubscription: null, newSubscription: null })
    expect(has.subscribed).toEqual([])
  })
})

describe('a new version of the worker', () => {
  it('clears old shell caches but keeps the push key', async () => {
    const w = worker({ cached: { 'honmaru-shell-v2': {}, 'honmaru-shell-v3': {}, 'honmaru-push': { '/push-key': 'BKEY' } } })
    await w.fire('activate', {})
    expect(w.deleted).toEqual(['honmaru-shell-v2'])
  })
})
