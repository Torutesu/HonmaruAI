import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {useThreadNotifications} from './useThreadNotifications'
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
let state:ReturnType<typeof useThreadNotifications>
function Probe({id='root',open=true}:{id?:string;open?:boolean}){state=useThreadNotifications(api,'b:general',id,open);return null}
const ok=(muted:boolean)=>({ok:true,json:async()=>({muted})})
afterEach(()=>vi.unstubAllGlobals())
test('loads the personal preference on each menu opening and writes only this thread',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(ok(false)).mockResolvedValueOnce(ok(true)).mockResolvedValueOnce(ok(false));vi.stubGlobal('fetch',fetch)
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<Probe/>)});expect(state.muted).toBe(false)
 await act(async()=>{await state.toggle()});expect(state.muted).toBe(true)
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({orgId:'team:test',channel:'b:general',messageId:'root',muted:true})
 await act(async()=>tree!.update(<Probe open={false}/>));await act(async()=>tree!.update(<Probe/>))
 expect(state.muted).toBe(false);act(()=>tree!.unmount())
})
test('an old thread response cannot replace the new thread preference',async()=>{
 let resolve!:(v:any)=>void
 vi.stubGlobal('fetch',vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValueOnce(ok(true)))
 let tree:ReturnType<typeof create>;await act(async()=>{tree=create(<Probe/>)})
 await act(async()=>tree!.update(<Probe id="other"/>));expect(state.muted).toBe(true)
 await act(async()=>resolve(ok(false)));expect(state.muted).toBe(true);act(()=>tree!.unmount())
})
test('failed writes leave the preference unknown until reread, without claiming success',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(ok(false)).mockRejectedValueOnce(new Error('offline')))
 let tree:ReturnType<typeof create>;await act(async()=>{tree=create(<Probe/>)})
 await act(async()=>{await state.toggle()});expect(state.muted).toBeNull();expect(state.error).toContain('保存できません');expect(state.busy).toBe(false)
 act(()=>tree!.unmount())
})
test('returning to a thread during its write waits and rereads rather than drawing an old response',async()=>{
 let resolve!:(v:any)=>void
 const fetch=vi.fn().mockResolvedValueOnce(ok(false)).mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValueOnce(ok(false)).mockResolvedValueOnce(ok(false))
 vi.stubGlobal('fetch',fetch)
 let tree:ReturnType<typeof create>;await act(async()=>{tree=create(<Probe/>)})
 let write!:Promise<void>;act(()=>{write=state.toggle()})
 await act(async()=>tree!.update(<Probe id="other"/>))
 await act(async()=>tree!.update(<Probe/>));expect(state.busy).toBe(true);expect(fetch).toHaveBeenCalledTimes(3)
 await act(async()=>{resolve(ok(true));await write})
 expect(fetch).toHaveBeenCalledTimes(4);expect(state.muted).toBe(false);expect(state.busy).toBe(false)
 act(()=>tree!.unmount())
})
