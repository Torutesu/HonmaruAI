import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {WorkspaceFilePreview} from './WorkspaceFilePreview'
import type {WorkspaceFileApi,FileVersion,WorkspaceFile} from '../utils/workspaceFiles'
vi.mock('../utils/i18n',()=>{const t=(text:string)=>text;return {useT:()=>t}})
vi.mock('./Dialog',()=>({Dialog:({children}:React.PropsWithChildren)=>children}))
vi.mock('./DocumentPreview',()=>({DocumentContent:({bytes}:{bytes:Uint8Array})=><pre>{new TextDecoder().decode(bytes)}</pre>}))
const file={id:'file',path:'report.txt'} as WorkspaceFile
const version={version:2,contentType:'text/plain',size:10} as FileVersion

test('oversized previews do not fetch protected content',async()=>{
 const api={download:vi.fn()} as unknown as WorkspaceFileApi;let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilePreview api={api} file={file} version={{...version,size:3*1024*1024}} onClose={vi.fn()}/> )})
 expect(api.download).not.toHaveBeenCalled();expect(JSON.stringify(renderer!.toJSON())).toContain('too large');act(()=>renderer!.unmount())
})
test('closing a preview aborts its exact-version download',async()=>{
 const api={download:vi.fn(()=>new Promise(()=>{}))} as unknown as WorkspaceFileApi;let renderer:ReturnType<typeof create>
 await act(async()=>{renderer=create(<WorkspaceFilePreview api={api} file={file} version={version} onClose={vi.fn()}/> )})
 const [id,revision,signal]=vi.mocked(api.download).mock.calls[0];expect([id,revision]).toEqual(['file',2]);expect(signal?.aborted).toBe(false)
 act(()=>renderer!.unmount());expect(signal?.aborted).toBe(true)
})

test('raster preview releases its object URL and displays decode failures',async()=>{
 const createUrl=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:preview'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
 const api={download:vi.fn().mockResolvedValue(new Blob(['invalid image']))} as unknown as WorkspaceFileApi;let renderer:ReturnType<typeof create>
 try{
  await act(async()=>{renderer=create(<WorkspaceFilePreview api={api} file={file} version={{...version,contentType:'image/png'}} onClose={vi.fn()}/> )})
  expect(renderer!.root.findByType('img').props.src).toBe('blob:preview')
  act(()=>renderer!.root.findByType('img').props.onError())
  expect(JSON.stringify(renderer!.toJSON())).toContain('Preview could not be displayed.');expect(revoke).toHaveBeenCalledWith('blob:preview')
  act(()=>renderer!.unmount())
 }finally{createUrl.mockRestore();revoke.mockRestore()}
})
