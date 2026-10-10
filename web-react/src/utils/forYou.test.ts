import { describe, it, expect } from 'vitest'
import { ForYou } from './forYou'

// The server's "for you" and the message it names, in either order.
describe('ForYou', () => {
  it('pairs a message with the word that came before it', () => {
    const f = new ForYou<{ id: string; body: string }>()
    expect(f.flag('m1', 'direct', 0)).toBeNull()
    expect(f.message({ id: 'm1', body: 'hi' }, 10)).toEqual({ id: 'm1', body: 'hi' })
  })

  it('pairs a word with the message that came before it', () => {
    const f = new ForYou<{ id: string; body: string }>()
    expect(f.message({ id: 'm1', body: 'hi' }, 0)).toBeNull()
    expect(f.flag('m1', 'thread', 10)).toEqual({ id: 'm1', body: 'hi' })
  })

  it('keeps the message as it first arrived when an edit follows', () => {
    const f = new ForYou<{ id: string; body: string }>()
    f.message({ id: 'm1', body: 'first' }, 0)
    f.message({ id: 'm1', body: 'edited' }, 5)
    expect(f.flag('m1', 'mention', 10)?.body).toBe('first')
  })

  it('does nothing for a message nobody said was for you', () => {
    const f = new ForYou<{ id: string }>()
    expect(f.message({ id: 'm1' }, 0)).toBeNull()
    expect(f.message({ id: 'm2' }, 0)).toBeNull()
  })

  it('forgets what waited too long for its other half', () => {
    const f = new ForYou<{ id: string }>(1000)
    f.flag('m1', 'direct', 0)
    expect(f.message({ id: 'm1' }, 5000)).toBeNull()
  })

  it('shows a message once, however it was found to be for you', () => {
    const f = new ForYou<{ id: string }>()
    expect(f.take('m1')).toBe(true)
    expect(f.take('m1')).toBe(false)
    expect(f.take('m2')).toBe(true)
  })
})
