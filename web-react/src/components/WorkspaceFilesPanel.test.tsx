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
 const button=(label:string)=>renderer!.root.findAllByType('button').find(b=>b.children.includes(label)||b.props['aria-label']===label)
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

test('a replacement appends to the existing file using the loaded current version',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[file],next:null}),versions:vi.fn().mockResolvedValue({versions:[{...version(51),currentVersion:51}]}),upload:vi.fn().mockResolvedValue({saved:true,version:52})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-row'}).props.onClick()})
 const content=new Blob(['updated content'],{type:'text/plain'})
 await act(async()=>{renderer!.root.findByProps({'aria-label':'Choose a new file version'}).props.onChange({target:{files:[content],value:'chosen'}})})
 expect(api.upload).toHaveBeenCalledWith('file',51,content,expect.any(AbortSignal));expect(api.versions).toHaveBeenCalledTimes(2);expect(api.list).toHaveBeenCalledTimes(2)
 act(()=>renderer!.unmount())
})

test('opening history preserves an in-flight room upload until the panel closes',async()=>{
 let finish!:(value:{saved:true;version:number})=>void
 const api={create:vi.fn().mockResolvedValue({id:'new-file',version:0}),upload:vi.fn(()=>new Promise(resolve=>{finish=resolve})),list:vi.fn().mockResolvedValue({files:[file],next:null}),versions:vi.fn().mockResolvedValue({versions:[{...version(51),currentVersion:51}]})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findAllByProps({type:'file'})[0].props.onChange({target:{files:[{name:'new.txt',size:5}],value:'chosen'}})})
 const signal=vi.mocked(api.upload).mock.calls[0][3]!
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-row'}).props.onClick()})
 expect(signal.aborted).toBe(false)
 await act(async()=>{finish({saved:true,version:1})});expect(api.list).toHaveBeenCalledTimes(2)
 act(()=>renderer!.unmount());expect(signal.aborted).toBe(true)
})

test('folder navigation requests direct children, scopes search and resets pagination on breadcrumbs',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[],next:null}),folders:vi.fn().mockImplementation(async(_scope,directory)=>({folders:directory?[]:[{name:'Alpha',path:'Alpha/'}],next:null}))} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 const button=(label:string)=>renderer!.root.findAllByType('button').find(b=>b.children.includes(label)||b.props['aria-label']===label)
 await act(async()=>{button('Folders')!.props.onClick()})
 expect(vi.mocked(api.list).mock.calls[0][0].order).toBe('recent')
 expect(vi.mocked(api.list).mock.calls.at(-1)![0].order).toBe('path')
 expect(api.folders).toHaveBeenLastCalledWith('workspace','',false,undefined,expect.any(AbortSignal),undefined)
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-folder'}).props.onClick()})
 expect(vi.mocked(api.list).mock.calls.at(-1)![0]).toMatchObject({directory:'Alpha/',directOnly:true})
 await act(async()=>{renderer!.root.findByProps({'aria-label':'Search files'}).props.onChange({target:{value:'note'}})})
 await act(async()=>{renderer!.root.findByType('form').props.onSubmit({preventDefault(){}})})
 expect(vi.mocked(api.list).mock.calls.at(-1)![0]).toMatchObject({directory:'Alpha/',directOnly:false,query:'note'})
 await act(async()=>{button('All files')!.props.onClick()})
 expect(vi.mocked(api.list).mock.calls.at(-1)![0]).toMatchObject({directory:'',directOnly:true,query:''})
 act(()=>renderer!.unmount())
})

test('origin switches filter files and folders together and discard previous page cursors',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[],next:{path:'old',id:'old'}}),folders:vi.fn().mockResolvedValue({folders:[],next:'old-folder'})} as unknown as WorkspaceFileApi
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 const click=async(label:string)=>act(async()=>tree!.root.findAllByType('button').find(b=>b.props['aria-label']===label||b.children.includes(label))!.props.onClick())
 await click('Folders');await click('Next');await click('More folders')
 await click('Created by agents')
 expect(vi.mocked(api.list).mock.calls.at(-1)![0]).toMatchObject({origin:'agent',order:'path'})
 expect(vi.mocked(api.list).mock.calls.at(-1)![0].cursor).toBeUndefined()
 expect(api.folders).toHaveBeenLastCalledWith('workspace','',false,undefined,expect.any(AbortSignal),'agent')
 await act(async()=>tree!.root.findAllByType('select').find(select=>select.props['aria-label']==='File source')!.props.onChange({target:{value:'unknown'}}))
 expect(vi.mocked(api.list).mock.calls.at(-1)![0].origin).toBe('unknown')
 await act(async()=>tree!.root.findAllByType('select').find(select=>select.props['aria-label']==='File source')!.props.onChange({target:{value:'all'}}))
 expect(vi.mocked(api.list).mock.calls.at(-1)![0].origin).toBeUndefined()
 act(()=>tree!.unmount())
})

test('folder view ignores the recent origin filter and restores it on return',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[],next:{path:'old',id:'old'}}),folders:vi.fn().mockResolvedValue({folders:[],next:'old-folder'})} as unknown as WorkspaceFileApi
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<WorkspaceFilesPanel allOriginsInFolders api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 const button=(label:string)=>tree!.root.findAllByType('button').find(b=>b.props['aria-label']===label||b.children.includes(label))
 const click=async(label:string)=>act(async()=>button(label)!.props.onClick())
 await click('Created by agents')
 expect(vi.mocked(api.list).mock.calls.at(-1)![0]).toMatchObject({origin:'agent',order:'recent'})
 await act(async()=>tree!.root.findByProps({'aria-label':'File type'}).props.onChange({target:{value:'pdf'}}))
 await act(async()=>tree!.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}))
 await act(async()=>tree!.root.findByProps({'aria-label':'Search files'}).props.onChange({target:{value:'invoice'}}))
 await act(async()=>tree!.root.findByType('form').props.onSubmit({preventDefault(){}}))
 await click('Next');await click('Folders')
 expect(tree!.root.findAllByProps({'aria-label':'File source'})).toHaveLength(0)
 const folderSearch=vi.mocked(api.list).mock.calls.at(-1)![0]
 expect(folderSearch).toMatchObject({order:'path',directory:'',query:'invoice',type:'pdf',includeDeleted:true,directOnly:false})
 expect(folderSearch.origin).toBeUndefined();expect(folderSearch.cursor).toBeUndefined()
 await act(async()=>tree!.root.findByProps({'aria-label':'Search files'}).props.onChange({target:{value:''}}))
 await act(async()=>tree!.root.findByType('form').props.onSubmit({preventDefault(){}}))
 expect(api.folders).toHaveBeenLastCalledWith('workspace','',true,undefined,expect.any(AbortSignal),undefined)
 await click('Recent')
 expect(vi.mocked(api.list).mock.calls.at(-1)![0]).toMatchObject({origin:'agent',order:'recent',type:'pdf',includeDeleted:true,query:''})
 expect(button('Created by agents')?.props['aria-pressed']).toBe(true)
 act(()=>tree!.unmount())
})

test('mode changes reset page cursors and restore the recent origin filter',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[],next:{path:'old',id:'old'}}),folders:vi.fn().mockResolvedValue({folders:[],next:'old-folder'})} as unknown as WorkspaceFileApi
 let tree:ReturnType<typeof create>
 const props={api,scope:'workspace',onClose:vi.fn(),onAttachments:vi.fn()}
 await act(async()=>{tree=create(<WorkspaceFilesPanel {...props}/> )})
 const click=async(label:string)=>act(async()=>tree!.root.findAllByType('button').find(b=>b.props['aria-label']===label||b.children.includes(label))!.props.onClick())
 await click('Created by agents');await click('Folders');await click('Next');await click('More folders')
 let beforeList=vi.mocked(api.list).mock.calls.length,beforeFolders=vi.mocked(api.folders).mock.calls.length
 await act(async()=>tree!.update(<WorkspaceFilesPanel {...props} allOriginsInFolders/>))
 let newLists=vi.mocked(api.list).mock.calls.slice(beforeList),newFolders=vi.mocked(api.folders).mock.calls.slice(beforeFolders)
 expect(newLists.length).toBeGreaterThan(0);expect(newFolders.length).toBeGreaterThan(0)
 for(const [params] of newLists){expect(params.origin).toBeUndefined();expect(params.cursor).toBeUndefined()}
 for(const args of newFolders){expect(args[3]).toBeUndefined();expect(args[5]).toBeUndefined()}
 expect(tree!.root.findAllByProps({'aria-label':'File source'})).toHaveLength(0)
 await click('Next');await click('More folders')
 beforeList=vi.mocked(api.list).mock.calls.length;beforeFolders=vi.mocked(api.folders).mock.calls.length
 await act(async()=>tree!.update(<WorkspaceFilesPanel {...props}/>))
 newLists=vi.mocked(api.list).mock.calls.slice(beforeList);newFolders=vi.mocked(api.folders).mock.calls.slice(beforeFolders)
 expect(newLists.length).toBeGreaterThan(0);expect(newFolders.length).toBeGreaterThan(0)
 for(const [params] of newLists){expect(params.origin).toBe('agent');expect(params.cursor).toBeUndefined()}
 for(const args of newFolders){expect(args[3]).toBeUndefined();expect(args[5]).toBe('agent')}
 expect(tree!.root.findByProps({'aria-label':'Created by agents'}).props['aria-pressed']).toBe(true)
 act(()=>tree!.unmount())
})

test('a late recent-filter response cannot replace the newer folder listing',async()=>{
 let finishOld!:(value:{files:WorkspaceFile[];next:null})=>void,oldSignal:AbortSignal|undefined
 const agent={...file,id:'agent',path:'agent.txt'},human={...file,id:'human',path:'human.txt'}
 const list=vi.fn((params:any,signal?:AbortSignal)=>{
  if(params.order==='recent'&&params.origin==='agent'){oldSignal=signal;return new Promise(resolve=>{finishOld=resolve})}
  return Promise.resolve({files:params.order==='path'?[agent,human]:[],next:null})
 })
 const api={list,folders:vi.fn().mockResolvedValue({folders:[],next:null})} as unknown as WorkspaceFileApi
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<WorkspaceFilesPanel api={api} scope="workspace" allOriginsInFolders onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 await act(async()=>tree!.root.findByProps({'aria-label':'Created by agents'}).props.onClick())
 await act(async()=>tree!.root.findByProps({'aria-label':'Folders'}).props.onClick())
 expect(oldSignal?.aborted).toBe(true)
 expect(JSON.stringify(tree!.toJSON())).toContain('human.txt')
 await act(async()=>finishOld({files:[agent],next:null}))
 expect(JSON.stringify(tree!.toJSON())).toContain('human.txt')
 expect(tree!.root.findAllByProps({className:'hx-file-row'})).toHaveLength(2)
 act(()=>tree!.unmount())
})

test('a saved folder view never applies a hidden recent origin filter after remount',async()=>{
 const saved=JSON.stringify({version:1,folderMode:true,directory:'',search:'',includeDeleted:false,origin:'human'})
 const session={getItem:vi.fn(()=>saved),setItem:vi.fn()};vi.stubGlobal('sessionStorage',session)
 let tree:ReturnType<typeof create>|undefined
 try{
  const api={list:vi.fn().mockResolvedValue({files:[],next:null}),folders:vi.fn().mockResolvedValue({folders:[],next:null})} as unknown as WorkspaceFileApi
  await act(async()=>{tree=create(<WorkspaceFilesPanel allOriginsInFolders api={api} scope="workspace" preferenceKey="fixture" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
  expect(vi.mocked(api.list).mock.calls.at(-1)![0].origin).toBeUndefined()
  expect(api.folders).toHaveBeenLastCalledWith('workspace','',false,undefined,expect.any(AbortSignal),undefined)
  expect(tree!.root.findAllByProps({'aria-label':'File source'})).toHaveLength(0)
  expect(JSON.stringify(tree!.toJSON())).toContain('This folder is empty')
  await act(async()=>tree!.root.findByProps({'aria-label':'Recent'}).props.onClick())
  expect(vi.mocked(api.list).mock.calls.at(-1)![0].origin).toBe('human')
  expect(tree!.root.findByProps({'aria-label':'Uploaded by users'}).props['aria-pressed']).toBe(true)
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('a socket file notification refreshes both the open list and its visible history',async()=>{
 vi.useFakeTimers();const target=new EventTarget();vi.stubGlobal('window',target)
 let tree:ReturnType<typeof create>|undefined
 try{
  const api={list:vi.fn().mockResolvedValue({files:[file],next:null}),versions:vi.fn().mockResolvedValue({versions:[version(51)]})} as unknown as WorkspaceFileApi
  await act(async()=>{tree=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
  await act(async()=>tree!.root.findByProps({className:'hx-file-row'}).props.onClick())
  await act(async()=>{target.dispatchEvent(new CustomEvent('honmaru:jam',{detail:{name:'workspace_files_changed',value:{}}}));await vi.advanceTimersByTimeAsync(150)})
  expect(api.list).toHaveBeenCalledTimes(2);expect(api.versions).toHaveBeenCalledTimes(2)
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals();vi.useRealTimers()}
})

test('a linked file opens outside listing filters, but never under a different room',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[],next:null}),get:vi.fn().mockResolvedValue({file}),versions:vi.fn().mockResolvedValue({versions:[version(51)]})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" targetFileId="file" onClose={vi.fn()} onAttachments={vi.fn()}/>)})
 expect(renderer!.root.findByType('h2').children).toContain('history.txt')
 await act(async()=>{renderer!.unmount()})
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="g:other" targetFileId="file" onClose={vi.fn()} onAttachments={vi.fn()}/>)})
 expect(renderer!.root.findAllByType('h2')).toHaveLength(0)
 expect(renderer!.root.findByProps({role:'alert'}).findByType('p').children).toContain('This file is unavailable or you no longer have access.')
 await act(async()=>{renderer!.unmount()})
})

test('a slow earlier file-link response cannot replace a newer target',async()=>{
 let finishFirst!:(value:{file:WorkspaceFile})=>void
 const api={list:vi.fn().mockResolvedValue({files:[],next:null}),get:vi.fn((id:string)=>id==='first'?new Promise(resolve=>{finishFirst=resolve}):Promise.resolve({file:{...file,id:'second',path:'second.txt'}})),versions:vi.fn().mockResolvedValue({versions:[version(51)]})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 const props={api,scope:'workspace',onClose:vi.fn(),onAttachments:vi.fn()}
 await act(async()=>{renderer=create(<WorkspaceFilesPanel {...props} targetFileId="first"/>)})
 await act(async()=>{renderer!.update(<WorkspaceFilesPanel {...props} targetFileId="second"/>)})
 expect(renderer!.root.findByType('h2').children).toContain('second.txt')
 await act(async()=>{finishFirst({file:{...file,id:'first',path:'first.txt'}})})
 expect(renderer!.root.findByType('h2').children).toContain('second.txt')
 await act(async()=>{renderer!.unmount()})
})

test('linked file errors are readable and retry retrieves the requested file',async()=>{
 const get=vi.fn().mockRejectedValueOnce(new Error('internal transport details')).mockResolvedValue({file})
 const api={list:vi.fn().mockResolvedValue({files:[],next:null}),get,versions:vi.fn().mockResolvedValue({versions:[version(51)]})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" targetFileId="file" onClose={vi.fn()} onAttachments={vi.fn()}/>)})
 const alert=renderer!.root.findByProps({role:'alert'})
 expect(alert.findByType('p').children).toContain('Could not open this file. Try again.')
 await act(async()=>{alert.findByType('button').props.onClick()})
 expect(get).toHaveBeenCalledTimes(2)
 expect(renderer!.root.findAllByProps({role:'alert'})).toHaveLength(0)
 expect(renderer!.root.findByType('h2').children).toContain('history.txt')
 await act(async()=>{renderer!.unmount()})
})

test('changing file type clears pagination and clearing the filter restores all files',async()=>{
 const api={list:vi.fn().mockResolvedValue({files:[file],next:{path:'history.txt',id:'file'}})} as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/>)})
 await act(async()=>{renderer!.root.findAllByType('button').find(b=>b.children.includes('Next'))!.props.onClick()})
 expect(vi.mocked(api.list).mock.calls.at(-1)?.[0].cursor).toBeTruthy()
 await act(async()=>{renderer!.root.findByProps({'aria-label':'File type'}).props.onChange({target:{value:'pdf'}})})
 expect(vi.mocked(api.list).mock.calls.at(-1)?.[0]).toMatchObject({type:'pdf'});expect(vi.mocked(api.list).mock.calls.at(-1)?.[0].cursor).toBeUndefined()
 await act(async()=>{renderer!.root.findByProps({'aria-label':'File type'}).props.onChange({target:{value:''}})})
 expect(vi.mocked(api.list).mock.calls.at(-1)?.[0].type).toBeUndefined()
 act(()=>renderer!.unmount())
})


test('file detail request flows through human approval queue to public link revocation',async()=>{
 let queueState:any=null
 const api={
  list:vi.fn().mockResolvedValue({files:[file],next:null}),
  versions:vi.fn().mockResolvedValue({versions:[version(51)]}),
  requestPublicShare:vi.fn().mockImplementation(async(fileId:string,versionNumber:number,expiresIn:number,allowDownload:boolean)=>{
   queueState={id:'request-1',fileId,filePath:file.path,scope:file.scope,version:versionNumber,currentVersion:versionNumber,contentHash:'a'.repeat(64),contentType:'text/plain',size:1,expiresAt:new Date(Date.now()+86400000).toISOString(),allowDownload,status:'pending',createdAt:new Date().toISOString(),requesterLogin:'maker',decisionAt:null,shareId:null,revokedAt:null,revokedBy:null}
   return {requestId:'request-1',status:'pending',fileId,version:versionNumber,contentHash:'a'.repeat(64),expiresAt:queueState.expiresAt,allowDownload}
  }),
  shareRequests:vi.fn().mockImplementation(async()=>({requests:queueState?[queueState]:[]})),
  approvePublicShare:vi.fn().mockImplementation(async()=>{
   queueState={...queueState,status:'approved',shareId:'share-1',decisionAt:new Date().toISOString()}
   return {shareId:'share-1',url:'/hx/public-file-shares/opaque-token',expiresAt:queueState.expiresAt,allowDownload:false}
  }),
  revokePublicShare:vi.fn().mockImplementation(async()=>{
   queueState={...queueState,revokedAt:new Date().toISOString(),revokedBy:'maker'}
   return {shareId:'share-1',revokedAt:queueState.revokedAt}
  }),
 } as unknown as WorkspaceFileApi
 let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilesPanel api={api} scope="workspace" onClose={vi.fn()} onAttachments={vi.fn()}/> )})
 await act(async()=>{renderer!.root.findByProps({className:'hx-file-row'}).props.onClick()})
 const requestButton=renderer!.root.findAllByType('button').find(button=>button.children.includes('Request approval'))
 expect(requestButton).toBeTruthy()
 await act(async()=>{requestButton!.props.onClick();await Promise.resolve()})
 expect(api.requestPublicShare).toHaveBeenCalledWith('file',51,604800,false)
 expect(JSON.stringify(renderer!.toJSON())).toContain('Approval request submitted.')
 await act(async()=>{renderer!.root.findByProps({className:'hx-files-share-open'}).props.onClick();await Promise.resolve()})
 expect(api.shareRequests).toHaveBeenCalled()
 const approveButton=renderer!.root.findAllByType('button').find(button=>button.children.includes('Approve and create link'))
 expect(approveButton).toBeTruthy()
 await act(async()=>{approveButton!.props.onClick();await Promise.resolve()})
 expect(api.approvePublicShare).toHaveBeenCalledWith('request-1')
 expect(JSON.stringify(renderer!.toJSON())).toContain('https://localhost/hx/public-file-shares/opaque-token')
 const revokeButton=renderer!.root.findAllByType('button').find(button=>button.children.includes('Revoke link'))
 expect(revokeButton).toBeTruthy()
 await act(async()=>{revokeButton!.props.onClick();await Promise.resolve()})
 expect(api.revokePublicShare).toHaveBeenCalledWith('share-1')
 expect(JSON.stringify(renderer!.toJSON())).toContain('Revoked')
 await act(async()=>renderer!.unmount())
})
