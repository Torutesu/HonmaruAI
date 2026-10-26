import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useWorkspaceMode } from './harness'

let result: ReturnType<typeof useWorkspaceMode>
let tree: ReactTestRenderer | undefined
let requests: Array<{ url: string; init?: RequestInit; resolve: (value: Response) => void }>
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key:string) => {values.delete(key)} }
const keyStarting=(prefix:string)=>[...values.keys()].find(key=>key.startsWith(prefix))
function Probe({ org = 'a', token = 'session-a' }: { org?: string; token?: string }) {
  result = useWorkspaceMode('https://relay.example', org, token)
  return null
}
const answer = async (index: number, mode: 'simple' | 'harness', canEdit = false, simpleOnly = false, revision = 0) => {
  await act(async () => { requests[index].resolve(new Response(JSON.stringify({ mode, canEdit, simpleOnly, revision }), { status: 200 })) })
}
const answerPreference = async (index:number,simpleOnly:boolean,revision:number)=>act(async()=>{requests[index].resolve(new Response(JSON.stringify({simpleOnly,revision}),{status:200}))})
beforeEach(() => {
  requests = []; values.clear()
  vi.stubGlobal('navigator',{onLine:true})
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>(resolve => requests.push({ url, init, resolve }))))
})
afterEach(() => { act(() => tree?.unmount()); tree = undefined; vi.unstubAllGlobals() })

test('switching workspaces drops old grants immediately and ignores a late response', async () => {
  act(() => { tree = create(<Probe />) })
  expect(result.mode).toBe('simple')
  act(() => { tree!.update(<Probe org="b" token="session-b" />) })
  await answer(0, 'harness', true)
  expect(result).toMatchObject({ mode: 'simple', canEdit: false, loaded: false })
  await answer(1, 'simple', false)
  expect(result).toMatchObject({ mode: 'simple', canEdit: false, loaded: true })
})

test('a session change cannot inherit admin controls, even in the same workspace', async () => {
  act(() => { tree = create(<Probe />) })
  await answer(0, 'harness', true)
  expect(result.canEdit).toBe(true)
  act(() => { tree!.update(<Probe token="someone-else" />) })
  expect(result).toMatchObject({ mode: 'simple', canEdit: false, loaded: false })
})

test('Simple-only preference syncs to this account and survives remount', async () => {
  act(() => { tree = create(<Probe />) })
  await answer(0, 'harness', false)
  let write!:Promise<unknown>
  act(() => {write=result.setSimpleOnly(true)})
  expect(result).toMatchObject({ mode: 'simple', workspaceMode: 'harness', simpleOnly: true })
  await act(async()=>{await Promise.resolve()})
  expect(requests).toHaveLength(2)
  expect(requests[1].url).toBe('https://relay.example/hx/display-preference')
  expect(requests[1].init?.method).toBe('PUT')
  expect(JSON.parse(String(requests[1].init?.body))).toMatchObject({orgId:'a',simpleOnly:true})
  await answerPreference(1,true,1)
  await act(async()=>{await write})
  act(() => tree!.unmount())
  act(() => { tree = create(<Probe />) })
  await answer(2, 'harness',false,true,1)
  expect(result.mode).toBe('simple')
  let reset!:Promise<unknown>
  act(()=>{reset=result.setSimpleOnly(false)})
  await act(async()=>{await Promise.resolve()})
  await answerPreference(3,false,2)
  await act(async()=>{await reset})
  expect(result.mode).toBe('harness')
  expect(requests.map(r=>r.init?.method)).toEqual(['GET','PUT','GET','PUT'])
})

test('Simple browser preferences do not bleed across workspaces', async () => {
  act(() => { tree = create(<Probe />) })
  await answer(0, 'harness')
  let write!:Promise<unknown>
  act(() => {write=result.setSimpleOnly(true)})
  await act(async()=>{await Promise.resolve()})
  await answerPreference(1,true,1)
  await act(async()=>{await write})
  act(() => tree!.update(<Probe org="b" />))
  await answer(2, 'harness')
  expect(result).toMatchObject({ mode: 'harness', simpleOnly: false })
})

test('a different signed-in session cannot inherit or upload another account preference',async()=>{
  act(()=>{tree=create(<Probe/>)})
  await answer(0,'harness',false,true,1)
  expect(result.mode).toBe('simple')
  act(()=>{tree!.update(<Probe token="session-b"/>)})
  expect(result).toMatchObject({mode:'simple',simpleOnly:false,loaded:false})
  await answer(1,'harness',false,false,0)
  expect(result).toMatchObject({mode:'harness',simpleOnly:false,loaded:true})
  expect(requests).toHaveLength(2)
  expect(requests.some(request=>request.init?.method==='PUT')).toBe(false)
})

test('storage denied still allows Simple for this browser session', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
  vi.stubGlobal('navigator',{onLine:false})
  act(() => { tree = create(<Probe />) })
  act(() => { void result.setSimpleOnly(true) })
  expect(result.mode).toBe('simple')
})

test('failed mode loading can retry without inheriting grants',async()=>{
 act(()=>{tree=create(<Probe/>)})
 await act(async()=>requests[0].resolve(new Response('{}',{status:503})))
 expect(result).toMatchObject({loaded:false,canEdit:false,error:'Workspace settings could not load.'})
 act(()=>result.retry())
 expect(result).toMatchObject({loaded:false,canEdit:false,error:''})
 expect(requests[0].init?.signal?.aborted).toBe(true)
 await answer(1,'harness',true)
 expect(result).toMatchObject({loaded:true,mode:'harness',canEdit:true,error:''})
})
test('timed-out and malformed responses cannot switch the loading shell to a stale mode',async()=>{
 vi.useFakeTimers()
 try{
  act(()=>{tree=create(<Probe/>)})
  await act(async()=>{vi.advanceTimersByTime(15000)})
  expect(result.error).toBeTruthy();expect(requests[0].init?.signal?.aborted).toBe(true)
  await answer(0,'harness',true)
  expect(result).toMatchObject({loaded:false,canEdit:false,mode:'simple'})
  act(()=>result.retry())
  await act(async()=>requests[1].resolve(new Response('{"mode":"invalid"}')))
  expect(result.error).toBeTruthy();expect(result.loaded).toBe(false)
  let write!:Promise<unknown>
  act(()=>{write=result.setSimpleOnly(true)})
  expect(result).toMatchObject({mode:'simple',simpleOnly:true,canEdit:false})
  await act(async()=>{await Promise.resolve()})
  await answerPreference(2,true,1)
  await act(async()=>{await write})
 }finally{vi.useRealTimers()}
})

test('offline reload preserves only workspace presentation and revalidates when reconnected',async()=>{
 act(()=>{tree=create(<Probe/>)})
 await answer(0,'harness',true)
 expect([...values.values()]).not.toContain('session-a')
 act(()=>tree!.unmount())
 vi.stubGlobal('navigator',{onLine:false})
 act(()=>{tree=create(<Probe/>)})
 expect(result).toMatchObject({mode:'harness',offline:true,loaded:false,canEdit:false})
 expect(requests).toHaveLength(1)
 act(()=>tree!.update(<Probe org="other"/>))
 expect(result).toMatchObject({mode:'simple',canEdit:false,loaded:false})
 act(()=>tree!.update(<Probe/>))
 expect(result.mode).toBe('harness')
 await act(async()=>{vi.stubGlobal('navigator',{onLine:true});window.dispatchEvent(new Event('online'))})
 expect(requests).toHaveLength(2)
 expect(result).toMatchObject({offline:false,loaded:false,canEdit:false})
 await answer(1,'simple',false)
 expect(result).toMatchObject({mode:'simple',loaded:true,canEdit:false})
})

test('an offline Simple choice syncs when the same account reconnects',async()=>{
 act(()=>{tree=create(<Probe/>)})
 await answer(0,'harness')
 vi.stubGlobal('navigator',{onLine:false})
 act(()=>{window.dispatchEvent(new Event('offline'))})
 await act(async()=>{await Promise.resolve()})
 act(()=>{void result.setSimpleOnly(true)})
 expect(result.mode).toBe('simple')
 expect(requests).toHaveLength(1)
 const pendingKey=keyStarting('hx.simple.pending.https://relay.example.a.')!
 expect(values.get(pendingKey)).toBe('true')
 vi.stubGlobal('navigator',{onLine:true})
 await act(async()=>{window.dispatchEvent(new Event('online'))})
 expect(requests).toHaveLength(2)
 await answer(1,'harness')
 await act(async()=>{await Promise.resolve();await Promise.resolve()})
 expect(requests).toHaveLength(3)
 expect(requests[2].init?.method).toBe('PUT')
 await answerPreference(2,true,1)
 expect(result).toMatchObject({mode:'simple',simpleOnly:true})
 expect(values.has(pendingKey)).toBe(false)
})

test('a targeted preference event updates another signed-in device immediately',async()=>{
  act(()=>{tree=create(<Probe/>)})
  await answer(0,'harness')
  act(()=>{window.dispatchEvent(new CustomEvent('honmaru:display-preference-changed',{detail:{orgId:'a',simpleOnly:true,revision:3}}))})
  expect(result).toMatchObject({mode:'simple',workspaceMode:'harness',simpleOnly:true})
  const cache=values.get(keyStarting('hx.simple.https://relay.example.a.')!)
  expect(JSON.parse(cache||'{}').simpleOnly).toBe(true)
  act(()=>{window.dispatchEvent(new CustomEvent('honmaru:display-preference-changed',{detail:{orgId:'a',simpleOnly:false,revision:2}}))})
  expect(result.mode).toBe('simple')
})
