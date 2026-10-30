import { afterEach, describe, expect, it, vi } from 'vitest'
import { addressOf, configureMediaUrls, fileSrc, recordingAddress, renew, renewalAt, retryFailed } from './mediaUrls'

const file = (over = {}) => ({ id: 'f_aaaaaaaaaaaaaaaaaaaaaaaa', name: 'p.png', type: 'image/png', size: 1, url: '/files/f_a?e=1&s=x', expiresAt: 1000, ...over })

describe('file addresses', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); configureMediaUrls(null) })

  it('takes the media origin\'s whole addresses as they are, and the API\'s own relative to it', () => {
    expect(fileSrc('https://api.test', '/files/f_a?e=1')).toBe('https://api.test/files/f_a?e=1')
    expect(fileSrc('https://api.test', 'https://media.test/f/k1/x/f_a?w=1')).toBe('https://media.test/f/k1/x/f_a?w=1')
  })

  it('asks for new addresses together, and shows a newer one by the file\'s id', async () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ files: { f_aaaaaaaaaaaaaaaaaaaaaaaa: { url: 'https://media.test/new', expiresAt: 9_999_999_999_999 } } }))
    }))
    configureMediaUrls({ httpBase: 'https://api.test', orgId: 'team:a', sessionToken: 'tok' })
    renew('f_aaaaaaaaaaaaaaaaaaaaaaaa')
    renew('f_bbbbbbbbbbbbbbbbbbbbbbbb')
    // Asked again at once: not again.
    renew('f_aaaaaaaaaaaaaaaaaaaaaaaa')
    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toEqual([{ orgId: 'team:a', ids: ['f_aaaaaaaaaaaaaaaaaaaaaaaa', 'f_bbbbbbbbbbbbbbbbbbbbbbbb'] }])
    expect(addressOf(file()).url).toBe('https://media.test/new')
    // One that came with a later address keeps its own.
    expect(addressOf(file({ url: 'own', expiresAt: 99_999_999_999_999 })).url).toBe('own')
  })

  it('asks again after a renewal fails, longer apart each time, and soon once back online', async () => {
    vi.useFakeTimers()
    const id = 'f_cccccccccccccccccccccccc'
    let up = false
    const calls: number[] = []
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.push(Date.now())
      if (!up) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ files: { [id]: { url: 'https://media.test/back', expiresAt: Date.now() + 600_000 } } }))
    }))
    configureMediaUrls({ httpBase: 'https://api.test', orgId: 'team:a', sessionToken: 'tok' })
    const f = file({ id, expiresAt: Date.now() + 30_000 })
    expect(renewalAt(f)!).toBeLessThanOrEqual(Date.now())
    renew(id)
    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toHaveLength(1)
    // Not given up on: due again in ten seconds, then twenty.
    expect(renewalAt(f)! - Date.now()).toBeGreaterThan(9_000)
    expect(renewalAt(f)! - Date.now()).toBeLessThanOrEqual(10_000)
    await vi.advanceTimersByTimeAsync(renewalAt(f)! - Date.now())
    renew(id)
    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toHaveLength(2)
    expect(renewalAt(f)! - Date.now()).toBeGreaterThan(19_000)
    // Back online: due as soon as one file may be asked for again.
    up = true
    retryFailed()
    expect(renewalAt(f)! - Date.now()).toBeLessThanOrEqual(10_000)
    await vi.advanceTimersByTimeAsync(Math.max(0, renewalAt(f)! - Date.now()))
    renew(id)
    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toHaveLength(3)
    expect(addressOf(f).url).toBe('https://media.test/back')
    expect(renewalAt(f)).toBe(addressOf(f).expiresAt - 60_000)
  })

  it('does not ask again for a file the server will not renew, until a newer address comes', async () => {
    vi.useFakeTimers()
    const id = 'f_dddddddddddddddddddddddd'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ files: {} }))))
    configureMediaUrls({ httpBase: 'https://api.test', orgId: 'team:a', sessionToken: 'tok' })
    const f = file({ id, expiresAt: Date.now() + 30_000 })
    renew(id)
    await vi.advanceTimersByTimeAsync(60)
    expect(renewalAt(f)).toBeNull()
    // The message read again brings a new one: kept fresh as any other.
    const later = file({ id, expiresAt: Date.now() + 900_000 })
    expect(renewalAt(later)).toBe(later.expiresAt - 60_000)
  })

  it.each([101, 250])('renews all %i files in unique valid batches of at most 100', async (count) => {
    vi.useFakeTimers()
    const ids = Array.from({ length: count }, (_, i) => `f_${i.toString(16).padStart(24, '0')}`)
    const batches: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { ids: batch } = JSON.parse(String(init.body)) as { ids: string[] }
      batches.push(batch)
      return new Response(JSON.stringify({ files: Object.fromEntries(batch.slice(0, 100).map(id => [id, { url: `/new/${id}`, expiresAt: Date.now() + 600_000 }])) }))
    }))
    configureMediaUrls({ httpBase: 'https://api.test', orgId: 'team:bulk', sessionToken: 'tok' })
    for (const id of [...ids, ids[0], 'invalid']) renew(id)
    await vi.advanceTimersByTimeAsync(60)
    expect(batches.map(batch => batch.length)).toEqual(count === 101 ? [100, 1] : [100, 100, 50])
    expect(batches.flat()).toEqual(ids)
    for (const id of ids) {
      expect(addressOf(file({ id })).url).toBe(`/new/${id}`)
      expect(renewalAt(file({ id }))).not.toBeNull()
    }
  })

  it('retries only a failed chunk while preserving successful and refused files', async () => {
    vi.useFakeTimers()
    const ids = Array.from({ length: 250 }, (_, i) => `f_${(i + 1000).toString(16).padStart(24, '0')}`)
    const batches: string[][] = []
    let recovered = false
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { ids: batch } = JSON.parse(String(init.body)) as { ids: string[] }
      batches.push(batch)
      if (batch.includes(ids[100]) && !recovered) throw new TypeError('offline')
      return new Response(JSON.stringify({ files: Object.fromEntries(batch.filter(id => id !== ids[0]).map(id => [id, { url: `/new/${id}`, expiresAt: Date.now() + 600_000 }])) }))
    }))
    configureMediaUrls({ httpBase: 'https://api.test', orgId: 'team:chunks', sessionToken: 'tok' })
    const files = ids.map(id => file({ id, expiresAt: Date.now() + 30_000 }))
    for (const id of ids) renew(id)
    await vi.advanceTimersByTimeAsync(60)
    expect(batches.map(batch => batch.length)).toEqual([100, 100, 50])
    expect(renewalAt(files[0])).toBeNull()
    expect(addressOf(files[249]).url).toBe(`/new/${ids[249]}`)
    expect(renewalAt(files[100])!).toBeGreaterThan(Date.now())
    recovered = true
    retryFailed()
    await vi.advanceTimersByTimeAsync(10_000)
    for (const f of files) if (renewalAt(f) !== null && renewalAt(f)! <= Date.now()) renew(f.id)
    await vi.advanceTimersByTimeAsync(60)
    expect(batches[3]).toEqual(ids.slice(100, 200))
    expect(batches).toHaveLength(4)
    expect(addressOf(files[100]).url).toBe(`/new/${ids[100]}`)
    expect(renewalAt(files[0])).toBeNull()
  })

  it.each(['workspace', 'account'])('discards queued and in-flight renewals after a %s change', async (change) => {
    vi.useFakeTimers()
    const ids = Array.from({ length: 250 }, (_, i) => `f_${(i + 2000).toString(16).padStart(24, '0')}`)
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const config = { httpBase: 'https://api.test', orgId: 'team:before', sessionToken: 'before' }
    configureMediaUrls(config)
    for (const id of ids) renew(id)
    await vi.advanceTimersByTimeAsync(60)
    expect(fetcher).toHaveBeenCalledTimes(1)
    renew('f_ffffffffffffffffffffffff')
    configureMediaUrls({ ...config, ...(change === 'workspace' ? { orgId: 'team:after' } : { sessionToken: 'after' }) })
    finish(new Response(JSON.stringify({ files: { [ids[0]]: { url: '/previous-reader', expiresAt: Date.now() + 600_000 } } })))
    await vi.advanceTimersByTimeAsync(60)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(addressOf(file({ id: ids[0] })).url).not.toBe('/previous-reader')
  })

  it('plays a recording from the address the API signs for this reader, or its link when there is none', async () => {
    const link = 'https://api.test/channels/jam/audio/0f8b3c3e-1111-4222-8333-944455556666'
    let asked: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      asked = { url, body: JSON.parse(String(init.body)) }
      return new Response(JSON.stringify({ url: `${link}?v=2&e=1&s=x`, expiresAt: 1 }))
    }))
    expect(await recordingAddress(link)).toBe(link)
    configureMediaUrls({ httpBase: 'https://api.test', orgId: 'team:a', sessionToken: 'tok' })
    expect(await recordingAddress(link)).toBe(`${link}?v=2&e=1&s=x`)
    expect(asked).toEqual({ url: 'https://api.test/channels/jam/audio-url', body: { orgId: 'team:a', id: '0f8b3c3e-1111-4222-8333-944455556666' } })
  })
})
