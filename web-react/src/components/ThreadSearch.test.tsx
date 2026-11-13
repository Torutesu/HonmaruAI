import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ThreadSearch} from './ThreadSearch'
import {hashForApp} from '../utils/route'
import {openFileConversation} from '../utils/fileConversation'
vi.mock('../utils/fileConversation',()=>({openFileConversation:vi.fn()}))
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
const result=(id:string,cursor:string|null=null)=>({ok:true,json:async()=>({messages:[{id,body:id,createdAt:'2026-10-20T00:00:00Z'}],nextCursor:cursor})})
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
test('Harness room search requests and opens room-local files and linked App records',async()=>{
 vi.useFakeTimers();vi.stubGlobal('location',{hash:''})
 vi.mocked(openFileConversation).mockResolvedValue('#/c/b%3Ageneral?org=team%3Atest')
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({messages:[{id:'message-1',body:'needle',createdAt:'2026-10-20T00:00:00Z'}],nextCursor:null,
  files:[{id:'file-1',name:'Notes.md',scope:'b:general',snippet:'needle in the room notes'}],
  records:[{id:'row-1',rowId:'row-1',appId:'app-1',appName:'Projects',tableId:'table-1',tableName:'Tasks',snippet:'Title: needle task'}]})})
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" onClose={()=>{}} onSelect={()=>{}}/>)} )
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'needle'}}))
 await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
 expect(new URL(fetch.mock.calls[0][0]).searchParams.get('resources')).toBe('1')
 expect(tree.root.findByProps({'aria-label':'ファイルを開く: Notes.md'})).toBeTruthy()
 expect(tree.root.findByProps({'aria-label':'レコードを開く: Projects · Tasks'})).toBeTruthy()
 act(()=>tree.root.findByProps({'aria-label':'レコードを開く: Projects · Tasks'}).props.onClick())
 expect(location.hash).toBe(hashForApp('app-1',api.orgId,{tableId:'table-1',rowId:'row-1'},'data'))
 await act(async()=>{await tree.root.findByProps({'aria-label':'ファイルを開く: Notes.md'}).props.onClick()})
 expect(openFileConversation).toHaveBeenCalledWith('file-1')
 expect(location.hash).toBe('#/c/b%3Ageneral?org=team%3Atest')
 act(()=>tree.unmount())
})
test('room resource results load more independently without replacing the other result set or cursor',async()=>{
 vi.useFakeTimers();vi.stubGlobal('location',{hash:''})
 const file=(id:string)=>({id,name:`${id}.md`,scope:'b:general',snippet:`needle in ${id}`})
 const record=(id:string)=>({id,rowId:id,appId:'app-1',appName:'Projects',tableId:'table-1',tableName:'Tasks',snippet:`Title: needle ${id}`})
 const first={messages:[],nextCursor:null,files:[file('file-1')],records:[record('row-1')],filesTruncated:true,recordsTruncated:true,filesNextCursor:'file-page-2',recordsNextCursor:'record-page-2'}
 const filePage={messages:[],nextCursor:null,files:[file('file-2')],records:[],filesTruncated:false,recordsTruncated:false,filesNextCursor:null,recordsNextCursor:null}
 const recordPage={messages:[],nextCursor:null,files:[],records:[record('row-2')],filesTruncated:false,recordsTruncated:false,filesNextCursor:null,recordsNextCursor:null}
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>first}).mockResolvedValueOnce({ok:true,json:async()=>filePage}).mockResolvedValueOnce({ok:true,json:async()=>recordPage});vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" onClose={()=>{}} onSelect={()=>{}}/>)} )
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'needle'}}));await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
 const moreButtons=()=>tree.root.findAllByProps({className:'hx-thread-search-more'})
 expect(moreButtons()).toHaveLength(2)
 await act(async()=>moreButtons()[0].props.onClick())
 const fileRequest=new URL(fetch.mock.calls[1][0]);expect(fileRequest.searchParams.get('fileCursor')).toBe('file-page-2');expect(fileRequest.searchParams.get('skipRecords')).toBe('1');expect(fileRequest.searchParams.has('recordCursor')).toBe(false)
 expect(tree.root.findByProps({'aria-label':'ファイルを開く: file-2.md'})).toBeTruthy();expect(tree.root.findByProps({'aria-label':'レコードを開く: Projects · Tasks'})).toBeTruthy()
 expect(moreButtons()).toHaveLength(1)
 await act(async()=>moreButtons()[0].props.onClick())
 const recordRequest=new URL(fetch.mock.calls[2][0]);expect(recordRequest.searchParams.get('recordCursor')).toBe('record-page-2');expect(recordRequest.searchParams.get('skipFiles')).toBe('1');expect(recordRequest.searchParams.has('fileCursor')).toBe(false)
 expect(tree.root.findByProps({'aria-label':'ファイルを開く: file-1.md'})).toBeTruthy();expect(tree.root.findByProps({'aria-label':'ファイルを開く: file-2.md'})).toBeTruthy();expect(tree.root.findAll(node=>node.props['aria-label']?.startsWith('レコードを開く:'))).toHaveLength(2)
 expect(moreButtons()).toHaveLength(0)
 act(()=>tree.unmount())
})
test('query changes abort old searches and discard delayed results',async()=>{
 vi.useFakeTimers();let resolve!:(value:any)=>void
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValueOnce(result('new'));vi.stubGlobal('fetch',fetch)
 const select=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" threadId="root" onClose={()=>{}} onSelect={select}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'old'}}));await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'new'}}));expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
 await act(async()=>{await vi.advanceTimersByTimeAsync(250)});await act(async()=>resolve(result('old')))
 expect(select.mock.calls.map(call=>call[0].id)).toEqual(['new']);act(()=>tree.unmount())
})
test('collects every page and navigates older and newer matches without closing',async()=>{
 vi.useFakeTimers();const fetch=vi.fn().mockResolvedValueOnce(result('newest','31')).mockResolvedValueOnce(result('older'));vi.stubGlobal('fetch',fetch)
 const select=vi.fn(),close=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" threadId="root" onClose={close} onSelect={select}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'needle'}}));await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
 expect(fetch.mock.calls[1][0]).toContain('before=31');expect(select.mock.calls[0][0].id).toBe('newest')
 await act(async()=>tree.root.findByProps({'aria-label':'前の結果へ'}).props.onClick());expect(select.mock.calls.at(-1)![0].id).toBe('older')
 await act(async()=>tree.root.findByProps({'aria-label':'新しい結果へ'}).props.onClick());expect(select.mock.calls.at(-1)![0].id).toBe('newest')
 expect(close).not.toHaveBeenCalled();act(()=>tree.unmount())
})
test('room search uses the exact room endpoint and aborts navigation when closed',async()=>{
 vi.useFakeTimers();const fetch=vi.fn().mockResolvedValue(result('match'));vi.stubGlobal('fetch',fetch)
 const select=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:private" onClose={()=>{}} onSelect={select}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'needle'}}))
 await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
 const url=new URL(fetch.mock.calls[0][0]);expect(url.pathname).toBe('/channels/room/search');expect(url.searchParams.get('channel')).toBe('b:private');expect(url.searchParams.has('messageId')).toBe(false)
 expect(tree.root.findByType('input').props['aria-label']).toBe('ルーム内の検索語')
 const signal=select.mock.calls[0][1];expect(signal.aborted).toBe(false);act(()=>tree.unmount());expect(signal.aborted).toBe(true)
})
