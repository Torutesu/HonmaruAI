import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {WorkspaceFilesPanel} from './WorkspaceFilesPanel'
import type {WorkspaceFileApi,FileVersion,WorkspaceFile} from '../utils/workspaceFiles'
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
vi.mock('./Icon',()=>({Icon:()=>null}))
const file={id:'file',scope:'workspace',path:'history.txt',version:51,size:1,contentType:'text/plain'} as WorkspaceFile
const version=(n:number)=>({version:n,kind:'content',isCurrent:n===51,createdAt:'2026-10-25T00:00:00Z',purged:false}) as FileVersion

test('history navigates past fifty versions with an exclusive cursor and returns to latest',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[file],next:null}),versions:vi.fn().mockImplementation(async(_id,before)=>({versions:before===2?[version(1)]:Array.from({length:50},(_,i)=>version(51-i))}))} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-row'}).props.onClick()})
 const button=(label:string)=>renderer!.root.findAllByType('button').find(b=>b.children.includes(label))
 await act(async()=>{button('Older versions')!.props.onClick()})
 expect(vi.mocked(api.versions).mock.calls.at(-1)?.slice(0,2)).toEqual(['file',2]);expect(button('Older versions')).toBeUndefined()
 expect(renderer!.root.findAllByProps({className:'hx-file-version'})).toHaveLength(1)
 await act(async()=>{button('Latest versions')!.props.onClick()})
 expect(vi.mocked(api.versions).mock.calls.at(-1)?.slice(0,2)).toEqual(['file',undefined]);expect(renderer!.root.findAllByProps({className:'hx-file-version'})).toHaveLength(50)
 act(()=>renderer!.unmount())
})

test('restoring uses the observed current version and refreshes history and listing',async()=>{
 const old={...version(1),currentVersion:51},current={...version(51),currentVersion:51}
 const api={list:vi.fn().mockResolvedValue({files:[file],next:null}),versions:vi.fn().mockResolvedValue({versions:[current,old]}),restore:vi.fn().mockResolvedValue({saved:true,version:52})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-row'}).props.onClick()})
 expect(renderer!.root.findAllByProps({'aria-label':'Restore v51'})).toHaveLength(0)
 await act(async()=>{renderer!.root.findByProps({'aria-label':'Restore v1'}).props.onClick()})
 expect(api.restore).toHaveBeenCalledWith('file',1,51);expect(api.versions).toHaveBeenCalledTimes(2);expect(api.list).toHaveBeenCalledTimes(2)
 act(()=>renderer!.unmount())
})

test('a failed restore does not retry or silently adopt a newer version',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[file],next:null}),versions:vi.fn().mockResolvedValue({versions:[{...version(1),currentVersion:51}]}),restore:vi.fn().mockRejectedValue(new Error('Conflict'))} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-row'}).props.onClick()})
 await act(async()=>{renderer!.root.findByProps({'aria-label':'Restore v1'}).props.onClick()})
 expect(api.restore).toHaveBeenCalledTimes(1);expect(api.versions).toHaveBeenCalledTimes(1);expect(api.list).toHaveBeenCalledTimes(1)
 expect(JSON.stringify(renderer!.toJSON())).toContain('Conflict');act(()=>renderer!.unmount())
})

test('deleted files are explicitly included and deletion uses the loaded version',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[file],next:null}),versions:vi.fn().mockResolvedValue({versions:[{...version(51),currentVersion:51}]}),remove:vi.fn().mockResolvedValue({saved:true,version:52})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 expect(vi.mocked(api.list).mock.calls[0][0].includeDeleted).toBe(false)
 await act(async()=>{renderer!.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}})})
 expect(vi.mocked(api.list).mock.calls.at(-1)![0].includeDeleted).toBe(true)
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-row'}).props.onClick()})
 await act(async()=>{renderer!.root.findByProps({className:'hx-files-remove'}).props.onClick()})
 expect(api.remove).toHaveBeenCalledWith('file',51);expect(api.versions).toHaveBeenCalledTimes(2)
 act(()=>renderer!.unmount())
})
