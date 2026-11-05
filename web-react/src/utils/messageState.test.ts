import { expect, test } from 'vitest'
import type { ChannelMessage } from '../types/card'
import { reconcileMessage } from './messageState'
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
  expect(reconcileMessage(unpinned, old)).toMatchObject({ pinned: false, pinVersion: 2 })
})
test('a cached page cannot roll back a newer pin even if it was already present when fetching began', () => {
  const current = [message({ pinned: true, pinVersion: 3 })]
  const old = [message({ pinned: false, pinVersion: 2 })]
  expect(mergeLatestMessages(current, old, current, false, true)[0]).toMatchObject({ pinned: true, pinVersion: 3 })
})
test('newer pins, deletions, different messages and legacy unversioned responses retain their meaning', () => {
  const old = message({ pinned: true, pinVersion: 1 })
  expect(reconcileMessage(old, message({ pinned: false, pinVersion: 2 })).pinned).toBe(false)
  expect(reconcileMessage(old, message({ deleted: true, pinned: false })).pinned).toBe(false)
  expect(reconcileMessage(old, message({ id: 'two', pinned: false })).pinned).toBe(false)
  expect(reconcileMessage(message({ pinned: true }), message({ pinned: false })).pinned).toBe(false)
})

test('a delayed pin response cannot replace message content edited on another device', () => {
  const edited = message({ body: 'New words', editedAt: '2026-10-21T10:00:00.000Z', contentVersion: 2, pinned: false, pinVersion: 1 })
  const delayedPin = message({ body: 'Old words', editedAt: '2026-10-20T10:00:00.000Z', contentVersion: 1, pinned: true, pinVersion: 2 })
  expect(reconcileMessage(edited, delayedPin)).toMatchObject({ body: 'New words', contentVersion: 2, pinned: true, pinVersion: 2 })
})

test('an old edit response cannot roll back a newer edit or an unsend', () => {
  const newer = message({ body: 'Final wording', editedAt: '2026-10-21T10:00:00.000Z', contentVersion: 3 })
  const older = message({ body: 'Earlier wording', editedAt: '2026-10-21T09:00:00.000Z', contentVersion: 2 })
  expect(reconcileMessage(newer, older)).toMatchObject({ body: 'Final wording', contentVersion: 3 })
  const deleted = message({ body: '', deleted: true, contentVersion: 4 })
  expect(reconcileMessage(deleted, older)).toMatchObject({ body: '', deleted: true, contentVersion: 4 })
})

test('an optimistic local edit survives an old response and clears when the server confirms it', () => {
  const optimistic = message({ body: 'Saving this', editPending: true, contentVersion: 4 })
  expect(reconcileMessage(optimistic, message({ body: 'Before', contentVersion: 4 })).body).toBe('Saving this')
  expect(reconcileMessage(optimistic, message({ body: 'Saving this', contentVersion: 5 })).editPending).toBeUndefined()
})
