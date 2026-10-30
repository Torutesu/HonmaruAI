import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { JamThread } from './JamPanel'
import { channelMessageCache, clearMessageCaches } from '../utils/channelMessageCache'
import type { ChannelMessage } from '../types/card'
const api = { httpBase: 'https://api.example', orgId: 'team:a', sessionToken: 'token' }
const row = (n: number) => ({ id: String(n), body: `Reply ${n}`, channel: 'b:room', parentId: 'root', createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString() } as ChannelMessage)
const page = (from: number, to: number, nextCursor: string | null = null) => ({ parent: { ...row(0), id: 'root', parentId: null }, replies: Array.from({ length: to - from + 1 }, (_, i) => row(from + i)), more: Boolean(nextCursor), nextCursor })
const ok = (data: unknown) => ({ status: 200, ok: true, json: async () => data })
const mountWindow = () => { const target = new EventTarget(); vi.stubGlobal('window', target); return target }
afterEach(() => { clearMessageCaches(); vi.unstubAllGlobals(); vi.useRealTimers() })
it('bounds Jam opens and older reads, retaining live arrivals, edits and tombstones during history loading', async () => {
  const target = mountWindow()
  let resolve!: (value: ReturnType<typeof ok>) => void
  const fetch = vi.fn().mockResolvedValueOnce(ok(page(51, 100, 'older'))).mockReturnValueOnce(new Promise(done => { resolve = done }))
  vi.stubGlobal('fetch', fetch)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<JamThread api={api} channel="b:room" messageId="root" />) })
  expect(fetch.mock.calls[0][0]).toContain('limit=50')
  const older = tree.root.findAllByType('button').find(button => button.children.includes('Load older replies'))!
  await act(async () => { void older.props.onClick(); await Promise.resolve() })
  expect(fetch.mock.calls[1][0]).toContain('before=older')
  await act(async () => {
    for (const message of [row(101), { ...row(75), body: 'Edited live' }, { ...row(20), deleted: true }]) target.dispatchEvent(new CustomEvent('honmaru:channel-message', { detail: message }))
    resolve(ok(page(1, 50)))
  })
  const text = JSON.stringify(tree.toJSON())
  expect(text).toContain('Reply 1')
  expect(text).toContain('Reply 101')
  expect(text).toContain('Edited live')
  expect(text).not.toContain('Reply 20"')
  expect(tree.root.findAllByType('p').filter(p => p.props.className === 'jam-line')).toHaveLength(100)
  act(() => tree.unmount())
})
it('fills an offline gap over multiple pages while retaining loaded older history', async () => {
  vi.useFakeTimers()
  const target = mountWindow()
  const fetch = vi.fn().mockResolvedValueOnce(ok(page(51, 100, 'older'))).mockResolvedValueOnce(ok(page(1, 50)))
    .mockResolvedValueOnce(ok(page(151, 200, 'gap-151'))).mockResolvedValueOnce(ok(page(101, 150, 'gap-101')))
    .mockResolvedValueOnce(ok(page(51, 100, 'gap-51'))).mockResolvedValueOnce(ok(page(1, 50)))
  vi.stubGlobal('fetch', fetch)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<JamThread api={api} channel="b:room" messageId="root" />) })
  await act(async () => { tree.root.findAllByType('button').find(button => button.children.includes('Load older replies'))!.props.onClick() })
  await act(async () => { target.dispatchEvent(new Event('honmaru:resync')); await vi.advanceTimersByTimeAsync(350) })
  expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('before'))).toEqual([null, 'older', null, 'gap-151', 'gap-101', 'gap-51'])
  expect(tree.root.findAllByType('p').filter(p => p.props.className === 'jam-line')).toHaveLength(200)
  act(() => tree.unmount())
})
it('ignores an old account response after the Jam changes workspace', async () => {
  mountWindow()
  let resolve!: (value: ReturnType<typeof ok>) => void
  const fetch = vi.fn().mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValueOnce(ok(page(201, 201)))
  vi.stubGlobal('fetch', fetch)
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(<JamThread api={api} channel="b:room" messageId="root" />) })
  await act(async () => { tree.update(<JamThread api={{ ...api, orgId: 'team:b', sessionToken: 'other' }} channel="b:room" messageId="root" />) })
  await act(async () => { resolve(ok(page(51, 100))) })
  expect(JSON.stringify(tree.toJSON())).toContain('Reply 201')
  expect(JSON.stringify(tree.toJSON())).not.toContain('Reply 51')
  act(() => tree.unmount())
})

it('joins the main pane reconnect refresh instead of issuing a second shared request', async () => {
  vi.useFakeTimers()
  const target = mountWindow()
  const fetch = vi.fn().mockResolvedValue(ok(page(51, 100, 'older')))
  vi.stubGlobal('fetch', fetch)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<JamThread api={api} channel="b:room" messageId="root" />) })
  const rootRead = vi.fn().mockResolvedValueOnce({ status: 200, data: page(52, 101, 'next') }).mockResolvedValueOnce({ status: 200, data: page(2, 51, 'older') })
  target.addEventListener('honmaru:resync', () => setTimeout(() => {
    const cache = channelMessageCache(api).threads
    cache.invalidate(); void cache.load('b:room', 'root', rootRead, true)
  }, 300))
  await act(async () => { target.dispatchEvent(new Event('honmaru:resync')); await vi.advanceTimersByTimeAsync(350) })
  expect(rootRead).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(tree.toJSON())).toContain('Reply 101')
  act(() => tree.unmount())
})
