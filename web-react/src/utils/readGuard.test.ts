import { expect, it } from 'vitest'
import { ReadGuard } from './readGuard'

const item = (key: string, channel: string, at: string, parentId: string | null = null) => ({ key, unread: true, at, message: { channel, parentId, createdAt: at } })
const keyOf = (i: { key?: string }) => i.key!

it('a list fetched before "Mark all as read" does not bring the unread back', () => {
  const g = new ReadGuard()
  const stale = [item('m:1', 'b:a', '2026-10-05T10:00:00Z'), item('m:2', 'b:b', '2026-10-05T10:01:00Z')]
  g.readItems(['m:1', 'm:2'])
  expect(g.activity(stale, keyOf).map((i) => i.unread)).toEqual([false, false])
})

it('a conversation or a thread read up to a time; anything after it is still new', () => {
  const g = new ReadGuard()
  g.readChannel('b:a', '2026-10-05T10:00:00Z')
  g.readThread('p1', '2026-10-05T10:00:00Z')
  const list = [
    item('m:1', 'b:a', '2026-10-05T09:59:00Z'),
    item('m:2', 'b:a', '2026-10-05T10:05:00Z'),
    item('r:3', 'b:a', '2026-10-05T09:59:30Z', 'p1'),
    item('r:4', 'b:a', '2026-10-05T10:06:00Z', 'p1'),
  ]
  expect(g.activity(list, keyOf).map((i) => i.unread)).toEqual([false, true, false, true])
  // Reading a conversation is not reading its threads.
  expect(g.activity([item('r:5', 'b:a', '2026-10-05T09:00:00Z', 'p2')], keyOf)[0].unread).toBe(true)
  const threads = [
    { unread: true, lastReplyAt: '2026-10-05T09:59:30Z', parent: { id: 'p1' } },
    { unread: true, lastReplyAt: '2026-10-05T10:06:00Z', parent: { id: 'p1' } },
    { unread: true, lastReplyAt: '2026-10-05T09:00:00Z', parent: { id: 'p2' } },
  ]
  expect(g.threadList(threads).map((x) => x.unread)).toEqual([false, true, true])
})

it('an answer to an older load that comes back after a newer one is not drawn', () => {
  const g = new ReadGuard()
  const first = g.ask('activity')
  const second = g.ask('activity')
  expect(g.fresh('activity', second)).toBe(true)
  expect(g.fresh('activity', first)).toBe(false)
  // Each kind on its own.
  expect(g.fresh('threads', g.ask('threads'))).toBe(true)
})
