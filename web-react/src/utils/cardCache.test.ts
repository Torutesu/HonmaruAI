import { describe, it, expect, beforeEach } from 'vitest'
import { loadCardCache, saveCardCache, clearCardCache } from './cardCache'
import type { DecisionCard } from '../types/card'

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

const card = (id: string, createdAt: string): DecisionCard => ({
  id, recipientUserID: 'toru', senderUserID: 'mika', type: 'approval', title: id, summary: '', context: '',
  status: 'pending', priority: 'high', createdAt,
})

// The last snapshot, kept for the next open — and only this workspace's.
describe('card cache', () => {
  beforeEach(() => { (globalThis as { localStorage?: Storage }).localStorage = fakeStorage() })

  it('comes back for the same workspace and not for another', () => {
    saveCardCache('personal:toru', { a: card('a', '2026-09-10T00:00:00Z') })
    expect(Object.keys(loadCardCache('personal:toru'))).toEqual(['a'])
    expect(loadCardCache('acme/ops')).toEqual({})
  })

  it('keeps the newest two hundred', () => {
    const many: Record<string, DecisionCard> = {}
    for (let i = 0; i < 260; i++) many[`c${i}`] = card(`c${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString())
    saveCardCache('o', many)
    const kept = loadCardCache('o')
    expect(Object.keys(kept)).toHaveLength(200)
    expect(kept.c259).toBeDefined()
    expect(kept.c0).toBeUndefined()
  })

  it('clears', () => {
    saveCardCache('o', { a: card('a', '2026-09-10T00:00:00Z') })
    clearCardCache()
    expect(loadCardCache('o')).toEqual({})
  })
})
