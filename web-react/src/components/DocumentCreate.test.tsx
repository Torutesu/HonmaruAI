import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {DocumentCreate} from './DocumentCreate'
import type {WorkspaceFileApi} from '../utils/workspaceFiles'
vi.mock('../utils/i18n',()=>({useT:()=>((s:string)=>s)}))
vi.mock('./Icon',()=>({Icon:()=>null}))
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><div>{children}{footer}</div>}))
test('ready node required and failed admission retries reuse the same request ID',async()=>{
 const api={documentNodes:vi.fn().mockRejectedValue(Error('not ready')),createDocument:vi.fn().mockRejectedValue(Error('offline'))} as unknown as WorkspaceFileApi
 let r:ReturnType<typeof create>;await act(async()=>{r=create(<DocumentCreate api={api} scope="b:room" onOpen={vi.fn()}/> )})
 const button=(text:string)=>r!.root.findAllByType('button').find(b=>b.children.includes(text))!
 await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()});expect(button('Create document').props.disabled).toBe(true)
 vi.mocked(api.documentNodes).mockResolvedValue({nodes:[{id:'node',name:'Mac mini'}]});await act(async()=>{button('Retry').props.onClick()});expect(r!.root.findAllByProps({role:'alert'})).toHaveLength(0)
 await act(async()=>{r!.root.findByType('input').props.onChange({target:{value:'Report'}});r!.root.findByType('textarea').props.onChange({target:{value:'# Hello'}})})
 await act(async()=>{button('Create document').props.onClick()});await act(async()=>{button('Create document').props.onClick()})
 expect(api.createDocument).toHaveBeenCalledTimes(2);expect(vi.mocked(api.createDocument).mock.calls[0][0]).toEqual(vi.mocked(api.createDocument).mock.calls[1][0]);expect(vi.mocked(api.createDocument).mock.calls[0][0].path).toBe('Report.pdf')
 act(()=>r!.unmount())
})
test('queued conversion polls until saved and opens returned file',async()=>{
 vi.useFakeTimers();const onOpen=vi.fn()
 const api={documentNodes:vi.fn().mockResolvedValue({nodes:[{id:'node',name:'Mac mini'}]}),createDocument:vi.fn().mockResolvedValue({job:{id:'job',status:'queued',path:'Report.pdf'}}),documentJob:vi.fn().mockResolvedValue({job:{id:'job',status:'succeeded',path:'Report.pdf',fileId:'file-id',version:1}})} as unknown as WorkspaceFileApi
 let r:ReturnType<typeof create>;await act(async()=>{r=create(<DocumentCreate api={api} scope="b:room" onOpen={onOpen}/> )})
 const button=(text:string)=>r!.root.findAllByType('button').find(b=>b.children.includes(text))!
 await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()})
 await act(async()=>{r!.root.findByType('input').props.onChange({target:{value:'Report'}});r!.root.findByType('textarea').props.onChange({target:{value:'Hello'}})})
 await act(async()=>{button('Create document').props.onClick()});expect(button('Cancel conversion')).toBeTruthy()
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000)});await act(async()=>{button('Open file').props.onClick()});expect(onOpen).toHaveBeenCalledWith('file-id')
 act(()=>r!.unmount());vi.useRealTimers()
})
test('restored receipt fetches server status without creating another conversion',async()=>{
 vi.useFakeTimers();const id='12345678-1234-1234-1234-123456789012',map=new Map([['honmaru-document-receipt:account/room',id]])
 vi.stubGlobal('sessionStorage',{getItem:(k:string)=>map.get(k)||null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)})
 const api={documentNodes:vi.fn().mockResolvedValue({nodes:[]}),createDocument:vi.fn(),documentJob:vi.fn().mockResolvedValue({job:{id,status:'succeeded',path:'Recovered.pdf',fileId:'file-id',version:1}})} as unknown as WorkspaceFileApi
 let r:ReturnType<typeof create>;await act(async()=>{r=create(<DocumentCreate api={api} scope="b:room" receiptKey="account/room" onOpen={vi.fn()}/> )})
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000)});expect(api.createDocument).not.toHaveBeenCalled();expect(api.documentJob).toHaveBeenCalledWith(id,expect.any(AbortSignal))
 await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()});expect(r!.root.findAllByType('strong').some(n=>n.children.includes('Recovered.pdf'))).toBe(true)
 act(()=>r!.unmount());vi.unstubAllGlobals();vi.useRealTimers()
})
