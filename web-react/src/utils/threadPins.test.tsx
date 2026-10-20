import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {useThreadPins} from './threadPins'
const api={httpBase:'https://api.example',orgId:'team:a',sessionToken:'one'}
const pin={id:'root',view:'b:general',title:'Work',createdAt:'2026-01-01'}
const ok=(pins:any[])=>({ok:true,json:async()=>({pins})})
let latest:ReturnType<typeof useThreadPins>
function View({config=api,enabled=true}:any){latest=useThreadPins(config,enabled);return null}
function setup(){
 vi.stubGlobal('window',{setInterval:vi.fn(),clearInterval:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('document',{visibilityState:'visible',addEventListener:vi.fn(),removeEventListener:vi.fn()})
}
afterEach(()=>vi.unstubAllGlobals())
test('pin saves once, displays only acknowledged state, and an older refresh cannot undo it',async()=>{
 setup();let resolveRead!:(value:any)=>void,resolveWrite!:(value:any)=>void
 const fetch=vi.fn().mockResolvedValueOnce(ok([])).mockImplementationOnce(()=>new Promise(r=>resolveRead=r)).mockImplementationOnce(()=>new Promise(r=>resolveWrite=r))
 vi.stubGlobal('fetch',fetch);let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<View/>)})
 act(()=>{void latest.refresh()})
 act(()=>{void latest.toggle('root');void latest.toggle('root')})
 expect(fetch).toHaveBeenCalledTimes(3);expect(latest!.pins).toEqual([])
 await act(async()=>resolveWrite(ok([pin])))
 await act(async()=>resolveRead(ok([])))
 expect(latest!.pins).toEqual([pin]);expect(latest!.busy).toBe(false)
 act(()=>tree!.unmount())
})
test('workspace changes hide prior pins immediately and ignore a late save',async()=>{
 setup();let resolveWrite!:(value:any)=>void
 const fetch=vi.fn().mockResolvedValueOnce(ok([pin])).mockImplementationOnce(()=>new Promise(r=>resolveWrite=r)).mockResolvedValueOnce(ok([]))
 vi.stubGlobal('fetch',fetch);let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<View/>)})
 act(()=>{void latest.toggle('root')})
 await act(async()=>tree!.update(<View config={{...api,orgId:'team:b',sessionToken:'two'}}/>))
 await act(async()=>resolveWrite(ok([pin])))
 expect(latest!.pins).toEqual([]);expect(latest!.busy).toBe(false)
 act(()=>tree!.unmount())
})
test('Simple mode makes no pin requests, and failed writes retain saved state with an error',async()=>{
 setup();const fetch=vi.fn().mockResolvedValueOnce(ok([pin])).mockResolvedValueOnce({ok:false,json:async()=>({message:'Unavailable'})})
 vi.stubGlobal('fetch',fetch);let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<View enabled={false}/>)})
 expect(fetch).not.toHaveBeenCalled()
 await act(async()=>tree!.update(<View/>))
 await act(async()=>latest.toggle('root'))
 expect(latest!.pins).toEqual([pin]);expect(latest!.error).toBe('Unavailable')
 act(()=>tree!.unmount())
})

test('independent clients converge after focus and polling, and a hidden client refreshes on return',async()=>{
 vi.useFakeTimers();const listeners=new Map<string,Set<()=>void>>()
 const add=(name:string,fn:()=>void)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(fn)}
 const remove=(name:string,fn:()=>void)=>listeners.get(name)?.delete(fn)
 const doc={visibilityState:'visible',addEventListener:add,removeEventListener:remove}
 vi.stubGlobal('window',{setInterval,clearInterval,addEventListener:add,removeEventListener:remove});vi.stubGlobal('document',doc)
 let saved:any[]=[];const fetch=vi.fn(async(_url:string,init:any)=>{if(init?.method==='PUT'){const body=JSON.parse(init.body);saved=body.pinned?[pin]:[]}return ok(saved.map(value=>({...value})))})
 vi.stubGlobal('fetch',fetch)
 const clients:Record<string,ReturnType<typeof useThreadPins>>={}
 function Client({name}:{name:string}){clients[name]=useThreadPins(api,true);return null}
 let tree:ReturnType<typeof create>
 try{
  await act(async()=>{tree=create(<><Client name="first"/><Client name="second"/></>)})
  await act(async()=>clients.first.toggle('root'))
  expect(clients.second.pins).toEqual([])
  await act(async()=>listeners.get('focus')!.forEach(fn=>fn()))
  expect(clients.second.pins).toEqual([pin])
  saved=[{...pin,title:'Renamed elsewhere'}]
  await act(async()=>vi.advanceTimersByTimeAsync(30000))
  expect(clients.second.pins[0].title).toBe('Renamed elsewhere')
  doc.visibilityState='hidden';saved=[];const before=fetch.mock.calls.length
  await act(async()=>vi.advanceTimersByTimeAsync(30000))
  expect(fetch).toHaveBeenCalledTimes(before)
  doc.visibilityState='visible';await act(async()=>listeners.get('visibilitychange')!.forEach(fn=>fn()))
  expect(clients.first.pins).toEqual([]);expect(clients.second.pins).toEqual([])
 }finally{act(()=>tree!.unmount());vi.useRealTimers()}
})
