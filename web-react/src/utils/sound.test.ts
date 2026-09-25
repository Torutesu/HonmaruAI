import { describe, expect, it } from 'vitest'
import { soundForMessage } from './sound'

// When a message arriving makes a sound, and which.
describe('soundForMessage', () => {
  const channel = { mine: false, channel: 'b:cafe', mentionsMe: false }
  it('is silent for what you wrote yourself', () => {
    expect(soundForMessage({ ...channel, mine: true }, { level: 'all', open: false })).toBe(null)
  })
  it('knocks for a direct message or a mention, drops for a channel message', () => {
    expect(soundForMessage({ ...channel, channel: 'dm:abc' }, { level: 'all', open: false })).toBe('mention')
    expect(soundForMessage({ ...channel, mentionsMe: true }, { level: 'all', open: false })).toBe('mention')
    expect(soundForMessage(channel, { level: 'all', open: false })).toBe('message')
  })
  it('respects mute and mentions-only', () => {
    expect(soundForMessage({ ...channel, mentionsMe: true }, { level: 'mute', open: false })).toBe(null)
    expect(soundForMessage(channel, { level: 'mentions', open: false })).toBe(null)
    expect(soundForMessage({ ...channel, mentionsMe: true }, { level: 'mentions', open: false })).toBe('mention')
  })
  it('keeps a channel thread reply quiet unless it names you', () => {
    expect(soundForMessage({ ...channel, parentId: 'm1' }, { level: 'all', open: false })).toBe(null)
    expect(soundForMessage({ ...channel, parentId: 'm1', mentionsMe: true }, { level: 'all', open: false })).toBe('mention')
  })
  it('only ticks in the conversation you are looking at', () => {
    expect(soundForMessage({ ...channel, channel: 'dm:abc' }, { level: 'all', open: true })).toBe('inConversation')
  })
})
