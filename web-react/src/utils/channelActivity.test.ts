import { expect, test } from 'vitest'
import type { ChannelMessage } from '../types/card'
import { receiveChannelActivity } from './channelActivity'

const message = (extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: 'question', channel: 'g:team', kind: 'message', body: 'Which supplier?',
  createdAt: '2026-10-23T01:00:00.000Z', authorName: 'Owner', authorRef: 'owner',
  mine: false, cardId: null, ...extra,
})

test('a new question advances sidebar activity independently of message rendering', () => {
  const previous = receiveChannelActivity({}, message({ id: 'old', mine: true, createdAt: '2026-10-23T00:00:00.000Z' }))
  const next = receiveChannelActivity(previous, message())
  expect(next['g:team']).toMatchObject({ lastBy: 'Owner', lastAt: message().createdAt })
  // Moving the read cursor back before this question must make it fresh.
  expect(next['g:team'].lastAt > '2026-10-23T00:59:59.999Z').toBe(true)
  expect(previous['g:team'].lastBy).toBe('me')
})

test('late duplicates, history and thread reply events cannot replace newer room activity', () => {
  const current = receiveChannelActivity({}, message())
  for (const event of [message(), message({ createdAt: '2026-10-22' }),
    message({ parentId: 'question', createdAt: '2026-10-23T02:00:00.000Z', mine: true }),
    message({ deleted: true }), message({ editedAt: '2026-10-23T02:00:00.000Z' })]) {
    expect(receiveChannelActivity(current, event)).toBe(current)
  }
  expect(receiveChannelActivity(current, message({ channel: 'b:other' }))['g:team']).toBe(current['g:team'])
})

