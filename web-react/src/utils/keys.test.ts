import { describe, it, expect } from 'vitest'
import { isMacPlatform, formatCombo, hasPrimaryMod, composing, enterKey, attachmentShortcut } from './keys'

// ⌘ on a Mac, Ctrl everywhere else: what the shortcuts sheet, the search
// button and the workspace menu print.
describe('which keyboard this is', () => {
  it('knows a Mac, an iPad and an iPhone by what the browser says', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ platform: 'iPad' })).toBe(true)
    expect(isMacPlatform({ platform: 'iPhone' })).toBe(true)
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: '' })).toBe(true)
    // No platform at all: the user agent still names the machine.
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)' })).toBe(true)
  })
  it('is not a Mac on Windows, Linux, Android or with nothing to go on', () => {
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false)
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' })).toBe(false)
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false)
    expect(isMacPlatform({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBe(false)
    expect(isMacPlatform({})).toBe(false)
    expect(isMacPlatform(null)).toBe(false)
  })
  it('takes Command on a Mac and Ctrl everywhere else', () => {
    expect(hasPrimaryMod({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(hasPrimaryMod({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(hasPrimaryMod({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(hasPrimaryMod({ metaKey: true, ctrlKey: false }, false)).toBe(false)
  })
  it('reads the newer platform before the old one', () => {
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false)
  })
})

describe('a combo as the keyboard prints it', () => {
  it('writes glyphs together on a Mac', () => {
    expect(formatCombo('Mod+Shift+A', true)).toBe('⌘⇧A')
    expect(formatCombo('Mod+K', true)).toBe('⌘K')
    expect(formatCombo('Shift+Esc', true)).toBe('⇧Esc')
    expect(formatCombo('Alt+Shift+Down', true)).toBe('⌥⇧↓')
    expect(formatCombo('Ctrl+Alt+Left', true)).toBe('⌃⌥←')
  })
  it('writes words joined with + everywhere else', () => {
    expect(formatCombo('Mod+Shift+A', false)).toBe('Ctrl+Shift+A')
    expect(formatCombo('Mod+/', false)).toBe('Ctrl+/')
    expect(formatCombo('Shift+Esc', false)).toBe('Shift+Esc')
    expect(formatCombo('Alt+Up', false)).toBe('Alt+↑')
  })
  it('keeps alternatives apart and leaves keys it has no name for alone', () => {
    expect(formatCombo('Alt+Up / Alt+Down', true)).toBe('⌥↑ / ⌥↓')
    expect(formatCombo('Alt+Up / Alt+Down', false)).toBe('Alt+↑ / Alt+↓')
    expect(formatCombo('Mod+1–9', true)).toBe('⌘1–9')
    expect(formatCombo('Mod+1–9', false)).toBe('Ctrl+1–9')
    expect(formatCombo('N', false)).toBe('N')
    expect(formatCombo('J / K', true)).toBe('J / K')
    expect(formatCombo('Enter', true)).toBe('Enter')
    // A key named like something on Object's prototype is still just a key.
    expect(formatCombo('Mod+constructor', false)).toBe('Ctrl+constructor')
  })
  it('runs on a browser older than Object.hasOwn (Safari before 15.4)', () => {
    const was = Object.getOwnPropertyDescriptor(Object, 'hasOwn')
    Reflect.deleteProperty(Object, 'hasOwn')
    try {
      expect(formatCombo('Mod+Shift+A', true)).toBe('⌘⇧A')
      expect(formatCombo('Mod+K', false)).toBe('Ctrl+K')
    } finally {
      if (was) Object.defineProperty(Object, 'hasOwn', was)
    }
  })
})

describe('keys typed through an input method', () => {
  it('a plain Enter sends', () => {
    expect(enterKey({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } })).toBe(true)
  })
  it('the Enter that confirms a conversion in Chrome or Edge does not', () => {
    expect(enterKey({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true } })).toBe(false)
  })
  it('nor does the one Safari leaves behind after the composition ends', () => {
    expect(enterKey({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: false } })).toBe(false)
  })
  it('reads a DOM event as well as a React one', () => {
    expect(composing({ key: 'Enter', isComposing: true })).toBe(true)
    expect(composing({ key: 'a', keyCode: 65 })).toBe(false)
  })
})

it("scopes attachment shortcut to primary modifier and deliberate non-IME input",()=>{
 const e={key:"u",metaKey:true,ctrlKey:false};
 expect(attachmentShortcut(e,true)).toBe(true);
 expect(attachmentShortcut(e,false)).toBe(false);
 expect(attachmentShortcut({...e,metaKey:false,ctrlKey:true},false)).toBe(true);
 for(const guard of [{isComposing:true},{nativeEvent:{keyCode:229}},{altKey:true},{shiftKey:true},{repeat:true},{defaultPrevented:true}])expect(attachmentShortcut({...e,...guard},true)).toBe(false);
})

// The Enter that picks a kanji is not the Enter that sends, builds or saves.
// Every screen that compared the key itself got this wrong on its own: the
// Harness home built an app from half-converted kana, and a table cell
// closed itself on the first conversion. So nothing compares it by hand —
// `enterKey` does, or the line says it is asking about `composing(` itself.
describe('Enter is only ever read through enterKey', () => {
  it('has no hand-written Enter check in the app', () => {
    const files = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!./keys.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const bare = /\bkey\s*[!=]==?\s*['"]Enter['"]|['"]Enter['"]\s*[!=]==?\s*[\w.]*\bkey\b|case\s+['"]Enter['"]/
    const found = Object.entries(files).flatMap(([file, text]) => text.split('\n')
      .map((line, i) => ({ file, line: i + 1, text: line }))
      .filter(({ text }) => bare.test(text) && !text.includes('composing(')))
      .map(({ file, line }) => `${file}:${line}`)
    expect(Object.keys(files).length).toBeGreaterThan(100)
    expect(found).toEqual([])
  })
})
