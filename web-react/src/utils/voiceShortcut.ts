const PREFIX = 'honmaru.dictation.shortcut.v1'
export const DEFAULT_VOICE_SHORTCUT = 'Alt+Shift+V'

const RESERVED = new Set([
  'Meta+K', 'Ctrl+K', 'Meta+/', 'Ctrl+/', 'Meta+Shift+O', 'Ctrl+Shift+O',
  'Meta+Enter', 'Ctrl+Enter', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Ctrl+Shift+V', 'Meta+Shift+V',
])

export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

export function shortcutFromEvent(event: ShortcutEvent): string | null {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  if (!/^[A-Z0-9]$/.test(key)) return null
  if (!event.altKey && !event.ctrlKey && !event.metaKey) return null
  return [event.metaKey ? 'Meta' : '', event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key]
    .filter(Boolean).join('+')
}

export function voiceShortcutConflict(shortcut: string): boolean {
  return RESERVED.has(shortcut)
}

export function matchesVoiceShortcut(event: ShortcutEvent, shortcut: string): boolean {
  return shortcutFromEvent(event) === shortcut
}

export function readVoiceShortcut(userId: string): string {
  if (!userId || typeof localStorage === 'undefined') return DEFAULT_VOICE_SHORTCUT
  try {
    const value = localStorage.getItem(`${PREFIX}:${encodeURIComponent(userId)}`)
    return value && shortcutFromEvent({ key: value.split('+').at(-1) || '', altKey: value.split('+').includes('Alt'), ctrlKey: value.split('+').includes('Ctrl'), metaKey: value.split('+').includes('Meta'), shiftKey: value.split('+').includes('Shift') })
      === value ? value : DEFAULT_VOICE_SHORTCUT
  } catch { return DEFAULT_VOICE_SHORTCUT }
}

export function writeVoiceShortcut(userId: string, shortcut: string): string {
  if (!shortcutFromEvent({ key: shortcut.split('+').at(-1) || '', altKey: shortcut.split('+').includes('Alt'), ctrlKey: shortcut.split('+').includes('Ctrl'), metaKey: shortcut.split('+').includes('Meta'), shiftKey: shortcut.split('+').includes('Shift') })) return readVoiceShortcut(userId)
  if (userId && typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`${PREFIX}:${encodeURIComponent(userId)}`, shortcut) } catch { /* Keep the current browser session usable without storage. */ }
  }
  return shortcut
}

export function displayVoiceShortcut(shortcut: string, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return shortcut.split('+').map(part => part === 'Meta' ? (platform.includes('Mac') ? '⌘' : 'Meta') : part === 'Ctrl' ? (platform.includes('Mac') ? '⌃' : 'Ctrl') : part === 'Alt' && platform.includes('Mac') ? '⌥' : part === 'Shift' ? (platform.includes('Mac') ? '⇧' : 'Shift') : part).join(platform.includes('Mac') ? '' : '+')
}
