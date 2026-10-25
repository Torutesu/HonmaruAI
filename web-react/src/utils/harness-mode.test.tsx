import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useWorkspaceMode } from './harness'

let result: ReturnType<typeof useWorkspaceMode>
let tree: ReactTestRenderer | undefined
let requests: Array<{ init?: RequestInit; resolve: (value: Response) => void }>
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
function Probe({ org = 'a', token = 'session-a' }: { org?: string; token?: string }) {
  result = useWorkspaceMode('https://relay.example', org, token)
  return null
}
const answer = async (index: number, mode: 'simple' | 'harness', canEdit = false) => {
  await act(async () => { requests[index].resolve(new Response(JSON.stringify({ mode, canEdit }), { status: 200 })) })
}
beforeEach(() => {
  requests = []; values.clear()
  vi.stubGlobal('navigator',{onLine:true})
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(resolve => requests.push({ init, resolve }))))
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

test('browser-only Simple changes no server data and survives remount', async () => {
  act(() => { tree = create(<Probe />) })
  await answer(0, 'harness', false)
  act(() => result.setSimpleOnly(true))
  expect(result).toMatchObject({ mode: 'simple', workspaceMode: 'harness', simpleOnly: true })
  expect(requests).toHaveLength(1)
  act(() => tree!.unmount())
  act(() => { tree = create(<Probe />) })
  await answer(1, 'harness')
  expect(result.mode).toBe('simple')
  act(() => result.setSimpleOnly(false))
  expect(result.mode).toBe('harness')
  expect(requests.every(r => r.init?.method === 'GET')).toBe(true)
})

test('Simple browser preferences do not bleed across workspaces', async () => {
  act(() => { tree = create(<Probe />) })
  await answer(0, 'harness')
  act(() => result.setSimpleOnly(true))
  act(() => tree!.update(<Probe org="b" />))
  await answer(1, 'harness')
  expect(result).toMatchObject({ mode: 'harness', simpleOnly: false })
})

test('storage denied still allows Simple for this browser session', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
  act(() => { tree = create(<Probe />) })
  await answer(0, 'harness')
  act(() => result.setSimpleOnly(true))
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
  act(()=>result.setSimpleOnly(true))
  expect(result).toMatchObject({mode:'simple',simpleOnly:true,canEdit:false})
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
