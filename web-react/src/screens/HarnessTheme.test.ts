import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const harnessCss = readFileSync(new URL('./Harness.css', import.meta.url), 'utf8')
const workspaceCss = readFileSync(new URL('../components/HarnessWorkspace.css', import.meta.url), 'utf8')

test('legacy Harness surfaces follow the Harness theme without changing Simple colors', () => {
  const scope = harnessCss.match(/\.hx-screen\s*\{([^}]+)\}/)?.[1] || ''
  expect(scope).toMatch(/--signal-white:\s*var\(--hx-surface/)
  expect(scope).toMatch(/--ink-black:\s*var\(--hx-text/)
  expect(scope).toMatch(/--bone:\s*var\(--hx-border/)
  expect(scope).toMatch(/--mist:\s*var\(--hx-hover/)
  expect(scope).toMatch(/--ash:\s*var\(--hx-muted/)
  expect(harnessCss).toMatch(/\.hx-danger\s*\{\s*color:\s*var\(--hx-danger/)
  expect(workspaceCss).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--hx-surface:\s*#191a1c/)
})
