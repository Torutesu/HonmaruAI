import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {DocumentCreate} from './DocumentCreate'
import type {WorkspaceFileApi} from '../utils/workspaceFiles'
vi.mock('../utils/i18n',()=>({useT:()=>((s:string)=>s)}))
vi.mock('./Icon',()=>({Icon:()=>null}))
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><div>{children}{footer}</div>}))
test('ready node required and failed admission retries reuse the same request ID',async()=>{
 const api={documentJobs:vi.fn().mockResolvedValue({jobs:[]}),documentNodes:vi.fn().mockRejectedValue(Error('not ready')),createDocument:vi.fn().mockRejectedValue(Error('offline'))} as unknown as WorkspaceFileApi
 let r:ReturnType<typeof create>;await act(async()=>{r=create(<DocumentCreate api={api} scope="b:room" onOpen={vi.fn()}/> )})
 const button=(text:string)=>r!.root.findAllByType('button').find(b=>b.children.includes(text))!
 await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()});expect(button('Create document').props.disabled).toBe(true)
 vi.mocked(api.documentNodes).mockResolvedValue({nodes:[{id:'node',name:'Mac mini'}]});await act(async()=>{button('Try again').props.onClick()});expect(r!.root.findAllByProps({role:'alert'})).toHaveLength(0)
 await act(async()=>{r!.root.findByType('input').props.onChange({target:{value:'Report'}});r!.root.findByType('textarea').props.onChange({target:{value:'# Hello'}})})
 await act(async()=>{button('Create document').props.onClick()});await act(async()=>{button('Create document').props.onClick()})
 expect(api.createDocument).toHaveBeenCalledTimes(2);expect(vi.mocked(api.createDocument).mock.calls[0][0]).toEqual(vi.mocked(api.createDocument).mock.calls[1][0]);expect(vi.mocked(api.createDocument).mock.calls[0][0].path).toBe('Report.pdf')
 act(()=>r!.unmount())
})
test('queued conversion polls until saved and opens returned file',async()=>{
 vi.useFakeTimers();const onOpen=vi.fn()
 const api={documentJobs:vi.fn().mockResolvedValue({jobs:[]}),documentNodes:vi.fn().mockResolvedValue({nodes:[{id:'node',name:'Mac mini'}]}),createDocument:vi.fn().mockResolvedValue({job:{id:'job',status:'queued',path:'Report.pdf'}}),documentJob:vi.fn().mockResolvedValue({job:{id:'job',status:'succeeded',path:'Report.pdf',fileId:'file-id',version:1}})} as unknown as WorkspaceFileApi
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
 const api={documentJobs:vi.fn().mockResolvedValue({jobs:[]}),documentNodes:vi.fn().mockResolvedValue({nodes:[]}),createDocument:vi.fn(),documentJob:vi.fn().mockResolvedValue({job:{id,status:'succeeded',path:'Recovered.pdf',fileId:'file-id',version:1}})} as unknown as WorkspaceFileApi
 let r:ReturnType<typeof create>;await act(async()=>{r=create(<DocumentCreate api={api} scope="b:room" receiptKey="account/room" onOpen={vi.fn()}/> )})
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000)});expect(api.createDocument).not.toHaveBeenCalled();expect(api.documentJob).toHaveBeenCalledWith(id,expect.any(AbortSignal))
 await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()});expect(r!.root.findAllByType('strong').some(n=>n.children.includes('Recovered.pdf'))).toBe(true)
 act(()=>r!.unmount());vi.unstubAllGlobals();vi.useRealTimers()
})
test('reopening progress retries a failed status read without requiring available nodes',async()=>{
 vi.useFakeTimers();const id='12345678-1234-1234-1234-123456789012'
 vi.stubGlobal('sessionStorage',{getItem:()=>id,setItem:()=>{},removeItem:()=>{}})
 const api={documentJobs:vi.fn().mockResolvedValue({jobs:[]}),documentNodes:vi.fn().mockRejectedValue(Error('nodes unavailable')),createDocument:vi.fn(),documentJob:vi.fn().mockRejectedValueOnce(Error('status offline')).mockResolvedValue({job:{id,status:'succeeded',path:'Recovered.pdf',fileId:'file-id',version:1}})} as unknown as WorkspaceFileApi
 let r:ReturnType<typeof create>;await act(async()=>{r=create(<DocumentCreate api={api} scope="b:room" receiptKey="account/room" onOpen={vi.fn()}/> )})
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
 await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()});await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
 expect(api.documentNodes).not.toHaveBeenCalled();expect(api.documentJob).toHaveBeenCalledTimes(2);expect(api.createDocument).not.toHaveBeenCalled()
 expect(r!.root.findAllByType('strong').some(n=>n.children.includes('Recovered.pdf'))).toBe(true)
 act(()=>r!.unmount());vi.unstubAllGlobals();vi.useRealTimers()
})

test.each(['failed','cancelled'])('restored %s receipt offers explicit new-document form instead of blind resubmission',async status=>{
 vi.useFakeTimers();const id='12345678-1234-1234-1234-123456789012';
 vi.stubGlobal('sessionStorage',{getItem:()=>id,setItem:()=>{},removeItem:()=>{}});
 const api={documentJobs:vi.fn().mockResolvedValue({jobs:[]}),documentNodes:vi.fn().mockResolvedValue({nodes:[{id:'node',name:'Mac mini'}]}),createDocument:vi.fn(),documentJob:vi.fn().mockResolvedValue({job:{id,status,path:'Previous.pdf',fileId:null,version:null}})} as unknown as WorkspaceFileApi;
 let r:ReturnType<typeof create>;
 try {
  await act(async()=>{r=create(<DocumentCreate api={api} scope="b:room" receiptKey="account/room" onOpen={vi.fn()}/>)});
  await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick();await vi.advanceTimersByTimeAsync(1000)});
  const button=(text:string)=>r!.root.findAllByType('button').find(b=>b.children.includes(text));
  expect(button('Close')).toBeTruthy();expect(button('Create document')).toBeUndefined();
  await act(async()=>{button('Create another document')!.props.onClick()});
  expect(r!.root.findByType('input').props.value).toBe('');
  expect(button('Create document')!.props.disabled).toBe(true);
  expect(api.documentNodes).toHaveBeenCalledTimes(1);expect(api.createDocument).not.toHaveBeenCalled();
 } finally {act(()=>r!.unmount());vi.unstubAllGlobals();vi.useRealTimers()}
});

test('recent conversion from another entry point opens saved progress without resubmitting',async()=>{
 const job={id:'12345678-1234-1234-1234-123456789012',status:'succeeded',path:'Agent report.pdf',fileId:'file-agent',version:1};
 const onOpen=vi.fn(),api={documentJobs:vi.fn().mockResolvedValue({jobs:[job]}),documentNodes:vi.fn().mockResolvedValue({nodes:[]}),createDocument:vi.fn()} as unknown as WorkspaceFileApi;
 let r:ReturnType<typeof create>;
 await act(async()=>{r=create(<DocumentCreate api={api} scope="ag:writer|me" onOpen={onOpen}/>)});
 await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()});
 await act(async()=>{r!.root.findByProps({'aria-pressed':false}).props.onClick()});
 expect(r!.root.findByType('strong').children).toContain('Agent report.pdf');
 await act(async()=>{r!.root.findAllByType('button').find(b=>b.children.includes('Open file'))!.props.onClick()});
 expect(onOpen).toHaveBeenCalledWith('file-agent');expect(api.createDocument).not.toHaveBeenCalled();act(()=>r!.unmount());
});

test('visible history refreshes external jobs and clears inaccessible stale results',async()=>{
 vi.useFakeTimers();const job={id:'12345678-1234-1234-1234-123456789012',status:'queued',path:'Later.pdf',fileId:null,version:null};
 const api={documentJobs:vi.fn().mockResolvedValueOnce({jobs:[]}).mockResolvedValueOnce({jobs:[job]}).mockRejectedValue(Error('access changed')),documentNodes:vi.fn().mockResolvedValue({nodes:[]})} as unknown as WorkspaceFileApi;
 let r:ReturnType<typeof create>;
 try{
  await act(async()=>{r=create(<DocumentCreate api={api} scope="workspace" onOpen={vi.fn()}/>)});
  await act(async()=>{r!.root.findByProps({'aria-label':'Create document'}).props.onClick()});
  expect(r!.root.findAllByProps({'aria-pressed':false})).toHaveLength(0);
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});
  expect(r!.root.findAllByProps({'aria-pressed':false})).toHaveLength(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});
  expect(r!.root.findAllByProps({'aria-pressed':false})).toHaveLength(0);
  expect(r!.root.findAllByType('p').some(p=>p.children.includes('Could not load recent documents.'))).toBe(true);
  act(()=>r!.unmount());const count=vi.mocked(api.documentJobs).mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);expect(api.documentJobs).toHaveBeenCalledTimes(count);
 }finally{vi.useRealTimers()}
});
