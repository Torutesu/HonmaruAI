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
