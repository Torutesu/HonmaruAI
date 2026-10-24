import React from 'react'
import {act, create} from 'react-test-renderer'
import {afterEach, expect, test, vi} from 'vitest'
import {AgentRunStatus} from './AgentRunStatus'
import type {ChannelMessage} from '../types/card'
vi.mock('../utils/i18n', () => ({useT: () => (text: string) => text}))
const api = {httpBase: 'https://api.example', orgId: 'org', sessionToken: 'one'}
const message = (id: string) => ({id, kind: 'message', body: `Request ${id}`} as ChannelMessage)
const ok = (status: string, rowId = 'one') => ({ok: true, json: async () => ({available: true, results: [{rowId, status, answered: 0}]})})
function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {addEventListener: vi.fn(), removeEventListener: vi.fn()})
  vi.stubGlobal('document', {visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn()})
}
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals()})
test('polls active work in one batch and stops on terminal state without implying task success', async () => {
  setup()
  const fetch = vi.fn().mockResolvedValueOnce(ok('running')).mockResolvedValue(ok('finished'))
  vi.stubGlobal('fetch', fetch)
  let tree!: ReturnType<typeof create>
  await act(async () => {tree = create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/> )})
  expect(JSON.stringify(tree.toJSON())).toContain('Agent execution running')
  await act(async () => {await vi.advanceTimersByTimeAsync(5000)})
  expect(JSON.stringify(tree.toJSON())).toContain('Agent processing ended')
  await act(async () => {await vi.advanceTimersByTimeAsync(30000)})
  expect(fetch).toHaveBeenCalledTimes(2)
  act(() => tree.unmount())
})
test('legacy unknown stops after three reads and empty lists make no request', async () => {
  setup(); const fetch = vi.fn().mockResolvedValue(ok('unknown')); vi.stubGlobal('fetch', fetch)
  let tree!: ReturnType<typeof create>
  await act(async () => {tree = create(<AgentRunStatus api={api} channel="b:general" messages={[]}/>)})
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => tree.update(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>))
  await act(async () => {await vi.advanceTimersByTimeAsync(60000)})
  expect(fetch).toHaveBeenCalledTimes(3); expect(tree.toJSON()).toBeNull()
  act(() => tree.unmount())
})
test('switching conversation hides old state immediately and ignores late responses', async () => {
  setup(); let resolve!: (result: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(r => {resolve = r})).mockResolvedValue(ok('interrupted', 'two'))
  vi.stubGlobal('fetch', fetch); let tree!: ReturnType<typeof create>
  await act(async () => {tree = create(<AgentRunStatus api={api} channel="b:one" messages={[message('one')]}/>)})
  await act(async () => tree.update(<AgentRunStatus api={{...api, sessionToken: 'two'}} channel="b:two" messages={[message('two')]}/>))
  await act(async () => resolve(ok('running')))
  expect(JSON.stringify(tree.toJSON())).toContain('Agent execution interrupted')
  expect(JSON.stringify(tree.toJSON())).not.toContain('Request one')
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  act(() => tree.unmount())
})
test('a failed refresh clears obsolete running state and bounds request IDs', async () => {
  setup()
  const fetch = vi.fn().mockResolvedValueOnce(ok('running', '24')).mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', fetch); let tree!: ReturnType<typeof create>
  await act(async () => {tree = create(<AgentRunStatus api={api} channel="b:general" messages={Array.from({length: 25}, (_, i) => message(String(i)))}/>)})
  expect(new URL(fetch.mock.calls[0][0]).searchParams.getAll('messageId')).toHaveLength(20)
  await act(async () => {await vi.advanceTimersByTimeAsync(5000)})
  expect(JSON.stringify(tree.toJSON())).toContain('Agent execution status unavailable')
  expect(JSON.stringify(tree.toJSON())).not.toContain('Agent execution running')
  act(() => tree.unmount())
})

test('pending queue acknowledgement keeps polling beyond the legacy unknown retry limit',async()=>{
  setup();let calls=0;
  const fetch=vi.fn().mockImplementation(async()=>ok(++calls<5?'pending_delivery':'finished'));vi.stubGlobal('fetch',fetch);
  let tree!:ReturnType<typeof create>;
  await act(async()=>{tree=create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)});
  expect(JSON.stringify(tree.toJSON())).toContain('Agent queue acknowledgement pending');
  await act(async()=>{await vi.advanceTimersByTimeAsync(20000)});
  expect(calls).toBe(5);expect(JSON.stringify(tree.toJSON())).toContain('Agent processing ended');
  act(()=>tree.unmount());
});
