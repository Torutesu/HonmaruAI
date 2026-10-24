import { describe, it, expect, beforeEach } from 'vitest'
import { loadCardCache, saveCardCache, clearCardCache, clearAccountData, accountOwner, claimAccountData, adoptAccountData, releaseAccountData } from './cardCache'
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

describe('clearAccountData', () => {
  it('forgets the account signing out and keeps the device', () => {
    const s = fakeStorage()
    for (const k of ['senderContext', 'senderContext:team:a', 'aiKey', 'orgId', 'draft:team:a:b:cafe', 'hx-app-draft:["api","alice","org","app",null,null]', 'daily-draft:c1', 'onboard.tools:team:a', 'sidebar.folded:org-a', 'outbox:team%3Aa:aiko', 'outbox:team:a', 'emoji.recent', 'host', 'locale', 'mode', 'draftsOpen'])
      s.setItem(k, 'x')
    clearAccountData(s)
    const left: string[] = []
    for (let i = 0; i < s.length; i++) left.push(s.key(i) || '')
    expect(left.sort()).toEqual(['draftsOpen', 'host', 'locale', 'mode'])
  })
})

// A's things are kept under the workspace alone; B in the same workspace,
// on the same browser, must never be handed them.
describe('whose things this browser keeps', () => {
  const A = accountOwner('https://api.example', 'aiko')
  const B = accountOwner('https://api.example', 'ben')
  const kept = (s: Storage) => ({ draft: s.getItem('draft:team:w:b:cafe'), aiKey: s.getItem('aiKey'), context: s.getItem('senderContext:team:w') })
  const fill = (s: Storage) => { s.setItem('draft:team:w:b:cafe', 'A draft'); s.setItem('aiKey', 'sk-a'); s.setItem('senderContext:team:w', 'A-only context') }

  it('keeps an account’s own things when it signs in again', () => {
    const s = fakeStorage()
    claimAccountData(A, s)
    fill(s)
    claimAccountData(A, s)
    expect(kept(s)).toEqual({ draft: 'A draft', aiKey: 'sk-a', context: 'A-only context' })
  })

  it('clears another account’s things — or another server’s — before a sign-in, however the last one left', () => {
    const s = fakeStorage()
    claimAccountData(A, s)
    fill(s)
    // A's session ran out while the app was closed; B signs in.
    claimAccountData(B, s)
    expect(kept(s)).toEqual({ draft: null, aiKey: null, context: null })
    fill(s)
    claimAccountData(accountOwner('https://other.example', 'ben'), s)
    expect(kept(s)).toEqual({ draft: null, aiKey: null, context: null })
  })

  it('clears things nobody is known to own: written after a sign-out, or from before owners were kept', () => {
    const s = fakeStorage()
    claimAccountData(A, s)
    releaseAccountData(s)
    // A late answer for A writes after A signed out.
    fill(s)
    claimAccountData(B, s)
    expect(kept(s)).toEqual({ draft: null, aiKey: null, context: null })
  })

  it('on opening with a session still good, keeps what had no owner recorded yet, and nothing of anyone else’s', () => {
    const s = fakeStorage()
    fill(s)
    adoptAccountData(A, s)
    expect(kept(s).draft).toBe('A draft')
    adoptAccountData(B, s)
    expect(kept(s)).toEqual({ draft: null, aiKey: null, context: null })
  })
})
