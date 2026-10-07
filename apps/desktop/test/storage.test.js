import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The sign-in lives in the page's localStorage, which Chromium writes to disk
// lazily. Every way the app ends has to write it out first, or the next start
// asks for a sign-in again — on Windows a restart of the computer sends no
// before-quit at all, and an update relaunches without one either.
const main = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8')
const handler = (pattern) => (main.match(pattern) || [''])[0]

describe('the session survives the app ending', () => {
  it('writes localStorage out through the default session', () => {
    expect(main).toMatch(/function flushStorage\(\) \{\s*try \{ session\.defaultSession\.flushStorageData\(\) \}/)
  })
  it('on quit, on a restart or shutdown of the computer, and before an update relaunches it', () => {
    expect(handler(/app\.on\('before-quit'[^\n]*/)).toContain('flushStorage()')
    expect(handler(/win\.on\('query-session-end'[^\n]*/)).toContain('flushStorage()')
    expect(handler(/win\.on\('session-end'[^\n]*/)).toContain('flushStorage()')
    expect(handler(/powerMonitor\.on\('shutdown'[^\n]*/)).toContain('flushStorage()')
    expect(handler(/beforeRestart: \(\) => \{[^}]*\}/)).toContain('flushStorage()')
  })
  it('and whenever the window closes to the tray or loses focus', () => {
    expect(main).toMatch(/win\.on\('close', \(event\) => \{[\s\S]{0,300}flushStorage\(\)/)
    expect(main).toMatch(/win\.on\('blur', flushStorage\)/)
  })
})
