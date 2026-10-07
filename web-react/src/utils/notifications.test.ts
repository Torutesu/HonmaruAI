import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { notifyNewDecision, notifyMessage, notificationText, badgeCount, badgeLabel, markSeen, setTabBadge, setNotificationCopy, watchWorkspace } from './notifications'
import { changeLocale, localeReady } from './i18n'
import { setQuietState } from './quiet'

// A tab's own notification, in the reader's language even when the page has
// no table for it: the Worker wrote the words and /me carried them.
describe('in-tab notification', () => {
  const shown: Array<{ title: string; body: string }> = []
  beforeEach(() => {
    shown.length = 0
    class FakeNotification {
      static permission = 'granted'
      constructor(title: string, options: { body: string }) { shown.push({ title, body: options.body }) }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification)
    vi.stubGlobal('document', { visibilityState: 'hidden', documentElement: {} })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  it('uses the Worker’s words for a language the page cannot speak', () => {
    changeLocale('vi')
    setNotificationCopy({ locale: 'vi', newDecision: 'Bạn có quyết định mới', from: 'Từ {name}' })
    notifyNewDecision('Phê duyệt ngân sách', 'Mai')
    expect(shown[0]).toEqual({ title: 'Bạn có quyết định mới', body: 'Phê duyệt ngân sách\nTừ Mai' })
  })

  it('does not use words written for a language no longer being read', async () => {
    changeLocale('ja')
    await localeReady()
    setNotificationCopy({ locale: 'vi', newDecision: 'Bạn có quyết định mới', from: 'Từ {name}' })
    notifyNewDecision('予算の承認', 'Mai')
    expect(shown[0]).toEqual({ title: '新しい決定が届きました', body: '予算の承認\nMaiから' })
    changeLocale('en')
  })
})

// A direct message or a mention while the tab is behind another.
describe('in-tab message notification', () => {
  const shown: Array<{ title: string; options: NotificationOptions & { renotify?: boolean; timestamp?: number } }> = []
  let doc: { visibilityState: string; hasFocus: () => boolean; documentElement: object; title: string }
  beforeEach(() => {
    shown.length = 0
    class FakeNotification {
      static permission = 'granted'
      onclick: (() => void) | null = null
      constructor(title: string, options: NotificationOptions) { shown.push({ title, options }) }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification)
    doc = { visibilityState: 'visible', hasFocus: () => false, documentElement: {}, title: '' }
    vi.stubGlobal('document', doc)
    setQuietState({ pausedUntil: null, schedule: null })
    markSeen()
    setTabBadge(0)
  })

  const message = { id: 'm1', orgId: 'org1', channel: 'dm:mika', author: 'Mika', body: 'the answer is ||42|| — **really**' }

  it('shows who, where, and what — with the spoiler kept hidden — under the conversation\'s tag', () => {
    notifyMessage({ ...message, where: '#cafe' })
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Mika · #cafe')
    expect(shown[0].options.body).toBe('the answer is ▇▇▇ — really')
    // The same tag the Worker's push uses, so the push replaces it.
    expect(shown[0].options.tag).toBe('org1|dm:mika')
    expect(shown[0].options.renotify).toBe(true)
    expect(shown[0].options.data).toMatchObject({ messageId: 'm1', orgId: 'org1', hash: '#/m/m1/org1' })
  })

  it('stays quiet while the person is looking at the tab, or has paused notifications', () => {
    doc.hasFocus = () => true
    notifyMessage(message)
    expect(shown).toHaveLength(0)
    doc.hasFocus = () => false
    setQuietState({ pausedUntil: new Date(Date.now() + 60_000).toISOString(), schedule: null })
    notifyMessage(message)
    expect(shown).toHaveLength(0)
  })

  it('counts what came in while away in the title, on top of waiting decisions, until the tab is looked at', () => {
    setTabBadge(2)
    expect(doc.title).toBe('(2) Honmaru AI')
    notifyMessage(message)
    notifyMessage({ ...message, id: 'm2' })
    expect(badgeCount()).toBe(4)
    expect(doc.title).toBe('(4) Honmaru AI')
    markSeen()
    expect(doc.title).toBe('(2) Honmaru AI')
    setTabBadge(0)
    expect(doc.title).toBe('Honmaru AI')
  })

  it('carries the server\'s time for the message, so an older push never replaces it', () => {
    notifyMessage({ ...message, createdAt: '2026-01-01T00:00:05.000Z' })
    expect(shown[0].options.data).toMatchObject({ at: '2026-01-01T00:00:05.000Z' })
    expect(shown[0].options.timestamp).toBe(Date.parse('2026-01-01T00:00:05.000Z'))
  })

  describe('with other tabs open', () => {
    let stop: (() => void) | null = null
    let other: BroadcastChannel | null = null
    const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
    // The other tabs' own locks, held while they live: releasing one is the
    // browser freeing it when that tab goes, crash included.
    let alive: Map<string, () => void>
    beforeEach(() => {
      alive = new Map()
      vi.stubGlobal('navigator', {
        locks: {
          request: (name: string, _o: unknown, cb: () => Promise<void>) => {
            const them = /^honmaru-tab:(tab-\d+)$/.exec(name)
            // Another tab's lock: granted only once that tab is gone.
            if (them) return new Promise<void>((resolve) => { alive.set(them[1], () => { void cb().then(resolve) }) })
            // Everything else — this tab's own, and the workspace's — at once.
            return cb()
          },
        },
      })
      other = new BroadcastChannel('honmaru-looking')
    })
    afterEach(() => { stop?.(); stop = null; other?.close(); other = null })

    it('stays quiet while another tab is reading the same workspace, and speaks again once it is not', async () => {
      stop = watchWorkspace('org1')
      other!.postMessage({ type: 'looking', id: 'tab-2', orgId: 'org1', looking: true })
      await tick()
      notifyMessage(message)
      notifyNewDecision('Budget', 'Kenji', 'card-1', 'org1')
      expect(shown).toHaveLength(0)
      expect(badgeCount()).toBe(0)
      other!.postMessage({ type: 'looking', id: 'tab-2', orgId: 'org1', looking: false })
      await tick()
      notifyMessage(message)
      expect(shown).toHaveLength(1)
    })

    it('forgets a tab that crashed while it was being read', async () => {
      stop = watchWorkspace('org1')
      other!.postMessage({ type: 'looking', id: 'tab-4', orgId: 'org1', looking: true })
      await tick()
      notifyMessage(message)
      expect(shown).toHaveLength(0)
      // It never said goodbye; the browser freed its lock.
      alive.get('tab-4')!()
      await tick()
      notifyMessage(message)
      expect(shown).toHaveLength(1)
    })

    it('is not silenced by a tab reading another workspace', async () => {
      stop = watchWorkspace('org1')
      other!.postMessage({ type: 'looking', id: 'tab-3', orgId: 'org2', looking: true })
      await tick()
      notifyMessage(message)
      expect(shown).toHaveLength(1)
    })

    it('leaves it to the tab holding the workspace\'s lock', async () => {
      vi.stubGlobal('navigator', { locks: { request: () => new Promise(() => { /* held elsewhere */ }) } })
      stop = watchWorkspace('org1')
      notifyMessage(message)
      expect(shown).toHaveLength(0)
    })
  })

  it('gives a decision the card\'s own tag and address', () => {
    notifyNewDecision('Approve the budget', 'Kenji', 'card-9')
    expect(shown[0].options.tag).toBe('card-9')
    expect(shown[0].options.data).toMatchObject({ cardId: 'card-9', hash: '#/feed/card-9' })
  })
})

describe('notification text', () => {
  it('takes the marks off and keeps it to one line', () => {
    expect(notificationText('# Launch\n> quoted\n- item\n`code` and *bold* and _it_ and ~~gone~~')).toBe('Launch quoted - item code and bold and it and gone')
  })

  it('never gives a spoiler away', () => {
    expect(notificationText('||Snape|| did it, ||twice||')).toBe('▇▇▇ did it, ▇▇▇')
  })

  it('never pairs the || of code with a real spoiler', () => {
    expect(notificationText('use `a || b` to check; the answer is ||42||')).toBe('use a || b to check; the answer is ▇▇▇')
    expect(notificationText('||x `a || b` y||')).toBe('▇▇▇')
  })

  it('keeps words that only look like marks', () => {
    expect(notificationText('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4')
    expect(notificationText('edit __init__.py')).toBe('edit __init__.py')
  })

  it('keeps links and code whole, as the chat shows them', () => {
    expect(notificationText('see https://x.io/src/__tests__/a.ts and `__init__.py`')).toBe('see https://x.io/src/__tests__/a.ts and __init__.py')
    expect(notificationText('**ship** it, `**not bold**`')).toBe('ship it, **not bold**')
  })

  it('shortens a long message with an ellipsis', () => {
    const out = notificationText('a'.repeat(300))
    expect(out).toHaveLength(180)
    expect(out.endsWith('…')).toBe(true)
  })

  it('shows "9+" past nine on the icon', () => {
    expect(badgeLabel(3)).toBe('3')
    expect(badgeLabel(10)).toBe('9+')
  })
})
