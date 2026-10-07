import { expect, it } from 'vitest'
import { toggleReaction } from './reactions'

it('adds yours as a new pill, or one more on a pill already there', () => {
  expect(toggleReaction(undefined, '👍', 'me')).toEqual([{ emoji: '👍', count: 1, refs: ['me'], mine: true }])
  expect(toggleReaction([{ emoji: '👍', count: 2, refs: ['a', 'b'], mine: false }], '👍', 'me'))
    .toEqual([{ emoji: '👍', count: 3, refs: ['a', 'b', 'me'], mine: true }])
})

it('takes yours back: one fewer, and the pill goes at none — the others stay where they are', () => {
  const list = [{ emoji: '🎉', count: 1, refs: ['a'], mine: false }, { emoji: '👍', count: 2, refs: ['a', 'me'], mine: true }, { emoji: '❤️', count: 1, refs: ['me'], mine: true }]
  expect(toggleReaction(list, '👍', 'me')[1]).toEqual({ emoji: '👍', count: 1, refs: ['a'], mine: false })
  expect(toggleReaction(list, '❤️', 'me').map((r) => r.emoji)).toEqual(['🎉', '👍'])
})

it('toggled twice is as it was: a failure undoes it', () => {
  const list = [{ emoji: '👍', count: 2, refs: ['a', 'me'], mine: true }]
  expect(toggleReaction(toggleReaction(list, '👍', 'me'), '👍', 'me')).toEqual(list)
})
