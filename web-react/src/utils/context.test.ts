import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getSenderContext, setSenderContext, loadSenderContext, saveSenderContext, MAX_CONTEXT_CHARS } from './context'

// "How I work" lives in this browser and rides on every instruction sent.
// The tests run in Node, which has no localStorage; the smallest one that
// behaves like the browser's is enough.
function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  } as Storage
}

describe('sender context', () => {
  beforeEach(() => { (globalThis as { localStorage?: Storage }).localStorage = fakeStorage() })

  it('is empty until written, and comes back as written', () => {
    expect(getSenderContext()).toBe('')
    setSenderContext('I run the cafe. Kenji owns suppliers.')
    expect(getSenderContext()).toBe('I run the cafe. Kenji owns suppliers.')
  })

  it('is capped, so a pasted essay cannot ride on every send', () => {
    setSenderContext('x'.repeat(MAX_CONTEXT_CHARS + 500))
    expect(getSenderContext()).toHaveLength(MAX_CONTEXT_CHARS)
  })

  it('blank means none', () => {
    setSenderContext('something')
    setSenderContext('   ')
    expect(getSenderContext()).toBe('')
    expect(localStorage.getItem('senderContext')).toBeNull()
  })

  it('keeps one copy per workspace, and never reads one for another', () => {
    setSenderContext('I run the cafe.', 'team:a')
    setSenderContext('I run the hotel.', 'team:b')
    expect(getSenderContext('team:a')).toBe('I run the cafe.')
    expect(getSenderContext('team:b')).toBe('I run the hotel.')
    expect(getSenderContext('team:c')).toBe('')
    expect(getSenderContext()).toBe('')
  })
})

// The server's copy, read when the profile opens. Its answer can arrive
// after the account that asked has signed out, or after it was edited here.
describe('loading the server copy', () => {
  const W = 'team:w'
  let answer: (body: Record<string, unknown>) => void = () => {}
  let sent: Array<{ url: string; init?: RequestInit }> = []
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
    localStorage.setItem('sessionToken', 'tok-a')
    sent = []
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      sent.push({ url, init })
      if (init?.method === 'PUT') return Promise.resolve(new Response('{}'))
      return new Promise<Response>((resolve) => { answer = (body) => resolve(new Response(JSON.stringify(body))) })
    }) as unknown as typeof fetch
  })
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('refreshes the local copy from the server for the account still signed in', async () => {
    setSenderContext('old', W)
    const loading = loadSenderContext('https://api', W, 'tok-a')
    answer({ orgId: W, text: 'I run the cafe.' })
    expect(await loading).toBe('I run the cafe.')
    expect(getSenderContext(W)).toBe('I run the cafe.')
  })

  it('writes nothing when it answers after that account signed out', async () => {
    setSenderContext('A-only context', W)
    const loading = loadSenderContext('https://api', W, 'tok-a')
    // Sign out: the session and the account's copies go.
    localStorage.removeItem('sessionToken')
    localStorage.removeItem(`senderContext:${W}`)
    answer({ orgId: W, text: 'A-only context' })
    expect(await loading).toBeNull()
    expect(localStorage.getItem(`senderContext:${W}`)).toBeNull()
  })

  it('writes nothing, and sends nothing up, when another account signed in meanwhile', async () => {
    const loading = loadSenderContext('https://api', W, 'tok-a')
    localStorage.setItem('sessionToken', 'tok-b')
    localStorage.setItem(`senderContext:${W}`, 'B works mornings.')
    answer({ orgId: W, text: '' })
    expect(await loading).toBeNull()
    expect(getSenderContext(W)).toBe('B works mornings.')
    expect(sent.filter((r) => r.init?.method === 'PUT')).toEqual([])
  })

  it('does not put back an older answer over an edit made while it was on its way', async () => {
    setSenderContext('before', W)
    const loading = loadSenderContext('https://api', W, 'tok-a')
    setSenderContext('typed meanwhile', W)
    answer({ orgId: W, text: 'before' })
    expect(await loading).toBeNull()
    expect(getSenderContext(W)).toBe('typed meanwhile')
  })

  it('keeps a clear made on another device, instead of sending the old copy back up', async () => {
    setSenderContext('Old responsibilities', W)
    const loading = loadSenderContext('https://api', W, 'tok-a')
    answer({ orgId: W, text: '', saved: true })
    expect(await loading).toBe('')
    expect(getSenderContext(W)).toBe('')
    expect(sent.filter((r) => r.init?.method === 'PUT')).toEqual([])
  })

  it('sends up, once, a copy the server never had', async () => {
    localStorage.setItem('senderContext', 'Written before it was per workspace')
    const loading = loadSenderContext('https://api', W, 'tok-a')
    answer({ orgId: W, text: '', saved: false })
    expect(await loading).toBe('Written before it was per workspace')
    const puts = sent.filter((r) => r.init?.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(JSON.parse(String(puts[0].init?.body))).toEqual({ orgId: W, text: 'Written before it was per workspace' })
    expect(getSenderContext(W)).toBe('Written before it was per workspace')
    expect(localStorage.getItem('senderContext')).toBeNull()
  })

  it('saves to the account, but not into this browser, once it has signed out', async () => {
    localStorage.removeItem('sessionToken')
    expect(await saveSenderContext('https://api', W, 'tok-a', 'A-only context')).toBe(true)
    expect(sent).toHaveLength(1)
    expect(localStorage.getItem(`senderContext:${W}`)).toBeNull()
  })
})
