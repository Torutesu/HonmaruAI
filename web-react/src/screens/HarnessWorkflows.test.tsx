import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HarnessWorkflows } from './HarnessWorkflows'

const state = vi.hoisted(() => ({ api: null as any }))
vi.mock('./HarnessShared', async original => ({ ...(await original<any>()), useApi: () => state.api }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text, t: (text: string) => text }))
const props = { httpBase: 'https://example.test', orgId: 'one', sessionToken: 'test', onClose: () => {} }
const workflow = { id: 'wf_one', name: 'Billing', enabled: true, trigger: { type: 'webhook' }, steps: [], hookSecret: 'a'.repeat(48), hookUrl: 'https://example.test/hook?secret=old', webhookSignatureRequired: true }
const aiBudget={revision:0,action:'warn' as const,'24h':{limitUsd:0,usedUsd:0,unpricedCalls:0,resetAt:null,exhausted:false},'7d':{limitUsd:0,usedUsd:0,unpricedCalls:0,resetAt:null,exhausted:false},'30d':{limitUsd:0,usedUsd:0,unpricedCalls:0,resetAt:null,exhausted:false}}
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
test('workflow history shows elapsed time without inventing duration for unfinished runs',async()=>{
 state.api.workflow.mockResolvedValue({workflow,canEdit:true,runs:[
  {id:'done-run',status:'done',trigger:'manual',startedAt:'2026-10-24T09:00:00Z',finishedAt:'2026-10-24T09:01:10Z',log:[]},
  {id:'live-run',status:'running',trigger:'manual',startedAt:'2026-10-24T09:02:00Z',finishedAt:null,log:[]},
 ]});
 await open();
 expect(tree.root.findByProps({'data-run':'done-run'}).findAllByProps({title:'Elapsed time, including approval waits'})).toHaveLength(1);
 expect(tree.root.findByProps({'data-run':'live-run'}).findAllByProps({title:'Elapsed time, including approval waits'})).toHaveLength(0);
 expect(tree.root.findByProps({'data-run':'done-run'}).findByType('time').props.dateTime).toBe('2026-10-24T09:00:00Z');
});
test('unlimited workflow run budgets do not render a fake unlimited run total',async()=>{
 const unlimited={limit:0,used:0,resetAt:'2026-10-27T00:00:00.000Z',exhausted:false}
 state.api.workflow.mockResolvedValue({workflow:{...workflow,safety:{generation:'g',failure_streak:0,paused_at:null,pause_reason:null,daily_run_limit:0,weekly_run_limit:0,monthly_run_limit:0,budget_revision:0,budget:{revision:0,daily:unlimited,weekly:unlimited,monthly:unlimited,ai:aiBudget}}},canEdit:true,runs:[]})
 await open()
 const text=JSON.stringify(tree.toJSON())
 expect(text).toContain('No limit ({used} used)')
 expect(text).not.toContain('無制限回中')
})
test('webhook revocation requires confirmation, uses the observed secret, and displays revoked state', async () => {
  await open()
  expect(JSON.stringify(tree.toJSON())).toContain('x-webhook-signature')
  expect(JSON.stringify(tree.toJSON())).toContain('HONMARU_WEBHOOK_SECRET')
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
test('legacy webhook senders remain compatible until their credential is rotated', async () => {
  state.api.workflow.mockResolvedValue({ workflow: { ...workflow, webhookSignatureRequired: false }, runs: [], canEdit: true })
  await open()
  const text = JSON.stringify(tree.toJSON())
  expect(text).toContain('This existing webhook still accepts its URL secret alone.')
  expect(text).not.toContain('x-webhook-signature')
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
  const detail = tree.root.findByProps({className:'hx-run-detail'})
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
  await act(async () => { tree.root.findByProps({className:'hx-run-detail'}).props.onToggle({ currentTarget: { open: true } }) })
  expect(state.api.heldWorkflowEvent).toHaveBeenCalledWith(workflow.id, 'preview_one')
  expect(tree.root.findByProps({className:'hx-held-payload'}).children.join('')).toBe(JSON.stringify(input,null,2))
  expect(tree.root.findAllByType('script')).toHaveLength(0)
  await act(async () => { tree.root.findByProps({className:'hx-run-detail'}).props.onToggle({ currentTarget: { open: true } }) })
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
  await act(async () => { tree.root.findByProps({className:'hx-run-detail'}).props.onToggle({ currentTarget: { open: true } }) })
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Network unavailable')
  await act(async () => { button('Retry').props.onClick() })
  expect(state.api.heldWorkflowEvent).toHaveBeenCalledTimes(2)
  expect(tree.root.findByProps({className:'hx-held-payload'}).children.join('')).toContain('"ok": true')
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

test('requested workflow URLs open details and back navigation clears the target',async()=>{
 const navigate=vi.fn()
 await act(async()=>{tree=create(<HarnessWorkflows {...props} requestedWorkflowId={workflow.id} onNavigateWorkflow={navigate}/> )})
 expect(state.api.workflow).toHaveBeenCalledWith(workflow.id)
 expect(JSON.stringify(tree.toJSON())).toContain('Billing')
 await act(async()=>{tree.root.findByProps({'aria-label':'Back'}).props.onClick()})
 expect(navigate).toHaveBeenCalledWith()
})
test('opening a listed workflow delegates to the durable route before loading details',async()=>{
 const navigate=vi.fn()
 await act(async()=>{tree=create(<HarnessWorkflows {...props} onNavigateWorkflow={navigate}/> )})
 await act(async()=>{tree.root.findByProps({'data-workflow':workflow.id}).props.onClick()})
 expect(navigate).toHaveBeenCalledWith(workflow.id)
 expect(state.api.workflow).not.toHaveBeenCalled()
})

test('editing preserves conditions and submits the observed revision; conflicts retain the draft',async()=>{
 const editable={...workflow,updatedAt:'2026-10-25T00:00:00.000Z',steps:[{type:'post',channel:'b:ops',text:'Ready',when:{path:['input','ready'],op:'eq',value:true}}]};
 state.api.workflow.mockResolvedValue({workflow:editable,runs:[],canEdit:true});
 state.api.updateWorkflow=vi.fn().mockRejectedValue(new Error('The workflow changed.'));
 await open();
 await act(async()=>{button('Edit workflow').props.onClick()});
 await act(async()=>{tree.root.findByProps({'aria-label':'Workflow name'}).props.onChange({target:{value:'Changed'}})});
 await act(async()=>{await button('Save workflow').props.onClick()});
 expect(state.api.updateWorkflow).toHaveBeenCalledWith(workflow.id,{name:'Changed',trigger:editable.trigger,steps:editable.steps,expectedUpdatedAt:editable.updatedAt});
 expect(tree.root.findByProps({'aria-label':'Workflow name'}).props.value).toBe('Changed');
 expect(JSON.stringify(tree.toJSON())).toContain('The workflow changed.');
 await act(async()=>{button('Cancel').props.onClick()});
 expect(tree.root.findAllByProps({'aria-label':'Workflow name'})).toHaveLength(0);
});

test('weekly and monthly editors retain and save explicit calendar choices',async()=>{
 const editable={...workflow,updatedAt:'2026-10-25T00:00:00Z',trigger:{type:'schedule',cadence:'weekly',weekday:5,hour:9,minute:30,timezone:'Asia/Tokyo'},steps:[{type:'post',channel:'b:ops',text:'Report'}]};
 state.api.workflow.mockResolvedValue({workflow:editable,runs:[],canEdit:true});
 state.api.updateWorkflow=vi.fn().mockResolvedValue({workflow:editable});
 await open();
 await act(async()=>{button('Edit workflow').props.onClick()});
 expect(tree.root.findByProps({'aria-label':'Weekday'}).props.value).toBe(5);
 await act(async()=>{tree.root.findByProps({'aria-label':'Weekday'}).props.onChange({target:{value:'0'}})});
 await act(async()=>{await button('Save workflow').props.onClick()});
 expect(state.api.updateWorkflow.mock.calls[0][1].trigger).toMatchObject({weekday:0,timezone:'Asia/Tokyo',hour:9,minute:30});
 await act(async()=>{button('Edit workflow').props.onClick()});
 await act(async()=>{tree.root.findByProps({'aria-label':'Cadence'}).props.onChange({target:{value:'monthly'}})});
 await act(async()=>{tree.root.findByProps({'aria-label':'Day of month'}).props.onChange({target:{value:'31'}})});
 await act(async()=>{await button('Save workflow').props.onClick()});
 expect(state.api.updateWorkflow.mock.calls[1][1].trigger).toMatchObject({cadence:'monthly',monthday:31,timezone:'Asia/Tokyo'});
});

test('invalid schedule time zones keep the draft unsavable until corrected',async()=>{
 const editable={...workflow,updatedAt:'2026-10-25T00:00:00Z',trigger:{type:'schedule',cadence:'daily',hour:9,minute:0,timezone:'Asia/Tokyo'},steps:[{type:'post',channel:'b:ops',text:'Report'}]};
 state.api.workflow.mockResolvedValue({workflow:editable,runs:[],canEdit:true});
 await open();
 await act(async()=>{button('Edit workflow').props.onClick()});
 await act(async()=>{tree.root.findByProps({'aria-label':'Time zone'}).props.onChange({target:{value:'Wrong/Zone'}})});
 expect(button('Save workflow').props.disabled).toBe(true);
 expect(JSON.stringify(tree.toJSON())).toContain('Enter a valid time and time zone.');
 await act(async()=>{tree.root.findByProps({'aria-label':'Time zone'}).props.onChange({target:{value:'UTC'}})});
 expect(button('Save workflow').props.disabled).toBe(false);
});

test('program and form drafts survive format switches and save whole source',async()=>{
 const editable={...workflow,updatedAt:'2026-10-25T00:00:00.000Z',steps:[{type:'post',channel:'b:ops',text:'Keep this form'}]};
 state.api.workflow.mockResolvedValue({workflow:editable,runs:[],canEdit:true});
 state.api.gateways=vi.fn().mockResolvedValue({gateways:[{id:'mini',name:'Mac mini',revokedAt:null}]});
 state.api.updateWorkflow=vi.fn().mockRejectedValue(new Error('Conflict'));
 await open();await act(async()=>{button('Edit workflow').props.onClick()});
 const format=(value:string)=>tree.root.findByProps({'aria-label':'Workflow format'}).props.onChange({target:{value}});
 await act(async()=>{format('code')});
 expect(button('Save workflow').props.disabled).toBe(true);
 const code="import {state} from '@honmaru/workflow-sdk';\nawait state.get();\nconsole.log('<safe>');";
 await act(async()=>{tree.root.findByProps({'aria-label':'TypeScript source'}).props.onChange({target:{value:code}})});
 await act(async()=>{tree.root.findByProps({'aria-label':'Execution node'}).props.onChange({target:{value:'mini'}})});
 await act(async()=>{format('form')});
 expect(tree.root.findByProps({'aria-label':'Text'}).props.value).toBe('Keep this form');
 await act(async()=>{format('code')});
 expect(tree.root.findByProps({'aria-label':'TypeScript source'}).props.value).toBe(code);
 expect(tree.root.findByProps({'aria-label':'Execution node'}).props.value).toBe('mini');
 await act(async()=>{await button('Save workflow').props.onClick()});
 expect(state.api.updateWorkflow).toHaveBeenCalledWith(workflow.id,expect.objectContaining({steps:[{type:'code',code,gatewayId:'mini'}]}));
 expect(tree.root.findByProps({'aria-label':'TypeScript source'}).props.value).toBe(code);
 await act(async()=>{tree.root.findByProps({'aria-label':'TypeScript source'}).props.onChange({target:{value:'あ'.repeat(16001)}})});
 expect(button('Save workflow').props.disabled).toBe(true);
});

test('running workflow details refresh automatically and stop polling after completion',async()=>{
 vi.useFakeTimers();
 try{
  const live={id:'program-live',status:'running',trigger:'manual',startedAt:'2026-10-25T00:00:00Z',log:[]};
  state.api.workflow.mockResolvedValueOnce({workflow,runs:[live],canEdit:true}).mockResolvedValue({workflow,runs:[{...live,status:'done',finishedAt:'2026-10-25T00:00:01Z',log:[{step:1,type:'code',status:'done',output:'Finished program',at:'2026-10-25T00:00:01Z'}]}],canEdit:true});
  await open();expect(state.api.workflow).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});
  expect(JSON.stringify(tree.toJSON())).toContain('Finished program');
  await act(async()=>{await vi.advanceTimersByTimeAsync(20000)});
  expect(state.api.workflow).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers()}
});
test('refresh failure clears stale run details and reports the error',async()=>{
 vi.useFakeTimers();
 try{
  state.api.workflow.mockResolvedValueOnce({workflow,runs:[{id:'private-run',status:'running',trigger:'manual',startedAt:'2026-10-25T00:00:00Z',log:[]}],canEdit:true}).mockRejectedValue(new Error('Workflow access removed'));
  await open();await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});
  expect(tree.root.findAllByProps({'data-run':'private-run'})).toHaveLength(0);
  expect(tree.root.findAllByProps({'data-workflow':workflow.id})).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('Workflow access removed');
 }finally{vi.useRealTimers()}
});

test('manual setup focuses the builder instead of stacking the generation form above it',async()=>{
 await act(async()=>{tree=create(<HarnessWorkflows {...props}/>)});
 await act(async()=>{button('Set up an automation').props.onClick()});
 expect(tree.root.findAllByProps({className:'hx-generation'})).toHaveLength(1);
 await act(async()=>{button('Manual setup').props.onClick()});
 expect(tree.root.findAllByProps({className:'hx-generation'})).toHaveLength(0);
 expect(tree.root.findAllByProps({className:'hx-builder'})).toHaveLength(1);
});
test('workflow detail edits UTC run limits and displays usage with the saved revision',async()=>{
 const detailed={...workflow,safety:{generation:'g1',failure_streak:0,paused_at:null,pause_reason:null,daily_run_limit:3,weekly_run_limit:0,monthly_run_limit:0,budget_revision:4,budget:{revision:4,daily:{limit:3,used:1,resetAt:'2026-10-27T00:00:00Z',exhausted:false},weekly:{limit:0,used:2,resetAt:'2026-11-02T00:00:00Z',exhausted:false},monthly:{limit:0,used:2,resetAt:'2026-11-01T00:00:00Z',exhausted:false},ai:{...aiBudget,revision:4,'24h':{limitUsd:2,usedUsd:0.25,unpricedCalls:0,resetAt:null,exhausted:false}}}}}
 state.api.workflow.mockResolvedValue({workflow:detailed,runs:[],canEdit:true})
 state.api.updateWorkflowBudget=vi.fn().mockResolvedValue({budget:detailed.safety.budget,safety:detailed.safety})
 await open()
 const budgetInputs=tree.root.findAllByProps({'aria-label':'{period} run limit'})
 expect(budgetInputs).toHaveLength(3)
 const daily=budgetInputs[0]
 expect(daily.props.value).toBe('3')
 expect(JSON.stringify(tree.toJSON())).toContain('{used} of {limit} runs')
 await act(async()=>daily.props.onChange({target:{value:'5'}}))
 await act(async()=>{await button('Save budget settings').props.onClick()})
 expect(state.api.updateWorkflowBudget).toHaveBeenCalledWith(workflow.id,{revision:4,dailyLimit:5,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:2,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'warn'})
})
