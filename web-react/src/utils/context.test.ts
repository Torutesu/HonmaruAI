import { describe, it, expect, beforeEach } from 'vitest'
import { getSenderContext, setSenderContext, MAX_CONTEXT_CHARS } from './context'

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
