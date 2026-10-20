import { expect, test } from 'vitest'
import type { ChannelMessage } from '../types/card'
import { newerPin } from './messagePin'
import { arrive } from './pendingSend'
import { mergeLatestMessages } from './channelMessageCache'

const message = (extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: 'one', channel: 'b:room', kind: 'message', body: 'Task', createdAt: '2026-10-20',
  authorName: 'A', authorRef: 'a', mine: true, cardId: null, ...extra,
})
test('a delayed reply event updates the reply count without undoing a confirmed pin', () => {
  const pinned = message({ pinned: true, pinVersion: 1 })
  const delayed = message({ pinned: false, pinVersion: 0, replyCount: 2 })
  expect(arrive([pinned], delayed)[0]).toMatchObject({ pinned: true, pinVersion: 1, replyCount: 2 })
})
test('an unpin from another client cannot be reversed by an older pin event or request response', () => {
  const unpinned = message({ pinned: false, pinVersion: 2 })
  const old = message({ pinned: true, pinVersion: 1 })
  expect(arrive([unpinned], old)[0]).toMatchObject({ pinned: false, pinVersion: 2 })
  expect(newerPin(unpinned, old)).toMatchObject({ pinned: false, pinVersion: 2 })
})
test('a cached page cannot roll back a newer pin even if it was already present when fetching began', () => {
  const current = [message({ pinned: true, pinVersion: 3 })]
  const old = [message({ pinned: false, pinVersion: 2 })]
  expect(mergeLatestMessages(current, old, current, false, true)[0]).toMatchObject({ pinned: true, pinVersion: 3 })
})
test('newer pins, deletions, different messages and legacy unversioned responses retain their meaning', () => {
  const old = message({ pinned: true, pinVersion: 1 })
  expect(newerPin(old, message({ pinned: false, pinVersion: 2 })).pinned).toBe(false)
  expect(newerPin(old, message({ deleted: true, pinned: false })).pinned).toBe(false)
  expect(newerPin(old, message({ id: 'two', pinned: false })).pinned).toBe(false)
  expect(newerPin(message({ pinned: true }), message({ pinned: false })).pinned).toBe(false)
})
