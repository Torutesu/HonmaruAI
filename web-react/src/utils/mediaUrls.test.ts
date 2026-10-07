import { afterEach, describe, expect, it, vi } from 'vitest'
import { addressOf, configureMediaUrls, fileSrc, renew } from './mediaUrls'

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
})
