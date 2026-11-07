import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

const workspaceCss = readFileSync(new URL('./HarnessWorkspace.css', import.meta.url), 'utf8')

test('source thread and App remain visible together on narrow screens', () => {
  const narrow = [...workspaceCss.matchAll(/@media\s*\(max-width:\s*1100px\)\s*\{([\s\S]*?)\n\}/g)].map(match => match[1]).find(block => block.includes('hx-thread-app')) || ''
  expect(narrow).toMatch(/\.hx-thread-app\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/)
  expect(narrow).toMatch(/\.hx-thread-app\s*>\s*\.slk-thread-pane\s*\{[^}]*position:\s*relative/)
  expect(narrow).toMatch(/\.hx-thread-app\s*>\s*\.hx-app-pane\s*\{[^}]*position:\s*relative/)
  expect(narrow).not.toContain('z-index:36')
})

test('wide source thread layout keeps the conversation beside the App', () => {
  const wide = [...workspaceCss.matchAll(/@media\s*\(min-width:\s*1101px\)\s*\{([\s\S]*?)\n\}/g)].map(match => match[1]).find(block => block.includes('hx-thread-app')) || ''
  expect(wide).toMatch(/\.hx-thread-app\s*>\s*\.slk-thread-pane/)
  expect(wide).toMatch(/\.hx-thread-app\s*>\s*\.hx-app-pane/)
})
