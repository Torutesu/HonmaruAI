import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { PublicSkillShare } from './PublicSkillShare'

afterEach(() => { vi.unstubAllGlobals() })

function browserGlobals(hash = '') {
  const robots = { name: '', content: '', remove: vi.fn() }
  vi.stubGlobal('document', { createElement: () => robots, head: { appendChild: vi.fn() } })
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('location', { hash })
}

test('public Skill links preview and download without a signed-in API session, and route import through account auth', async () => {
  const token = `skl_${'ab'.repeat(32)}`
  let tree!: ReturnType<typeof create>
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ share: {
    name: 'Onboarding steps', description: 'A reusable checklist.', fileCount: 2, totalBytes: 640,
    expiresAt: '2026-11-07T00:00:00Z',
  } }) }))
  browserGlobals()
  vi.stubGlobal('fetch', fetch)
  try {
    await act(async () => { tree = create(<PublicSkillShare httpBase="https://api.example" token={token} />) })
    expect(JSON.stringify(tree.toJSON())).toContain('Onboarding steps')
    expect(fetch).toHaveBeenCalledWith(`https://api.example/skill-shares/${token}`, expect.objectContaining({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }))
    const links = tree.root.findAllByType('a')
    expect(links.find(link => link.children.includes('ZIPをダウンロード'))!.props.href).toBe(`https://api.example/skill-shares/${token}/download`)
    expect(links.find(link => link.children.includes('Honmaruに非公開コピーを取り込む'))!.props.href).toBe(`#/skill-share/${token}/import`)
  } finally { act(() => tree?.unmount()) }
})

test('expired or revoked public Skill links show unavailable state', async () => {
  let tree!: ReturnType<typeof create>
  browserGlobals()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
  try {
    await act(async () => { tree = create(<PublicSkillShare httpBase="https://api.example" token={`skl_${'cd'.repeat(32)}`} />) })
    expect(JSON.stringify(tree.toJSON())).toContain('この共有リンクは利用できません')
  } finally { act(() => tree?.unmount()) }
})

test('a stalled public preview switches from loading to retry after its timeout', async () => {
  let tree!: ReturnType<typeof create>
  vi.useFakeTimers()
  browserGlobals()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  try {
    await act(async () => { tree = create(<PublicSkillShare httpBase="https://api.example" token={`skl_${'ef'.repeat(32)}`} />) })
    expect(JSON.stringify(tree.toJSON())).toContain('共有されたSkillを読み込んでいます')
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(JSON.stringify(tree.toJSON())).toContain('Skillを読み込めませんでした')
    expect(tree.root.findAllByType('button').some(button => button.children.includes('再試行'))).toBe(true)
  } finally {
    act(() => tree?.unmount())
    vi.useRealTimers()
  }
})
