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
    workflowNotices: vi.fn().mockResolvedValue({items:[]}),
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
test('held events are replayed only after confirmation using the reviewed IDs', async () => {
  const held = { count: 1, oldestExpiry: '2026-10-30T00:00:00Z', events: [{ id: 'held_one', receivedAt: '2026-10-23T00:00:00Z', expiresAt: '2026-10-30T00:00:00Z' }] }
  state.api.workflow.mockResolvedValue({ workflow, runs: [], canEdit: true, held })
  state.api.replayWorkflowEvents = vi.fn().mockResolvedValue({ runs: [{ eventId: 'held_one', runId: 'run_one', status: 'done' }], skipped: 0 })
  await open()
  expect(state.api.replayWorkflowEvents).not.toHaveBeenCalled()
  await act(async () => { button('Review held events').props.onClick() })
  expect(state.api.replayWorkflowEvents).not.toHaveBeenCalled()
  await act(async () => { button('Cancel').props.onClick() })
  expect(state.api.replayWorkflowEvents).not.toHaveBeenCalled()
  await act(async () => { button('Review held events').props.onClick() })
  state.api.workflow.mockResolvedValue({ workflow, runs: [], canEdit: true, held: { count: 0, oldestExpiry: null, events: [] } })
  await act(async () => { await button('Replay {count} events').props.onClick() })
  expect(state.api.replayWorkflowEvents).toHaveBeenCalledWith(workflow.id, ['held_one'])
  expect(button('Review held events')).toBeUndefined()
})
test('held event replay remains disabled while the workflow is paused', async () => {
  state.api.workflow.mockResolvedValue({ workflow: { ...workflow, enabled: false }, runs: [], canEdit: true,
    held: { count: 1, oldestExpiry: null, events: [{ id: 'held_one', receivedAt: '2026-10-23T00:00:00Z' }] } })
  await open()
  expect(button('Review held events').props.disabled).toBe(true)
})
test('paused workflows expose explicit manual run without resuming or replaying', async () => {
  state.api.workflow.mockResolvedValue({ workflow: { ...workflow, enabled: false }, runs: [], canEdit: true })
  state.api.runWorkflow = vi.fn().mockResolvedValue({ run: { id: 'manual_one' } })
  state.api.updateWorkflow = vi.fn()
  state.api.replayWorkflowEvents = vi.fn()
  await open()
  const run = button('Run now')
  expect(run.props.disabled).toBe(false)
  expect(state.api.runWorkflow).not.toHaveBeenCalled()
  await act(async () => { await run.props.onClick() })
  expect(state.api.runWorkflow).toHaveBeenCalledWith(workflow.id, '')
  expect(state.api.updateWorkflow).not.toHaveBeenCalled()
  expect(state.api.replayWorkflowEvents).not.toHaveBeenCalled()
  expect(JSON.stringify(tree.toJSON())).toContain('Automatic triggers are paused.')
})
test('discard requires confirmation and sends the displayed snapshot rather than deleting all arrivals', async () => {
  state.api.workflow.mockResolvedValue({ workflow: { ...workflow, enabled: false }, runs: [], canEdit: true,
    held: { count: 1, oldestExpiry: null, events: [{ id: 'reviewed', receivedAt: '2026-10-23T00:00:00Z' }], discardEventIds: ['reviewed'] } })
  state.api.discardWorkflowEvents = vi.fn().mockResolvedValue({ discarded: 1 })
  await open()
  await act(async () => { button('Discard held events').props.onClick() })
  expect(state.api.discardWorkflowEvents).not.toHaveBeenCalled()
  expect(JSON.stringify(tree.toJSON())).toContain('permanently discarded')
  await act(async () => { button('Cancel').props.onClick() })
  expect(state.api.discardWorkflowEvents).not.toHaveBeenCalled()
  await act(async () => { button('Discard held events').props.onClick() })
  state.api.workflow.mockResolvedValue({ workflow, runs: [], canEdit: true, held: { count: 0, events: [], discardEventIds: [] } })
  await act(async () => { await button('Discard {count} events').props.onClick() })
  expect(state.api.discardWorkflowEvents).toHaveBeenCalledWith(workflow.id, ['reviewed'])
  expect(button('Discard held events')).toBeUndefined()
})
test.each(['orgId', 'sessionToken', 'httpBase'] as const)('changing %s clears credentials and pending confirmation', async field => {
  await open()
  await act(async () => { button('Revoke webhook').props.onClick() })
  const previous = state.api
  state.api = { ...previous, workflows: vi.fn().mockResolvedValue({ workflows: [] }) }
  await act(async () => { tree.update(<HarnessWorkflows {...props} {...{ [field]: 'next-scope' }} />) })
  expect(JSON.stringify(tree.toJSON())).not.toContain(workflow.hookUrl)
  expect(button('Revoke webhook')).toBeUndefined()
  expect(previous.changeWorkflowHook).not.toHaveBeenCalled()
})
test('a late detail response from the previous account cannot reopen its secret in the current account', async () => {
  let finish!: (value: any) => void
  state.api.workflow.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await act(async () => { tree = create(<HarnessWorkflows {...props} />) })
  await act(async () => { tree.root.findByProps({ 'data-workflow': workflow.id }).props.onClick() })
  state.api = { ...state.api, workflows: vi.fn().mockResolvedValue({ workflows: [] }) }
  await act(async () => { tree.update(<HarnessWorkflows {...props} sessionToken="next-account" />) })
  await act(async () => { finish({ workflow, runs: [], canEdit: true }) })
  expect(JSON.stringify(tree.toJSON())).not.toContain(workflow.hookUrl)
  expect(button('Revoke webhook')).toBeUndefined()
})
test.each(['resolve', 'reject'] as const)('an older detail request cannot replace the latest selection when it %ss late', async outcome => {
  const second = { ...workflow, id: 'wf_two', name: 'Current selection', hookUrl: 'https://example.test/current' }
  state.api.workflows.mockResolvedValue({ workflows: [workflow, second] })
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  state.api.workflow.mockImplementation((id: string) => id === workflow.id
    ? new Promise((yes, no) => { resolve = yes; reject = no })
    : Promise.resolve({ workflow: second, runs: [], canEdit: true }))
  await act(async () => { tree = create(<HarnessWorkflows {...props} />) })
  await act(async () => { tree.root.findByProps({ 'data-workflow': workflow.id }).props.onClick() })
  await act(async () => { await tree.root.findByProps({ 'data-workflow': second.id }).props.onClick() })
  await act(async () => {
    if (outcome === 'resolve') resolve({ workflow, runs: [], canEdit: true })
    else reject(new Error('Stale detail failure'))
  })
  expect(JSON.stringify(tree.toJSON())).toContain(second.hookUrl)
  expect(JSON.stringify(tree.toJSON())).not.toContain(workflow.hookUrl)
  expect(JSON.stringify(tree.toJSON())).not.toContain('Stale detail failure')
})
test('finishing a manual run after returning to the list does not reopen its detail', async () => {
  let finish!: (value: any) => void
  state.api.runWorkflow = vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve }))
  await open()
  await act(async () => { button('Run now').props.onClick() })
  await act(async () => { tree.root.findByProps({ 'aria-label': 'Back' }).props.onClick() })
  await act(async () => { finish({ run: { id: 'finished' } }) })
  expect(tree.root.findAllByProps({ 'data-workflow': workflow.id })).toHaveLength(1)
  expect(JSON.stringify(tree.toJSON())).not.toContain(workflow.hookUrl)
})
test('run history preserves complete multiline output and errors as text in collapsed details', async () => {
  const output = 'Long result '.repeat(40) + '\n<script>untrusted()</script>\nFinal evidence'
  const error = 'Provider failure '.repeat(30) + '\nFailure details'
  state.api.workflow.mockResolvedValue({ workflow, canEdit: true, runs: [{ id: 'run_full', status: 'failed', trigger: 'manual', startedAt: '2026-10-23T00:00:00Z',
    log: [{ step: 1, type: 'agent', status: 'failed', at: '2026-10-23T00:01:00Z', output, error }, { step: 2, type: 'post', status: 'skipped', at: '2026-10-23T00:01:01Z' }] }] })
  await open()
  const detail = tree.root.findByType('details')
  expect(detail.props.open).toBeUndefined()
  expect(detail.findAllByType('pre').map(node => node.children.join(''))).toEqual([output, error])
  expect(detail.findByType('summary').children.join('')).not.toContain('Failure details')
  expect(tree.root.findAllByType('script')).toHaveLength(0)
  expect(detail.findByType('time').props.dateTime).toBe('2026-10-23T00:01:00Z')
})
test('refresh updates run results and held counts without starting work or keeping stale confirmations', async () => {
  await open()
  await act(async () => { button('Revoke webhook').props.onClick() })
  state.api.runWorkflow = vi.fn()
  state.api.replayWorkflowEvents = vi.fn()
  state.api.workflow.mockResolvedValue({ workflow, canEdit: true,
    runs: [{ id: 'run_new', status: 'done', trigger: 'manual', startedAt: '2026-10-23T00:00:00Z', log: [] }],
    held: { count: 1, oldestExpiry: null, events: [{ id: 'new_event', receivedAt: '2026-10-23T00:00:00Z' }], discardEventIds: ['new_event'] } })
  await act(async () => { await button('Refresh').props.onClick() })
  expect(tree.root.findAllByProps({ 'data-run': 'run_new' })).toHaveLength(1)
  expect(button('Review held events')).toBeDefined()
  expect(button('Cancel')).toBeUndefined()
  expect(state.api.changeWorkflowHook).not.toHaveBeenCalled()
  expect(state.api.runWorkflow).not.toHaveBeenCalled()
  expect(state.api.replayWorkflowEvents).not.toHaveBeenCalled()
})
test('held payload is fetched only when expanded and remains inert text', async () => {
  state.api.workflow.mockResolvedValue({ workflow, runs: [], canEdit: true,
    held: { count: 1, oldestExpiry: null, events: [{ id: 'preview_one', receivedAt: '2026-10-23T00:00:00Z' }], discardEventIds: ['preview_one'] } })
  const input = { text: '<script>untrusted()</script>', amount: 12 }
  state.api.heldWorkflowEvent = vi.fn().mockResolvedValue({ event: { input } })
  await open()
  await act(async () => { button('Review held events').props.onClick() })
  expect(state.api.heldWorkflowEvent).not.toHaveBeenCalled()
  await act(async () => { tree.root.findByType('details').props.onToggle({ currentTarget: { open: true } }) })
  expect(state.api.heldWorkflowEvent).toHaveBeenCalledWith(workflow.id, 'preview_one')
  expect(tree.root.findByType('pre').children.join('')).toBe(JSON.stringify(input,null,2))
  expect(tree.root.findAllByType('script')).toHaveLength(0)
  await act(async () => { tree.root.findByType('details').props.onToggle({ currentTarget: { open: true } }) })
  expect(state.api.heldWorkflowEvent).toHaveBeenCalledTimes(1)
})
test('workflow deletion requires confirmation and cancellation preserves the workflow', async () => {
  state.api.deleteWorkflow = vi.fn().mockResolvedValue({ deleted: true })
  await open()
  await act(async () => { button('Delete').props.onClick() })
  expect(state.api.deleteWorkflow).not.toHaveBeenCalled()
  expect(JSON.stringify(tree.toJSON())).toContain('This cannot be undone.')
  await act(async () => { button('Cancel').props.onClick() })
  expect(state.api.deleteWorkflow).not.toHaveBeenCalled()
  expect(button('Delete workflow')).toBeUndefined()
  await act(async () => { button('Delete').props.onClick() })
  state.api.workflows.mockResolvedValue({ workflows: [] })
  await act(async () => { await button('Delete workflow').props.onClick() })
  expect(state.api.deleteWorkflow).toHaveBeenCalledWith(workflow.id)
  expect(tree.root.findAllByProps({ 'data-workflow': workflow.id })).toHaveLength(0)
})

test('failed held-payload inspection can retry without replaying the event', async () => {
  state.api.workflow.mockResolvedValue({ workflow, runs: [], canEdit: true,
    held: { count: 1, oldestExpiry: null, events: [{ id: 'retry_one', receivedAt: '2026-10-23T00:00:00Z' }] } })
  state.api.heldWorkflowEvent = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue({ event: { input: { ok: true } } })
  state.api.replayWorkflowEvents = vi.fn()
  await open()
  await act(async () => { button('Review held events').props.onClick() })
  await act(async () => { tree.root.findByType('details').props.onToggle({ currentTarget: { open: true } }) })
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Network unavailable')
  await act(async () => { button('Retry').props.onClick() })
  expect(state.api.heldWorkflowEvent).toHaveBeenCalledTimes(2)
  expect(tree.root.findByType('pre').children.join('')).toContain('"ok": true')
  expect(tree.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  expect(state.api.replayWorkflowEvents).not.toHaveBeenCalled()
})

test('failure pause blocks manual execution and replays, and resumes using the observed generation',async()=>{
 const paused={...workflow,safety:{generation:'observed',failure_streak:3,paused_at:'2026-10-24T00:00:00Z',pause_reason:'consecutive_failures'}}
 state.api.workflow.mockResolvedValueOnce({workflow:paused,runs:[],canEdit:true}).mockResolvedValue({workflow:{...paused,safety:{...paused.safety,generation:'new',failure_streak:0,paused_at:null}},runs:[],canEdit:true})
 state.api.resumeWorkflow=vi.fn().mockResolvedValue({})
 await open()
 expect(button('Run now').props.disabled).toBe(true)
 expect(JSON.stringify(tree.toJSON())).toContain('Paused after three consecutive failures')
 await act(async()=>button('Resume after review').props.onClick())
 expect(state.api.resumeWorkflow).toHaveBeenCalledWith(workflow.id,'observed')
 expect(button('Run now').props.disabled).toBe(false)
 expect(button('Resume after review')).toBeUndefined()
})
test('a failed resume keeps the pause visible and read-only members cannot resume',async()=>{
 const paused={...workflow,safety:{generation:'observed',failure_streak:3,paused_at:'now',pause_reason:'consecutive_failures'}}
 state.api.workflow.mockResolvedValue({workflow:paused,runs:[],canEdit:true})
 state.api.resumeWorkflow=vi.fn().mockRejectedValue(new Error('State changed'))
 await open()
 await act(async()=>button('Resume after review').props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('State changed')
 expect(button('Run now').props.disabled).toBe(true)
 state.api.workflow.mockResolvedValue({workflow:paused,runs:[],canEdit:false})
 await act(async()=>button('Refresh').props.onClick())
 expect(button('Resume after review')).toBeUndefined()
})
