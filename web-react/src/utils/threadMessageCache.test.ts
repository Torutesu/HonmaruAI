import { afterEach, expect, it, vi } from 'vitest'
import { ThreadMessageCache, type ThreadSnapshot } from './threadMessageCache'
import { channelMessageCache, clearMessageCaches, mergeLatestMessages } from './channelMessageCache'
import type { ChannelMessage } from '../types/card'
import { withHeld } from './pendingSend'
const message = (id: string, parentId?: string, body = id) => ({ id, parentId, body, channel: 'b:a', createdAt: `2026-10-01T00:00:${id.padStart(2, '0')}Z` } as ChannelMessage)
const snapshot = (parent = 'root', replies = [message('1', parent)]): ThreadSnapshot => ({ parent: message(parent), replies })
const ok = (data = snapshot()) => ({ status: 200, data })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
afterEach(() => { clearMessageCaches(); vi.restoreAllMocks() })
it('joins hover, click and reopen, with zero new reads for a fresh reopen', async () => {
  const cache = new ThreadMessageCache(), response = deferred<ReturnType<typeof ok>>()
  const read = vi.fn(() => response.promise)
  const prefetch = cache.load('b:a', 'root', read)
  const visit = cache.load('b:a', 'root', read)
  expect(visit).toBe(prefetch)
  await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1)
  response.resolve(ok())
  expect(await prefetch).toEqual(await visit)
  expect(cache.get('b:a', 'root')).toEqual(snapshot())
  await cache.load('b:a', 'root', read)
  expect(read).toHaveBeenCalledTimes(1)
})
it('refreshes stale and explicit retry requests once, without making local changes fresh', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000), cache = new ThreadMessageCache(), read = vi.fn(async () => ok())
  await cache.load('b:a', 'root', read)
  now.mockReturnValue(61_001)
  cache.remember('b:a', message('root'), [message('2', 'root')])
  expect(cache.fresh('b:a', 'root')).toBe(false)
  await Promise.all([cache.load('b:a', 'root', read), cache.load('b:a', 'root', read)])
  await Promise.all([cache.load('b:a', 'root', read, true), cache.load('b:a', 'root', read, true)])
  expect(read).toHaveBeenCalledTimes(3)
})
it('serializes a reconnect refresh after an already pending read and discards its old response', async () => {
  const cache = new ThreadMessageCache(), first = deferred<ReturnType<typeof ok>>()
  const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok(snapshot('root', [message('2', 'root')])))
  const before = cache.load('b:a', 'root', read)
  await Promise.resolve(); cache.invalidate()
  const after = cache.load('b:a', 'root', read, true)
  expect(after).toBe(before); expect(read).toHaveBeenCalledTimes(1)
  first.resolve(ok())
  expect(await after).toEqual(snapshot('root', [message('2', 'root')]))
  expect(read).toHaveBeenCalledTimes(2)
})
it('preserves live edits, arrivals, quote changes and deletions even during the first prefetch', async () => {
  const cache = new ThreadMessageCache(), response = deferred<ReturnType<typeof ok>>()
  const task = cache.load('b:a', 'root', () => response.promise)
  await Promise.resolve()
  cache.change(message('1', 'root', 'edited live'))
  cache.change({ ...message('2', 'root'), deleted: true })
  cache.change(message('3', 'root'))
  response.resolve(ok(snapshot('root', [message('1', 'root'), message('2', 'root')])))
  expect(await task).toEqual(snapshot('root', [message('1', 'root', 'edited live'), message('3', 'root')]))
  cache.change(message('4', 'root'))
  cache.change({ ...message('1', 'root'), deleted: true })
  expect(cache.get('b:a', 'root')!.replies.map(row => row.id)).toEqual(['3', '4'])
})
it('cannot restore a deleted parent and discards denied/deleted snapshots', async () => {
  const cache = new ThreadMessageCache(), response = deferred<ReturnType<typeof ok>>()
  const task = cache.load('b:a', 'root', () => response.promise)
  await Promise.resolve(); cache.change({ ...message('root'), deleted: true }); cache.change(message('root')); response.resolve(ok())
  expect(await task).toBe('denied'); expect(cache.get('b:a', 'root')).toBeUndefined()
  expect(await cache.load('b:a', 'root', async () => ok({ ...snapshot(), parent: { ...message('root'), deleted: true } }))).toBe('denied')
  for (const status of [401, 403, 404, 410]) {
    cache.remember('b:a', message('root'), [])
    expect(await cache.load('b:a', 'root', async () => ({ status, data: null }), true)).toBe('denied')
    expect(cache.get('b:a', 'root')).toBeUndefined()
  }
})
it('keeps cached data offline and retries errors and malformed successes', async () => {
  const cache = new ThreadMessageCache()
  await cache.load('b:a', 'root', async () => ok())
  expect(await cache.load('b:a', 'root', async () => { throw new Error('offline') }, true)).toBeNull()
  expect(cache.get('b:a', 'root')).toEqual(snapshot())
  expect(cache.fresh('b:a', 'root')).toBe(false)
  expect(await cache.load('b:a', 'root', async () => ({ status: 200, data: null }), true)).toBeNull()
  const retry = vi.fn(async () => ok())
  await cache.load('b:a', 'root', retry, true)
  expect(retry).toHaveBeenCalledTimes(1)
})
it('isolates channels, workspace/account/server scopes and late responses after logout', async () => {
  const api = { httpBase: 'https://a.test', orgId: 'one', sessionToken: 'a' }, owner = channelMessageCache(api)
  await owner.threads.load('b:a', 'root', async () => ok())
  expect(owner.threads.get('b:other', 'root')).toBeUndefined()
  for (const change of [{ orgId: 'two' }, { sessionToken: 'b' }, { httpBase: 'https://b.test' }]) expect(channelMessageCache({ ...api, ...change }).threads.get('b:a', 'root')).toBeUndefined()
  const response = deferred<ReturnType<typeof ok>>()
  const pending = owner.threads.load('b:a', 'root', () => response.promise, true)
  await Promise.resolve(); clearMessageCaches(); response.resolve(ok())
  expect(await pending).toBe('obsolete'); expect(owner.threads.get('b:a', 'root')).toBeUndefined()
})
it('keeps separate thread responses separate, and bounds remembered threads', async () => {
  const cache = new ThreadMessageCache(), slow = deferred<ReturnType<typeof ok>>()
  const first = cache.load('b:a', 'first', () => slow.promise)
  await cache.load('b:a', 'second', async () => ok(snapshot('second')))
  slow.resolve(ok(snapshot('first'))); await first
  expect(cache.get('b:a', 'second')!.parent.id).toBe('second')
  for (let i = 0; i < 101; i++) cache.remember('b:a', message(String(i)), [])
  expect(cache.get('b:a', 'first')).toBeUndefined()
})
it('refresh reconciliation keeps live/local edits, deletion, pending and failed sends, and held outbox rows', () => {
  const before = [message('1', 'root'), message('2', 'root')]
  const edited = message('1', 'root', 'edited while refreshing')
  const pending = { ...message('tmp-pending', 'root'), pending: true }
  const failed = { ...message('tmp-failed', 'root'), failed: 'offline' }
  const current = [edited, message('3', 'root'), pending, failed]
  const held = { ...message('tmp-held', 'root'), failed: 'offline before visit' }
  expect(withHeld(mergeLatestMessages(current, before, before, false, true), [held])).toEqual([edited, current[1], failed, pending, held])
})
