import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import type {WorkspaceFile,WorkspaceFileApi} from './workspaceFiles'
import {useWorkspaceFilePins} from './workspaceFilePins'

type PinsApi=Pick<WorkspaceFileApi,'filePins'|'setFilePin'>
const file=(id:string):WorkspaceFile=>({id,scope:'workspace',path:`${id}.txt`,createdBy:'member',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',version:1,deleted:false,contentType:'text/plain',size:1})
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})

test('pins refresh on focus and timer',async()=>{
 vi.useFakeTimers()
 const events=new EventTarget(),documentEvents=new EventTarget()
 vi.stubGlobal('window',Object.assign(events,{setInterval,clearInterval}))
 vi.stubGlobal('document',Object.assign(documentEvents,{visibilityState:'visible'}))
 let result:ReturnType<typeof useWorkspaceFilePins>
 const api:PinsApi={filePins:vi.fn().mockResolvedValue({pins:[file('one')]}),setFilePin:vi.fn().mockResolvedValue({pins:[]})}
 function Probe(){result=useWorkspaceFilePins('org',api);return <span>{result.pins.map(pin=>pin.id).join(',')}</span>}
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<Probe/>)})
 expect(result!.pins.map(pin=>pin.id)).toEqual(['one'])
 vi.mocked(api.filePins).mockResolvedValue({pins:[file('two')]})
 await act(async()=>{events.dispatchEvent(new Event('focus'))})
 expect(result!.pins.map(pin=>pin.id)).toEqual(['two'])
 vi.mocked(api.filePins).mockResolvedValue({pins:[file('three')]})
 await act(async()=>{vi.advanceTimersByTime(30000)})
 expect(result!.pins.map(pin=>pin.id)).toEqual(['three'])
 act(()=>tree!.unmount())
})

test('an org or authenticated API change never renders the previous member pins or allows a stale toggle',async()=>{
 const events=new EventTarget(),documentEvents=new EventTarget()
 vi.stubGlobal('window',Object.assign(events,{setInterval,clearInterval}))
 vi.stubGlobal('document',Object.assign(documentEvents,{visibilityState:'visible'}))
 let result:ReturnType<typeof useWorkspaceFilePins>
 let resolveNext!: (value:{pins:WorkspaceFile[]})=>void
 const first:PinsApi={filePins:vi.fn().mockResolvedValue({pins:[file('private-old')]}),setFilePin:vi.fn().mockResolvedValue({pins:[]})}
 const second:PinsApi={filePins:vi.fn<()=>Promise<{pins:WorkspaceFile[]}>>(()=>new Promise(resolve=>{resolveNext=resolve})),setFilePin:vi.fn().mockResolvedValue({pins:[]})}
 function Probe({orgId,api}:{orgId:string;api:PinsApi}){result=useWorkspaceFilePins(orgId,api);return <span>{result.pins.map(pin=>pin.id).join(',')}</span>}
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<Probe orgId="org-one" api={first}/>)})
 expect(result!.pins.map(pin=>pin.id)).toEqual(['private-old'])
 await act(async()=>{tree!.update(<Probe orgId="org-two" api={second}/>)})
 expect(result!.pins).toEqual([])
 expect(result!.loaded).toBe(false)
 await expect(result!.toggle(file('private-old'))).rejects.toThrow('固定状態を同期中')
 await act(async()=>{resolveNext({pins:[file('private-new')]})})
 expect(result!.pins.map(pin=>pin.id)).toEqual(['private-new'])
 await act(async()=>{tree!.update(<Probe orgId="org-three" api={second}/>)})
 expect(result!.pins).toEqual([])
 expect(result!.loaded).toBe(false)
 await act(async()=>{resolveNext({pins:[file('third-org')]})})
 expect(result!.pins.map(pin=>pin.id)).toEqual(['third-org'])
 act(()=>tree!.unmount())
})
