import { afterEach, expect, it, vi } from 'vitest'
import { ViewCache } from './viewCache'
import { channelMessageCache, clearMessageCaches } from './channelMessageCache'

afterEach(() => { clearMessageCaches(); vi.restoreAllMocks() })

it('keeps what was shown, and knows when it was last read from the server', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const cache = new ViewCache()
  expect(cache.get('profile:a')).toBeUndefined()
  expect(cache.fresh('profile:a', 30_000)).toBe(false)
  cache.set('profile:a', { name: 'A' })
  expect(cache.get('profile:a')).toEqual({ name: 'A' })
  expect(cache.fresh('profile:a', 30_000)).toBe(true)
  now.mockReturnValue(40_000)
  expect(cache.fresh('profile:a', 30_000)).toBe(false)
  // A change made here is kept, but is not a fresh read.
  cache.set('profile:a', { name: 'A2' }, { read: false })
  expect(cache.get('profile:a')).toEqual({ name: 'A2' })
  expect(cache.fresh('profile:a', 30_000)).toBe(false)
})

it('marks a prefix stale without dropping it, and stays bounded', () => {
  const cache = new ViewCache()
  cache.set('profile:a', 1); cache.set('thread:x', 2)
  cache.stale('profile:')
  expect(cache.get('profile:a')).toBe(1)
  expect(cache.fresh('profile:a', 60_000)).toBe(false)
  expect(cache.fresh('thread:x', 60_000)).toBe(true)
  for (let i = 0; i < 250; i++) cache.set(`k${i}`, i)
  expect(cache.get('profile:a')).toBeUndefined()
  expect(cache.get('k249')).toBe(249)
})

it('is scoped to the account and workspace, and cleared with its messages', () => {
  const a = channelMessageCache({ httpBase: 'h', orgId: 'one', sessionToken: 's' })
  const b = channelMessageCache({ httpBase: 'h', orgId: 'two', sessionToken: 's' })
  a.views.set('threads', ['t'])
  expect(b.views.get('threads')).toBeUndefined()
  expect(channelMessageCache({ httpBase: 'h', orgId: 'one', sessionToken: 's' }).views.get('threads')).toEqual(['t'])
  clearMessageCaches()
  expect(a.views.get('threads')).toBeUndefined()
})
