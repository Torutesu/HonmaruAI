import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a Skill share URL opens its public preview before account sign-in', async () => {
  const token = `skl_${'ab'.repeat(32)}`
  const robots = { name: '', content: '', remove: vi.fn() }
  vi.stubGlobal('location', { hash: `#/skill-share/${token}` })
  vi.stubGlobal('document', { createElement: () => robots, head: { appendChild: vi.fn() } })
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ share: {
    name: 'Public checklist', description: 'Steps to follow.', fileCount: 1, totalBytes: 120,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  } }) })))
  let tree!: ReturnType<typeof create>
  try {
    await act(async () => { tree = create(<App />) })
    expect(JSON.stringify(tree.toJSON())).toContain('Public checklist')
    expect(JSON.stringify(tree.toJSON())).not.toContain('おかえりなさい')
  } finally { act(() => tree?.unmount()) }
})
