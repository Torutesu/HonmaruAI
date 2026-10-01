import { afterEach, expect, it, vi } from 'vitest'
import { ChannelMessageCache, channelMessageCache, clearMessageCaches, mergeLatestMessages } from './channelMessageCache'
import type { ChannelMessage } from '../types/card'
const message = (id: string, body = id) => ({ id, body, createdAt: `2026-10-01T00:00:${id.padStart(2, '0')}Z`, channel: 'b:a' } as ChannelMessage)
afterEach(() => { clearMessageCaches(); vi.restoreAllMocks() })
it('fetches a channel once across repeated switches and coalesces concurrent requests', async () => {
  const cache = new ChannelMessageCache()
  const load = vi.fn(async () => true)
  await Promise.all([cache.load('a', load), cache.load('a', load)])
  await cache.load('b', load)
  await cache.load('a', load)
  expect(load).toHaveBeenCalledTimes(2)
  await cache.load('a', load, true)
  expect(load).toHaveBeenCalledTimes(3)
})
it('retries failures and refreshes stale or invalidated channels', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const cache = new ChannelMessageCache()
  const load = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
  await cache.load('a', load); await cache.load('a', load)
  now.mockReturnValue(61001)
  await cache.load('a', load)
  cache.invalidate(); await cache.load('a', load)
  expect(load).toHaveBeenCalledTimes(4)
})
it('invalidates an in-flight request on disconnect or logout and starts a fresh one', async () => {
  const cache = new ChannelMessageCache()
  let check!: () => boolean
  let resolve!: (ok: boolean) => void
  const old = cache.load('a', async (valid) => { check = valid; return new Promise<boolean>((r) => { resolve = r }) })
  await Promise.resolve()
  cache.clear()
  expect(check()).toBe(false)
  const load = vi.fn(async () => true)
  await cache.load('a', load)
  resolve(true); await old
  await cache.load('a', load)
  expect(load).toHaveBeenCalledTimes(1)
})
it('isolates cache by server, workspace and login session, and clears it on logout', () => {
  const api = { httpBase: 'https://example.test', orgId: 'one', sessionToken: 'session-a' }
  const first = channelMessageCache(api)
  first.remember({ a: [message('1')] }, { a: false })
  expect(channelMessageCache(api).messages.a).toHaveLength(1)
  for (const change of [{ orgId: 'two' }, { sessionToken: 'session-b' }, { httpBase: 'https://other.test' }]) {
    expect(channelMessageCache({ ...api, ...change }).messages.a).toBeUndefined()
  }
  clearMessageCaches()
  expect(first.messages).toEqual({})
  expect(channelMessageCache(api)).not.toBe(first)
})
it('bounds stored history, remembers pagination and leaves pending sends to the outbox', () => {
  const cache = new ChannelMessageCache()
  cache.remember({ a: Array.from({ length: 400 }, (_, i) => message(String(i))), b: [message('tmp-send')] }, { a: false })
  expect(cache.messages.a).toHaveLength(300)
  expect(cache.more.a).toBe(true)
  expect(cache.messages.b).toEqual([])
  cache.remember(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i), []])), {})
  expect(Object.keys(cache.messages)).toHaveLength(30)
})
it('preserves live edits, arrivals and deletions over an older response', () => {
  const one = message('1'), two = message('2'), three = message('3')
  const edited = { ...one, body: 'edited during fetch' }
  expect(mergeLatestMessages([edited, three], [one, two], [one, two], false, true)).toEqual([edited, three])
})
it('removes messages deleted while offline, including an emptied channel', () => {
  const one = message('1'), two = message('2')
  expect(mergeLatestMessages([one, two], [one], [one, two], false, true)).toEqual([one])
  expect(mergeLatestMessages([one, two], [], [one, two], false, true)).toEqual([])
})
it('keeps older loaded pages until a gap requires starting from the latest page', () => {
  const rows = [message('1'), message('2'), message('3')]
  expect(mergeLatestMessages(rows, [rows[2]], rows, false, false)).toEqual(rows)
  expect(mergeLatestMessages(rows, [rows[2]], rows, true, false)).toEqual([rows[2]])
})
