import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HarnessWorkflows } from './HarnessWorkflows'

const state = vi.hoisted(() => ({ api: null as any }))
vi.mock('./HarnessShared', async original => ({ ...(await original<any>()), useApi: () => state.api }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
const props = { httpBase: 'https://example.test', orgId: 'one', sessionToken: 'test', onClose: () => {} }
const workflow = { id: 'wf_one', name: 'Billing', enabled: true, trigger: { type: 'webhook' }, steps: [], hookSecret: 'a'.repeat(48), hookUrl: 'https://example.test/hook?secret=old' }
let tree: ReturnType<typeof create>
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agents: [] }) }))
  state.api = {
    workflows: vi.fn().mockResolvedValue({ workflows: [workflow] }), tables: vi.fn().mockResolvedValue({ tables: [] }),
    workflow: vi.fn().mockResolvedValue({ workflow, runs: [], canEdit: true }),
    changeWorkflowHook: vi.fn().mockResolvedValue({ workflow: { ...workflow, hookSecret: undefined, hookUrl: undefined } }),
  }
})
afterEach(() => { if (tree) act(() => tree.unmount()); vi.unstubAllGlobals() })
const button = (label: string) => tree.root.findAllByType('button').find(b => b.children.includes(label))!
async function open() {
  await act(async () => { tree = create(<HarnessWorkflows {...props} />) })
  await act(async () => { tree.root.findByProps({ 'data-workflow': workflow.id }).props.onClick() })
}
test('webhook revocation requires confirmation, uses the observed secret, and displays revoked state', async () => {
  await open()
  await act(async () => { button('Revoke webhook').props.onClick() })
  expect(state.api.changeWorkflowHook).not.toHaveBeenCalled()
  expect(JSON.stringify(tree.toJSON())).toContain('Existing runs are not cancelled.')
  await act(async () => { button('Cancel').props.onClick() })
  expect(state.api.changeWorkflowHook).not.toHaveBeenCalled()
  await act(async () => { button('Revoke webhook').props.onClick() })
  await act(async () => { await button('Revoke webhook').props.onClick() })
  expect(state.api.changeWorkflowHook).toHaveBeenCalledWith(workflow.id, 'revoke', workflow.hookSecret)
  expect(JSON.stringify(tree.toJSON())).toContain('This webhook is revoked.')
  expect(JSON.stringify(tree.toJSON())).not.toContain(workflow.hookUrl)
  state.api.changeWorkflowHook.mockResolvedValue({ workflow: { ...workflow, hookSecret: 'b'.repeat(48), hookUrl: 'https://example.test/hook?secret=new' } })
  await act(async () => { button('Generate new webhook URL').props.onClick() })
  await act(async () => { await button('Generate new webhook URL').props.onClick() })
  expect(state.api.changeWorkflowHook).toHaveBeenLastCalledWith(workflow.id, 'rotate', null)
  expect(JSON.stringify(tree.toJSON())).toContain('https://example.test/hook?secret=new')
})
test('a conflict retains the current display and reports the failure instead of pretending to rotate', async () => {
  state.api.changeWorkflowHook.mockRejectedValue(new Error('The webhook changed. Reload the workflow and try again.'))
  await open()
  await act(async () => { button('Generate new webhook URL').props.onClick() })
  await act(async () => { await button('Generate new webhook URL').props.onClick() })
  expect(JSON.stringify(tree.toJSON())).toContain('The webhook changed.')
  expect(JSON.stringify(tree.toJSON())).toContain(workflow.hookUrl)
})
test('read-only viewers have no credential management controls', async () => {
  state.api.workflow.mockResolvedValue({ workflow: { ...workflow, hookSecret: undefined, hookUrl: undefined }, runs: [], canEdit: false })
  await open()
  expect(button('Generate new webhook URL')).toBeUndefined()
  expect(button('Revoke webhook')).toBeUndefined()
  expect(JSON.stringify(tree.toJSON())).not.toContain(workflow.hookUrl)
})
