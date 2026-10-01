import { setQuietState } from './quiet'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { nativeNotificationSilent, DEFAULT_SOUNDS, loadSoundSettings, saveSoundSettings, allowedBy, playSound, soundForMessage, rememberLevel, rememberLevels, levelOf } from './sound'

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

// What the socket reads to decide on a sound or a notification.
describe('conversation levels, as this browser remembers them', () => {
  afterEach(() => vi.unstubAllGlobals())
  const storage = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } })
  }

  it('writes one conversation without touching the others', () => {
    storage()
    rememberLevels('org', { 'b:a': 'mute', 'b:b': 'mentions' })
    rememberLevel('org', 'b:c', 'mute')
    rememberLevel('org', 'b:a', 'all')
    expect(levelOf('org', 'b:a')).toBe('all')
    expect(levelOf('org', 'b:b')).toBe('mentions')
    expect(levelOf('org', 'b:c')).toBe('mute')
  })

  it('works before anything was remembered', () => {
    storage()
    rememberLevel('org', 'dm:x', 'mute')
    expect(levelOf('org', 'dm:x')).toBe('mute')
  })
})


describe('notification sound policy', () => {
  afterEach(() => { vi.unstubAllGlobals(); setQuietState({ pausedUntil: null, schedule: null }) })
  const storage = (raw: unknown) => {
    let saved = JSON.stringify(raw)
    vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_: string, v: string) => { saved = v } })
  }
  it('defaults to important events, with reading and sending silent', () => {
    storage(null)
    const s = loadSoundSettings()
    for (const kind of ['mention', 'decision', 'reply', 'ring'] as const) expect(allowedBy(s, kind)).toBe(true)
    for (const kind of ['message', 'inConversation', 'sent', 'jamJoin', 'jamLeave'] as const) expect(allowedBy(s, kind)).toBe(false)
  })
  it('preserves saved choices and migrates the old combined call switch', () => {
    storage({ enabled: false, volume: 0.8, inConversation: true, sent: true, jam: false })
    expect(loadSoundSettings()).toMatchObject({ enabled: false, volume: 0.8, inConversation: true, sent: true, calls: false })
    saveSoundSettings({ ...DEFAULT_SOUNDS, calls: false, jam: true })
    expect(loadSoundSettings()).toMatchObject({ calls: false, jam: true })
  })
  it('rejects invalid stored types and clamps volume', () => {
    storage({ enabled: 'yes', mentions: 0, volume: 100, calls: null })
    expect(loadSoundSettings()).toMatchObject({ enabled: true, mentions: true, volume: 1, calls: true })
  })
  it('suppresses a call during quiet time before accessing audio', () => {
    storage(DEFAULT_SOUNDS)
    setQuietState({ pausedUntil: new Date(Date.now() + 60_000).toISOString(), schedule: null })
    const create = vi.fn(() => { throw new Error('must not reach audio') })
    vi.stubGlobal('window', { AudioContext: create })
    expect(playSound('ring')).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
  it('leaves background desktop alerts to the OS instead of playing twice', () => {
    storage(DEFAULT_SOUNDS)
    const create = vi.fn(() => { throw new Error('must not reach audio') })
    vi.stubGlobal('window', { honmaruDesktop: { isDesktop: true, show() {} }, AudioContext: create })
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
    for (const kind of ['mention', 'decision', 'reply'] as const) expect(playSound(kind)).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
})

it('coalesces native sounds while preserving mute and per-event choices', () => {
  let raw = JSON.stringify(DEFAULT_SOUNDS)
  vi.stubGlobal('localStorage', { getItem: () => raw })
  const now = vi.spyOn(Date, 'now').mockReturnValue(2000000000000)
  expect(nativeNotificationSilent('mention')).toBe(false)
  expect(nativeNotificationSilent('mention')).toBe(true)
  now.mockReturnValue(2000000002000)
  expect(nativeNotificationSilent('reply')).toBe(false)
  raw = JSON.stringify({ ...DEFAULT_SOUNDS, replies: false })
  now.mockReturnValue(2000000004000)
  expect(nativeNotificationSilent('reply')).toBe(true)
  raw = JSON.stringify({ ...DEFAULT_SOUNDS, enabled: false })
  expect(nativeNotificationSilent('decision')).toBe(true)
  now.mockRestore(); vi.unstubAllGlobals()
})
