// Keys, as the person's own keyboard writes them. A Mac says ⌘⇧A and means
// Command; Windows and Linux say Ctrl+Shift+A. The app's keys already answer
// to Ctrl off a Mac, so what it prints is only a question of whose keyboard
// is in front of it — and printing ⌘ to someone with no ⌘ key is a shortcut
// they cannot find.

/// Enough of `navigator` to tell a Mac from anything else.
export interface NavigatorLike {
  platform?: string
  userAgent?: string
  userAgentData?: { platform?: string } | null
}

/// A Mac, or an iPhone or iPad (a keyboard on one has ⌘ too). The newer
/// `userAgentData.platform` is read first ("macOS"), then the old
/// `platform` ("MacIntel", "iPad"), and the user agent last, for a browser
/// that leaves both out.
export function isMacPlatform(nav: NavigatorLike | null | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  if (!nav) return false
  const said = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  return /Mac|iPhone|iPad|iPod/i.test(said)
}

/// The shortcut modifier for this keyboard: Command on a Mac, Ctrl everywhere
/// else. Ctrl+K on a Mac is the system's "delete to end of line".
export function hasPrimaryMod(e: { metaKey: boolean; ctrlKey: boolean }, mac = isMacPlatform()): boolean {
  return mac ? e.metaKey : e.ctrlKey
}

/// What each part of a combo is called on a Mac: glyphs, written together.
const MAC: Record<string, string> = {
  Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫',
}
/// …and everywhere else: words, joined with "+". Arrows are arrows on any
/// keyboard.
const OTHER: Record<string, string> = {
  Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: 'Backspace',
}

/// A combo written once, the way code names it — "Mod+Shift+A", "Alt+Up",
/// "Shift+Esc" — as this keyboard prints it: "⌘⇧A" on a Mac, "Ctrl+Shift+A"
/// elsewhere. Alternatives are separated by " / " ("Alt+Up / Alt+Down"),
/// and anything it has no name for ("N", "Enter", "1–9") is left as it is.
export function formatCombo(combo: string, mac: boolean): string {
  const names = mac ? MAC : OTHER
  // Not Object.hasOwn: the top bar prints a key on every load, and Safari
  // before 15.4 has no such function — it would take the whole app down.
  const named = (part: string) => Object.prototype.hasOwnProperty.call(names, part)
  return combo
    .split(' / ')
    .map((one) => one.split('+').map((part) => (named(part) ? names[part] : part)).join(mac ? '' : '+'))
    .join(' / ')
}
// Keys typed through an input method — Japanese, Chinese, Korean. The Enter
// that confirms a conversion is not the Enter that sends: a message must not
// go out half-converted. Chrome and Edge (the browsers of most Windows
// offices) mark that keydown `isComposing`; Safari ends the composition first
// and only leaves keyCode 229 behind. Both are taken as "still composing".

interface KeyLike {
  key?: string
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

export function composing(e: KeyLike): boolean {
  return Boolean(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.nativeEvent?.keyCode === 229)
}

/// An Enter the person meant: not one that picked a conversion.
export const enterKey = (e: KeyLike): boolean => e.key === 'Enter' && !composing(e)

/// Scoped to a composer, never installed as a global browser shortcut.
export function attachmentShortcut(e: KeyLike & {metaKey:boolean;ctrlKey:boolean;altKey?:boolean;shiftKey?:boolean;defaultPrevented?:boolean;repeat?:boolean}, mac = isMacPlatform()): boolean {
  return !e.defaultPrevented && !e.repeat && !composing(e) && !e.altKey && !e.shiftKey && hasPrimaryMod(e,mac) && e.key?.toLowerCase() === "u"
}
