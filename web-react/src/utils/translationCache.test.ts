import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { failureOf, forgetTranslations, keepTranslations, keptTranslation, translationBatches, translationKey, translationFence, readTranslationBatch, wordsHash, matchesTranslation } from './translationCache'
import { clearAccountData, claimAccountData, releaseAccountData, adoptAccountData } from './cardCache'

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

  it('a late answer for words since edited does not put out the translation of the words now (#390)', () => {
    // B (the edit) came back first; A, asked before the edit, after it.
    keepTranslations('org1', 'en', [{ id: 'm1', from: 'b', text: 'B-en' }])
    keepTranslations('org1', 'en', [{ id: 'm1', from: 'a', text: 'A-en' }])
    forgetTranslations()
    expect(keptTranslation('org1', 'm1', 'en', 'b')).toBe('B-en')
    // Edited back to A: its translation is still there too.
    expect(keptTranslation('org1', 'm1', 'en', 'a')).toBe('A-en')
    expect(translationKey('m1', 'en', 'a')).not.toBe(translationKey('m1', 'en', 'b'))
    expect(translationKey('m1', 'en', 'a')).not.toBe(translationKey('m1', 'fr', 'a'))
  })

  it('still reads a translation kept before versions were', () => {
    localStorage.setItem('translations:org1', JSON.stringify({ 'm1:en': ['a', 'A-en', 1] }))
    forgetTranslations()
    expect(keptTranslation('org1', 'm1', 'en', 'a')).toBe('A-en')
    expect(keptTranslation('org1', 'm1', 'en', 'b')).toBeNull()
  })

  it('asks about every message, in bounded requests, the last one partial (#389)', () => {
    const ids = Array.from({ length: 150 }, (_, i) => i)
    const batches = translationBatches(ids)
    expect(batches.map((b) => b.length)).toEqual([60, 60, 30])
    expect(batches.flat()).toEqual(ids)
    expect(translationBatches([])).toEqual([])
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


describe('translation response boundaries (#523, #532)', () => {
  beforeEach(() => { (globalThis as { localStorage?: Storage }).localStorage = fakeStorage(); forgetTranslations() })
  afterEach(() => vi.unstubAllGlobals())
  const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

  it.each(['signout', 'new-account', 'same-account-new-session'] as const)('rejects a held fetch after %s and never recreates private storage', async boundary => {
    claimAccountData('server|old')
    const held = deferred<Response>()
    const fetcher = vi.fn(() => held.promise)
    vi.stubGlobal('fetch', fetcher)
    const current = translationFence()
    const pending = readTranslationBatch('/translate', {}, current)
    releaseAccountData()
    if (boundary === 'new-account') claimAccountData('server|new')
    if (boundary === 'same-account-new-session') claimAccountData('server|old')
    held.resolve({ ok: true, json: async () => ({ translations: { m: 'Private translation' } }) } as Response)
    const result = await pending
    if (result?.data) keepTranslations('private', 'en', [{ id: 'm', from: 'Private source', text: result.data.translations!.m }])
    expect(result).toBeUndefined()
    keepTranslations('private', 'en', [{ id: 'm', from: 'Private source', text: 'Private translation' }], Date.now(), current)
    expect(localStorage.getItem('translations:private')).toBeNull()
    // A later batch sees the invalid generation before it calls fetch.
    expect(await readTranslationBatch('/translate', {}, current)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('also rejects when response.json is held during sign-out', async () => {
    claimAccountData('server|old')
    const body = deferred<any>()
    const json = vi.fn(() => body.promise)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json })))
    const pending = readTranslationBatch('/translate', {}, translationFence())
    await Promise.resolve(); await Promise.resolve()
    expect(json).toHaveBeenCalledTimes(1)
    releaseAccountData(); claimAccountData('server|new')
    body.resolve({ translations: { m: 'private' } })
    expect(await pending).toBeUndefined()
    expect(localStorage.getItem('translations:private')).toBeNull()
  })

  it.each(['workspace', 'server', 'session', 'unmount', 'locale', 'disabled'])('rejects after the current view crosses %s boundary', async () => {
    const body = deferred<any>()
    const controller = new AbortController()
    let activeScope = 'old'
    const accountCurrent = translationFence()
    const current = () => activeScope === 'old' && !controller.signal.aborted && accountCurrent()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => body.promise })))
    const pending = readTranslationBatch('/translate', { signal: controller.signal }, current)
    await Promise.resolve(); await Promise.resolve()
    activeScope = 'new'; controller.abort()
    body.resolve({ translations: { m: 'private' } })
    expect(await pending).toBeUndefined()
  })

  it('another tab invalidating the same account generation also fences pending work', () => {
    claimAccountData('server|same')
    const old = translationFence()
    localStorage.setItem('account.translationGeneration', 'different-tab-session')
    expect(old()).toBe(false)
  })

  it('a same-owner existing-session adoption in another tab does not strand a held response', async () => {
    claimAccountData('server|same')
    const body = deferred<any>()
    const json = vi.fn(() => body.promise)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json })))
    const current = translationFence()
    const pending = readTranslationBatch('/translate', {}, current)
    await Promise.resolve(); await Promise.resolve()
    expect(json).toHaveBeenCalledOnce()
    adoptAccountData('server|same')
    body.resolve({ locale: 'en', translations: { m: 'translated' } })
    const completed = await pending
    expect(current()).toBe(true)
    expect(completed?.data?.translations?.m).toBe('translated')
    keepTranslations('org', 'en', [{ id: 'm', from: 'source', text: completed!.data!.translations!.m }], Date.now(), current)
    expect(keptTranslation('org', 'm', 'en', 'source')).toBe('translated')
  })

  it("new-owner adoption cannot re-persist this tab's previous account memory", () => {
    claimAccountData('server|old')
    keepTranslations('shared-org', 'en', [{ id: 'private-old', from: 'Synthetic private original', text: 'Synthetic private translation' }])
    // A different tab clears shared storage and claims a new account; this
    // module's Map remains alive, just as in a tab handling a storage event.
    localStorage.removeItem('translations:shared-org')
    localStorage.setItem('account.owner', 'server|new')
    localStorage.setItem('account.translationGeneration', 'new-tab-generation')
    adoptAccountData('server|new')
    keepTranslations('shared-org', 'en', [{ id: 'new', from: 'New original', text: 'New translation' }])
    expect(localStorage.getItem('translations:shared-org')).not.toContain('Synthetic private')
    expect(keptTranslation('shared-org', 'private-old', 'en', 'Synthetic private original')).toBeNull()
    expect(keptTranslation('shared-org', 'new', 'en', 'New original')).toBe('New translation')
  })

  it('same-account remount keeps already-valid translations, but cannot reuse pending requests', () => {
    claimAccountData('server|same')
    keepTranslations('org', 'en', [{ id: 'm', from: 'source', text: 'translated' }])
    const old = translationFence()
    claimAccountData('server|same')
    expect(old()).toBe(false)
    expect(keptTranslation('org', 'm', 'en', 'source')).toBe('translated')
  })

  it('accepts only the server-attested source and locale, for fresh and cached results', () => {
    const response = { locale: 'en', translations: { m: 'Friday' }, sourceHashes: { m: wordsHash('B') } }
    expect(matchesTranslation(response, 'm', 'A', 'en')).toBe(false)
    expect(matchesTranslation(response, 'm', 'B', 'en')).toBe(true)
    expect(matchesTranslation(response, 'm', 'B', 'fr')).toBe(false)
    expect(matchesTranslation({ ...response, sourceHashes: {} }, 'm', 'B', 'en')).toBe(false)
    // Reverting to A cannot read B's cache entry.
    keepTranslations('org', 'en', [{ id: 'm', from: 'B', text: 'Friday' }])
    expect(keptTranslation('org', 'm', 'en', 'A')).toBeNull()
  })
})
