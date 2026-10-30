import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HarnessRoomResources } from './HarnessRoomResources'

const state = vi.hoisted(() => ({ api: null as any }))
vi.mock('../utils/harness', () => ({ harnessApi: () => state.api }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))

let tree: ReturnType<typeof create>
beforeEach(() => {
  state.api = {
    apps: vi.fn().mockResolvedValue({ apps: [{ id: 'app-ops', tableId: 'table-ops' }] }),
    workflows: vi.fn().mockResolvedValue({ workflows: [
      { id: 'from-room', name: 'Room source', sourceChannel: 'b:ops', steps: [], trigger: { type: 'manual' }, enabled: false },
      { id: 'elsewhere', name: 'Other room', sourceChannel: 'b:sales', steps: [], trigger: { type: 'manual' }, enabled: false },
      { id: 'posts-here', name: 'Posts here', steps: [{ type: 'post', channel: 'b:ops' }], trigger: { type: 'schedule' }, enabled: true },
      { id: 'app-trigger', name: 'App record trigger', steps: [], trigger: { type: 'app_record_change', appId: 'app-ops' }, enabled: false },
    ] }),
  }
})
afterEach(() => { if (tree) act(() => tree.unmount()) })

test('room automations include source-room workflows and omit workflows sourced elsewhere', async () => {
  await act(async () => {
    tree = create(<HarnessRoomResources api={{ httpBase: 'https://example.test', orgId: 'one', sessionToken: 'test' }} channel="b:ops" kind="workflows" onClose={() => {}} onCreate={() => {}} onLegacy={() => {}} />)
  })
  const rendered = JSON.stringify(tree.toJSON())
  expect(rendered).toContain('Room source')
  expect(rendered).toContain('Posts here')
  expect(rendered).toContain('App record trigger')
  expect(rendered).not.toContain('Other room')
})
