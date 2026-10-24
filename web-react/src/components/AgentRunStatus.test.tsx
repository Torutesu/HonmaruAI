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

test('a delegated target keeps polling after the source ended and shows the handoff chain',async()=>{
 setup();let reads=0;
 const face=(id:string)=>({id,name:id,handle:id});
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>({ok:true,json:async()=>({available:true,results:[{rowId:'one',status:'finished',answered:0,assignments:[{id:'assignment',generation:1,status:++reads<3?'running':'finished',agent:face('Reviewer'),hops:[{id:'hop',from:face('Researcher'),to:face('Reviewer'),at:'2026-10-24T00:00:00Z'}]}]}]})})));
 let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)});
 expect(JSON.stringify(tree.toJSON())).toContain('Researcher');expect(JSON.stringify(tree.toJSON())).toContain('Reviewer');expect(JSON.stringify(tree.toJSON())).toContain('Agent execution running');
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000)});
 expect(reads).toBe(3);expect(JSON.stringify(tree.toJSON())).toContain('Agent processing ended');
 await act(async()=>{await vi.advanceTimersByTimeAsync(20000)});expect(reads).toBe(3);
 act(()=>tree.unmount());
});

test('durable assignment metadata remains visible when the old source job has no result',async()=>{
 setup();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({available:true,results:[{rowId:'one',status:'unknown',answered:0,assignments:[{id:'assignment',generation:0,status:'running',canStop:false,agent:{id:'agent',name:'Researcher',handle:'research'},hops:[]}]}]})}));
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)});
 expect(JSON.stringify(tree.toJSON())).toContain('Researcher');expect(JSON.stringify(tree.toJSON())).toContain('Agent execution running');expect(tree.root.findAllByType('button')).toHaveLength(0);
 act(()=>tree.unmount());
});

test('uses agent identity images and emoji in assignments and handoff history', async () => {
 setup()
 const from = {id: 'research', name: 'Researcher', handle: 'research', emoji: '🔎'}
 const to = {id: 'review', name: 'Reviewer', handle: 'review', avatarUrl: '/agent-review.png'}
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, json: async () => ({available: true, results: [{rowId: 'one', status: 'finished', answered: 0, assignments: [{id: 'assignment', generation: 1, status: 'finished', agent: to, hops: [{id: 'hop', from, to, at: '2026-10-24T00:00:00Z'}]}]}]})}))
 let tree!: ReturnType<typeof create>
 await act(async () => {tree = create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)})
 expect(tree.root.findAllByType('img').map(image => image.props.src)).toEqual(['/agent-review.png', '/agent-review.png'])
 expect(JSON.stringify(tree.toJSON())).toContain('🔎')
 expect(tree.root.findAllByProps({title: '@research'})).toHaveLength(1)
 act(() => tree.unmount())
})
