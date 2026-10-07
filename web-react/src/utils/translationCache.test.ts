import { beforeEach, describe, expect, it } from 'vitest'
import { failureOf, forgetTranslations, keepTranslations, keptTranslation } from './translationCache'
import { clearAccountData } from './cardCache'

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

describe('translationCache (#225)', () => {
  beforeEach(() => { (globalThis as { localStorage?: Storage }).localStorage = fakeStorage(); forgetTranslations() })

  it('keeps a translation across a remount or reload, for the words and language it was made from', () => {
    keepTranslations('org1', 'en', [{ id: 'm1', from: '秋メニュー', text: 'Autumn menu' }])
    forgetTranslations() // a reload: only what the browser kept
    expect(keptTranslation('org1', 'm1', 'en', '秋メニュー')).toBe('Autumn menu')
    // Edited, or read in another language: not this one.
    expect(keptTranslation('org1', 'm1', 'en', '冬メニュー')).toBeNull()
    expect(keptTranslation('org1', 'm1', 'fr', '秋メニュー')).toBeNull()
    // Another workspace's is not this one's.
    expect(keptTranslation('org2', 'm1', 'en', '秋メニュー')).toBeNull()
  })

  it('a change of language keeps the other language; an edit replaces only its own', () => {
    keepTranslations('org1', 'en', [{ id: 'm1', from: 'a', text: 'A-en' }, { id: 'm2', from: 'b', text: 'B-en' }])
    keepTranslations('org1', 'fr', [{ id: 'm1', from: 'a', text: 'A-fr' }])
    keepTranslations('org1', 'en', [{ id: 'm1', from: 'a2', text: 'A2-en' }])
    expect(keptTranslation('org1', 'm1', 'en', 'a2')).toBe('A2-en')
    expect(keptTranslation('org1', 'm1', 'fr', 'a')).toBe('A-fr')
    expect(keptTranslation('org1', 'm2', 'en', 'b')).toBe('B-en')
  })

  it('goes with the account on sign-out', () => {
    keepTranslations('org1', 'en', [{ id: 'm1', from: 'a', text: 'A' }])
    clearAccountData()
    expect(keptTranslation('org1', 'm1', 'en', 'a')).toBeNull()
  })

  it('names why a translation could not be had', () => {
    expect(failureOf(null)).toBe('offline')
    expect(failureOf(401)).toBe('auth')
    expect(failureOf(429)).toBe('rate_limit')
    expect(failureOf(502)).toBe('server')
    expect(failureOf(200, 'provider')).toBe('provider')
    expect(failureOf(200, 'unreadable')).toBe('provider')
    expect(failureOf(200, 'quota')).toBe('quota')
    // No translator here: none exists — not a failure.
    expect(failureOf(200, 'no_provider')).toBeNull()
  })
})
