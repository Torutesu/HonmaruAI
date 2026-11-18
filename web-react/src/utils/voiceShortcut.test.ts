import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_SHORTCUT, displayVoiceShortcut, matchesVoiceShortcut, readVoiceShortcut, shortcutFromEvent, voiceShortcutConflict, writeVoiceShortcut } from './voiceShortcut'

describe('voice input shortcuts', () => {
  const values = new Map<string, string>()
  beforeEach(() => {
    values.clear()
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } })
  })
  afterEach(() => { delete (globalThis as { localStorage?: Storage }).localStorage })

  it('normalizes modifiers and requires a printable key plus a modifier', () => {
    expect(shortcutFromEvent({ key: 'v', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true })).toBe('Alt+Shift+V')
    expect(shortcutFromEvent({ key: 'Shift', altKey: false, ctrlKey: false, metaKey: false, shiftKey: true })).toBeNull()
    expect(shortcutFromEvent({ key: 'v', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBeNull()
  })

  it('stores a shortcut per account and falls back to the default for invalid values', () => {
    expect(readVoiceShortcut('one')).toBe(DEFAULT_VOICE_SHORTCUT)
    expect(writeVoiceShortcut('one', 'Meta+Shift+M')).toBe('Meta+Shift+M')
    expect(readVoiceShortcut('one')).toBe('Meta+Shift+M')
    expect(readVoiceShortcut('two')).toBe(DEFAULT_VOICE_SHORTCUT)
    localStorage.setItem('honmaru.dictation.shortcut.v1:three', 'V')
    expect(readVoiceShortcut('three')).toBe(DEFAULT_VOICE_SHORTCUT)
  })

  it('detects collisions with navigation, search, send, and browser shortcuts', () => {
    expect(voiceShortcutConflict('Meta+K')).toBe(true)
    expect(voiceShortcutConflict('Meta+F')).toBe(true)
    expect(voiceShortcutConflict('Ctrl+W')).toBe(true)
    expect(voiceShortcutConflict('Ctrl+Shift+V')).toBe(true)
    expect(voiceShortcutConflict(DEFAULT_VOICE_SHORTCUT)).toBe(false)
  })

  it('matches the complete chord and formats it for the current platform', () => {
    expect(matchesVoiceShortcut({ key: 'm', altKey: true, ctrlKey: false, metaKey: true, shiftKey: true }, 'Meta+Alt+Shift+M')).toBe(true)
    expect(matchesVoiceShortcut({ key: 'm', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true }, 'Meta+Alt+Shift+M')).toBe(false)
    expect(displayVoiceShortcut('Meta+Alt+Shift+M', 'MacIntel')).toBe('⌘⌥⇧M')
    expect(displayVoiceShortcut('Ctrl+Alt+Shift+M', 'Win32')).toBe('Ctrl+Alt+Shift+M')
  })
})
