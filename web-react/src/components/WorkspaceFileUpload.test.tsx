import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {WorkspaceFileUpload} from './WorkspaceFileUpload'
import type {WorkspaceFileApi} from '../utils/workspaceFiles'
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
vi.mock('./Icon',()=>({Icon:()=>null}))
const file={name:'report.txt',webkitRelativePath:'reports/report.txt',size:5} as File

test('failed content retries retain the reserved ID and never overwrite a current version',async()=>{
 const api={create:vi.fn().mockResolvedValue({id:'reserved',version:0}),upload:vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({saved:true,version:1})} as unknown as WorkspaceFileApi
 const onSaved=vi.fn();let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFileUpload api={api} scope="b:general" onSaved={onSaved}/> )})
 await act(async()=>{renderer!.root.findAllByType('input')[0].props.onChange({target:{files:[file],value:'selected'}})})
 expect(api.create).toHaveBeenCalledWith('b:general','reports/report.txt',expect.stringMatching(/^file-/));expect(onSaved).not.toHaveBeenCalled()
 await act(async()=>{renderer!.root.findAllByType('button').find(button=>button.children.includes('Retry failed uploads'))!.props.onClick()})
 expect(api.create).toHaveBeenCalledTimes(1);expect(api.upload).toHaveBeenCalledTimes(2)
 expect(vi.mocked(api.upload).mock.calls.map(call=>call.slice(0,3))).toEqual([['reserved',0,file],['reserved',0,file]])
 expect(onSaved).toHaveBeenCalledTimes(1);act(()=>renderer!.unmount())
})
test('leaving the panel while reserving a path prevents content and subsequent uploads',async()=>{
 let finish!:(value:{id:string;version:number})=>void
 const api={create:vi.fn(()=>new Promise(resolve=>{finish=resolve})),upload:vi.fn()} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFileUpload api={api} scope="b:general" onSaved={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findAllByType('input')[0].props.onChange({target:{files:[file,file],value:'selected'}})})
 act(()=>renderer!.unmount());await act(async()=>{finish({id:'reserved',version:0})})
 expect(api.create).toHaveBeenCalledTimes(1);expect(api.upload).not.toHaveBeenCalled()
})

test('oversized selections are rejected before reserving a path',async()=>{
 const api={create:vi.fn(),upload:vi.fn()} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFileUpload api={api} scope="workspace" onSaved={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findAllByType('input')[0].props.onChange({target:{files:[{...file,size:25*1024*1024+1}],value:'selected'}})})
 expect(api.create).not.toHaveBeenCalled();expect(api.upload).not.toHaveBeenCalled()
 expect(JSON.stringify(renderer!.toJSON())).toContain('Files must be 25 MB or smaller.');act(()=>renderer!.unmount())
})

test('a lost reservation response is retried with the same request identifier',async()=>{
 const api={create:vi.fn().mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({id:'reserved',version:0}),upload:vi.fn().mockResolvedValue({saved:true,version:1})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFileUpload api={api} scope="workspace" onSaved={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findAllByType('input')[0].props.onChange({target:{files:[file],value:'selected'}})})
 await act(async()=>{renderer!.root.findAllByType('button').find(button=>button.children.includes('Retry failed uploads'))!.props.onClick()})
 expect(api.create).toHaveBeenCalledTimes(2);expect(vi.mocked(api.create).mock.calls[0]).toEqual(vi.mocked(api.create).mock.calls[1]);expect(api.upload).toHaveBeenCalledTimes(1)
 act(()=>renderer!.unmount())
})

test('uploads keep the selected destination even when navigation changes before retry',async()=>{
 const api={create:vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({id:'reserved',version:0}),upload:vi.fn().mockResolvedValue({saved:true,version:1})} as unknown as WorkspaceFileApi
 const onSaved=vi.fn();let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFileUpload api={api} scope="workspace" directory="Team/" onSaved={onSaved}/> )})
 await act(async()=>{renderer!.root.findAllByType('input')[0].props.onChange({target:{files:[file],value:'selected'}})})
 await act(async()=>{renderer!.update(<WorkspaceFileUpload api={api} scope="workspace" directory="Other/" onSaved={onSaved}/> )})
 await act(async()=>{renderer!.root.findAllByType('button').find(button=>button.children.includes('Retry failed uploads'))!.props.onClick()})
 expect(vi.mocked(api.create).mock.calls.map(call=>call[1])).toEqual(['Team/reports/report.txt','Team/reports/report.txt'])
 expect(onSaved).toHaveBeenCalledTimes(1);act(()=>renderer!.unmount())
})
