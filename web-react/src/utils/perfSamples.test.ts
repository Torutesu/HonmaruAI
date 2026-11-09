import { afterEach, describe, expect, it, vi } from 'vitest'
import { configurePerfSamples, flushPerfSamples, pendingPerfSamples, perfSample, serverTotal } from './perfSamples'
import { ChannelMessageCache } from './channelMessageCache'

// The chat's own waits, measured (#845, findings 6–7).

afterEach(() => { configurePerfSamples(null); vi.unstubAllGlobals(); vi.useRealTimers() })
const kinds = () => pendingPerfSamples().map((s) => s.k)

describe('samples', () => {
  it('are kept only while signed in, and a new account starts with none', () => {
    perfSample('send.http', 10)
    expect(pendingPerfSamples()).toEqual([])
    configurePerfSamples({ httpBase: 'https://api.test', sessionToken: 'a' })
    perfSample('send.http', 10.4); perfSample('send.queue', -1); perfSample('send.queue', NaN)
    expect(pendingPerfSamples()).toEqual([{ k: 'send.http', v: 10 }])
    configurePerfSamples({ httpBase: 'https://api.test', sessionToken: 'b' })
    expect(pendingPerfSamples()).toEqual([])
  })

  it('go in batches of fifty, with the session, a kind and a number each, and nothing else', () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetcher)
    configurePerfSamples({ httpBase: 'https://api.test', sessionToken: 'a' })
    for (let i = 0; i < 60; i++) perfSample('open.cold', i)
    flushPerfSamples()
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/perf')
    expect((init.headers as Record<string, string>)['x-session-token']).toBe('a')
    const body = JSON.parse(String(init.body))
    expect(Object.keys(body).sort()).toEqual(['client', 'samples'])
    expect(body.samples).toHaveLength(50)
    expect(pendingPerfSamples()).toEqual([])
  })

  it('read the server\'s own total from Server-Timing', () => {
    expect(serverTotal(new Response('', { headers: { 'server-timing': 'policy;dur=3, write;dur=12, total;dur=41.5' } }))).toBe(41.5)
    expect(serverTotal(new Response(''))).toBeNull()
  })
})

describe('opening a conversation', () => {
  it('says whether it was read again, and why', async () => {
    configurePerfSamples({ httpBase: 'https://api.test', sessionToken: 'a' })
    const cache = new ChannelMessageCache()
    const page = async () => true
    await cache.load('b:x', page, false)
    expect(kinds()).toEqual(['open.cold'])
    cache.remember({ 'b:x': [{ id: 'm1', createdAt: '2026-01-01' } as never] }, {})
    await cache.load('b:x', page, false)
    expect(kinds()).toEqual(['open.cold', 'open.fresh'])
    // Left the chat screen and came back within the minute: read again only for that.
    cache.invalidate()
    await cache.load('b:x', page, false)
    expect(kinds()).toEqual(['open.cold', 'open.fresh', 'open.remount'])
    // A refresh (an AI answer, a reconnect) is not an opening.
    await cache.load('b:x', page, true)
    expect(kinds()).toHaveLength(3)
  })

  it('a kept conversation older than a minute is read again as due, not as a remount', async () => {
    vi.useFakeTimers()
    configurePerfSamples({ httpBase: 'https://api.test', sessionToken: 'a' })
    const cache = new ChannelMessageCache()
    await cache.load('b:x', async () => true, false)
    cache.remember({ 'b:x': [{ id: 'm1', createdAt: '2026-01-01' } as never] }, {})
    vi.advanceTimersByTime(61_000)
    cache.invalidate()
    await cache.load('b:x', async () => true, false)
    expect(kinds()).toEqual(['open.cold', 'open.revalidate'])
  })
})
