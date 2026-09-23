import { describe, it, expect } from 'vitest'
import { parseRoute, hashForJoin, hashForCard } from './route'

// The URL says where you are, and what a link you were sent opens.
describe('parseRoute', () => {
  it('reads a card, a list, a screen and the root', () => {
    expect(parseRoute('#/feed/c%2F1')).toMatchObject({ mode: 'cards', cardId: 'c/1', join: null })
    expect(parseRoute('#/list')).toMatchObject({ mode: 'classic', cardId: null })
    expect(parseRoute('#/you')).toMatchObject({ screen: 'profile', mode: null })
    expect(parseRoute('')).toEqual({ screen: null, mode: null, cardId: null, join: null })
    expect(parseRoute(hashForCard('c/1')).cardId).toBe('c/1')
  })

  it('reads an invitation, and only something shaped like one', () => {
    const code = 'a3f9c0de'.repeat(4)
    expect(parseRoute(hashForJoin(code)).join).toBe(code)
    expect(parseRoute(`#/join/${code.toUpperCase()}`).join).toBe(code)
    expect(parseRoute('#/join/not-a-code').join).toBeNull()
    expect(parseRoute('#/join/').join).toBeNull()
    expect(parseRoute('#/join/<script>').join).toBeNull()
  })
})
