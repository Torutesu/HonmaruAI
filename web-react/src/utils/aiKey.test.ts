import { describe, it, expect, beforeEach } from 'vitest'
import { getAIKey, setAIKey, aiHeaders } from './aiKey'

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

// Your own key rides only on your own requests, and only when there is one.
describe('own AI key', () => {
  beforeEach(() => { (globalThis as { localStorage?: Storage }).localStorage = fakeStorage() })

  it('is no header until set, and the header once set', () => {
    expect(aiHeaders()).toEqual({})
    setAIKey('  sk-abc  ')
    expect(getAIKey()).toBe('sk-abc')
    expect(aiHeaders()).toEqual({ 'x-ai-key': 'sk-abc' })
  })

  it('blank clears it', () => {
    setAIKey('sk-abc')
    setAIKey('   ')
    expect(getAIKey()).toBe('')
    expect(aiHeaders()).toEqual({})
  })
})
