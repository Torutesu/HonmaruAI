import { describe, it, expect } from 'vitest'
import { hasOlder, olderThan } from './historyPage'

const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))

// The start of a conversation is where the Worker says it is, not wherever
// a page happens to come back short.
describe('hasOlder', () => {
  it("takes the Worker's word when it gives one", () => {
    // One unsent message on the page: short, and still more above it.
    expect(hasOlder({ messages: page(149), more: true }, 150)).toBe(true)
    // A full page that is the whole conversation.
    expect(hasOlder({ messages: page(150), more: false }, 150)).toBe(false)
  })

  it('does not go on from a page with nothing on it', () => {
    // Paging goes on from the oldest message loaded; an empty page moves
    // it nowhere, and asking again would bring the same page.
    expect(hasOlder({ messages: [], more: true }, 150)).toBe(false)
  })

  it('counts the page when the Worker does not say', () => {
    expect(hasOlder({ messages: page(150) }, 150)).toBe(true)
    expect(hasOlder({ messages: page(149) }, 150)).toBe(false)
    expect(hasOlder({ messages: page(3), more: null }, 150)).toBe(false)
    expect(hasOlder({ messages: page(150), more: 'yes' }, 150)).toBe(true)
  })

  it('is no more for nothing at all', () => {
    expect(hasOlder({}, 150)).toBe(false)
    expect(hasOlder({ messages: null }, 150)).toBe(false)
    expect(hasOlder(null, 150)).toBe(false)
    expect(hasOlder(undefined, 150)).toBe(false)
  })
})

describe('olderThan', () => {
  it('asks from the oldest message by its time and its id', () => {
    expect(olderThan({ createdAt: '2026-01-01T00:00:02.000Z', id: 'm 1' })).toBe('before=2026-01-01T00%3A00%3A02.000Z&beforeId=m%201')
  })
})
