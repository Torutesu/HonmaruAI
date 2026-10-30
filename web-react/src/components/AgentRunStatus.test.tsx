import React from 'react'
import {act, create} from 'react-test-renderer'
import {afterEach, expect, test, vi} from 'vitest'
import {AgentRunStatus} from './AgentRunStatus'
import type {ChannelMessage} from '../types/card'
const chosenLocale = vi.hoisted(() => ({value: 'en'}))
vi.mock('../utils/locale', () => ({getLocale: () => chosenLocale.value}))
vi.mock('../utils/i18n', () => ({useT: () => (text: string, vars?: Record<string,string|number>) => Object.entries(vars||{}).reduce((value,[key,replacement])=>value.replaceAll(`{${key}}`,String(replacement)),text)}))
const api = {httpBase: 'https://api.example', orgId: 'org', sessionToken: 'one'}
const message = (id: string) => ({id, kind: 'message', body: `Request ${id}`} as ChannelMessage)
const ok = (status: string, rowId = 'one') => ({ok: true, json: async () => ({available: true, results: [{rowId, status, answered: 0}]})})
function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {addEventListener: vi.fn(), removeEventListener: vi.fn()})
  vi.stubGlobal('document', {visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn()})
}
afterEach(() => {chosenLocale.value = 'en'; vi.useRealTimers(); vi.unstubAllGlobals()})
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

test('shows live and completed agent work duration from the authorized assignment timestamps',async()=>{
 setup();vi.setSystemTime(new Date('2026-10-24T00:00:12Z'))
 let status:'running'|'finished'='running'
 const fetch=vi.fn().mockImplementation(async()=>({ok:true,json:async()=>({available:true,results:[{rowId:'one',status:'finished',answered:1,assignments:[{id:'assignment',generation:0,status,startedAt:'2026-10-24T00:00:00Z',updatedAt:status==='finished'?'2026-10-24T00:00:14Z':'2026-10-24T00:00:00Z',agent:{id:'agent',name:'Researcher',handle:'research'},hops:[]}]}]})}))
 vi.stubGlobal('fetch',fetch);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)})
 expect(JSON.stringify(tree.toJSON())).toContain('Running for 12 sec')
 status='finished'
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(JSON.stringify(tree.toJSON())).toContain('Execution took 14 sec')
 expect(tree.root.findAllByProps({className:'slk-run-duration'})).toHaveLength(1)
 act(()=>tree.unmount())
})

test.each(['ja', 'de', 'invalid_locale'])('formats handoff time with the app language %s, tolerating stale locale settings', async locale => {
 setup(); chosenLocale.value = locale
 const face = {id: 'agent', name: 'Agent', handle: 'agent'}
 const at = '2026-10-24T05:00:00Z'
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, json: async () => ({available: true, results: [{rowId: 'one', status: 'finished', answered: 0, assignments: [{id: 'assignment', generation: 1, status: 'finished', agent: face, hops: [{id: 'hop', from: face, to: face, at}, {id: 'bad', from: face, to: face, at: 'not-a-date'}]}]}]})}))
 let tree!: ReturnType<typeof create>
 await act(async () => {tree = create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)})
 const times = tree.root.findAllByType('time')
 expect(times).toHaveLength(1)
 expect(times[0].props.dateTime).toBe(at)
 expect(times[0].children.join('')).toBe(new Intl.DateTimeFormat(locale === 'invalid_locale' ? 'en' : locale, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(at)))
 act(() => tree.unmount())
})

test('queue status outage preserves fresh assignment status and stop controls, and continues polling', async () => {
 setup(); let reads = 0
 const fetch = vi.fn().mockImplementation(async () => ({ok: true, json: async () => ({available: false, results: [{rowId: 'one', status: 'unknown', answered: 0, assignments: [{id: 'assignment', generation: 1, status: ++reads < 3 ? 'running' : 'finished', canStop: reads < 3, agent: {id: 'agent', name: 'Reviewer', handle: 'review'}, hops: []}]}]})}))
 vi.stubGlobal('fetch', fetch)
 let tree!: ReturnType<typeof create>
 await act(async () => {tree = create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)})
 expect(JSON.stringify(tree.toJSON())).toContain('Some execution status is unavailable')
 expect(JSON.stringify(tree.toJSON())).toContain('Reviewer')
 expect(tree.root.findAllByType('button')).toHaveLength(1)
 await act(async () => {await vi.advanceTimersByTimeAsync(10000)})
 expect(tree.root.findAllByType('button')).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).toContain('Agent processing ended')
 await act(async () => {await vi.advanceTimersByTimeAsync(30000)})
 expect(fetch).toHaveBeenCalledTimes(3)
 act(() => tree.unmount())
})

test('persists the external cancellation outcome in the visible assignment after refreshing local stop state', async()=>{
 setup()
 const face={id:'agent',name:'Claude',handle:'claude'}
 const active={available:true,results:[{rowId:'one',status:'running',answered:0,assignments:[{id:'assignment',generation:2,status:'running',canStop:true,agent:face,hops:[]}]}]}
 const stopped={available:true,results:[{rowId:'one',status:'unknown',answered:0,assignments:[{id:'assignment',generation:2,status:'cancelled',providerStopStatus:'failed',canStop:false,agent:face,hops:[]}]}]}
 const fetch=vi.fn().mockImplementation(async (_url:string,init?:RequestInit)=>init?.method==='POST'
   ? {ok:true,status:200,json:async()=>({stopped:true,remoteStop:'failed'})}
   : {ok:true,status:200,json:async()=>fetch.mock.calls.length<3?active:stopped})
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentRunStatus api={api} channel="b:general" messages={[message('one')]}/>)})
 expect(tree.root.findAllByType('button')).toHaveLength(1)
 await act(async()=>tree.root.findByType('button').props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('Agent execution cancelled')
 expect(JSON.stringify(tree.toJSON())).toContain('Provider cancellation could not be confirmed')
 expect(tree.root.findAllByType('button')).toHaveLength(1)
 expect(JSON.stringify(tree.toJSON())).toContain('Retry provider cancellation')
 act(()=>tree.unmount())
})
