import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {RoomThreadDirectory} from './RoomThreadDirectory'
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'test-token'}
const item=(id:string)=>({parent:{id,body:id,authorName:'Toru',createdAt:'2026-01-01T00:00:00.000Z'},replies:[],replyCount:0,lastReplyAt:'2026-01-01T00:00:00.000Z',unread:false})
const ok=(threads:any[],nextCursor:any=null)=>({ok:true,json:async()=>({threads,nextCursor})})
function globals(){vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()})}
afterEach(()=>vi.unstubAllGlobals())
test('expands room roots, pages without duplicates, and opens the selected root as a thread',async()=>{
 globals();const fetch=vi.fn().mockResolvedValueOnce(ok([item('first')],{before:'2026-01-01T00:00:00.000Z',beforeId:'first'})).mockResolvedValueOnce(ok([item('first'),item('second')]));vi.stubGlobal('fetch',fetch)
 const onOpen=vi.fn();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomThreadDirectory api={api} channel="b:general" name="general" selected={false} onOpen={onOpen}><li>general</li></RoomThreadDirectory>)})
 expect(fetch).not.toHaveBeenCalled()
 await act(async()=>tree!.root.findByProps({'aria-label':'generalを展開'}).props.onClick())
 expect(fetch.mock.calls[0][0]).toContain('channel=b%3Ageneral')
 await act(async()=>tree!.root.findByProps({className:'hx-room-thread-more'}).props.onClick())
 expect(fetch.mock.calls[1][0]).toContain('beforeId=first')
 const buttons=tree!.root.findAllByProps({className:'hx-room-thread'});expect(buttons).toHaveLength(2)
 act(()=>buttons[1].props.onClick());expect(onOpen).toHaveBeenCalledWith('second');act(()=>tree!.unmount())
})
test('late data after a scope change or collapse does not repopulate the room',async()=>{
 globals();let resolve!:(data:any)=>void
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValue(ok([item('new-workspace')]))
 vi.stubGlobal('fetch',fetch);let tree:ReturnType<typeof create>
 const render=(orgId:string)=><RoomThreadDirectory api={{...api,orgId}} channel="b:general" name="general" selected onOpen={()=>{}}><li>general</li></RoomThreadDirectory>
 await act(async()=>{tree=create(render('team:old'))})
 await act(async()=>tree!.update(render('team:new')))
 await act(async()=>resolve(ok([item('private-old-workspace')])))
 expect(JSON.stringify(tree!.toJSON())).not.toContain('private-old-workspace')
 expect(JSON.stringify(tree!.toJSON())).toContain('new-workspace')
 act(()=>tree!.root.findByProps({'aria-label':'generalを折りたたむ'}).props.onClick())
 expect(tree!.root.findAllByProps({className:'hx-room-thread'})).toHaveLength(0);act(()=>tree!.unmount())
})

test('read events retain revealed pages and ignore unrelated rooms',async()=>{
 vi.useFakeTimers()
 const listeners=new Map<string,(event:any)=>void>()
 vi.stubGlobal('window',{addEventListener:(type:string,fn:any)=>listeners.set(type,fn),removeEventListener:(type:string)=>listeners.delete(type)})
 const cursor={before:'2026-01-01T00:00:00.000Z',beforeId:'first'}
 const fetch=vi.fn().mockResolvedValueOnce(ok([item('first')],cursor)).mockResolvedValueOnce(ok([item('second')]))
  .mockResolvedValueOnce(ok([item('first')],cursor)).mockResolvedValueOnce(ok([{...item('second'),unread:false}]))
 vi.stubGlobal('fetch',fetch);let tree:ReturnType<typeof create>
 try {
  await act(async()=>{tree=create(<RoomThreadDirectory api={api} channel="b:general" name="general" selected activeId="second" onOpen={()=>{}}><li>general</li></RoomThreadDirectory>)})
  await act(async()=>tree!.root.findByProps({className:'hx-room-thread-more'}).props.onClick())
  await act(async()=>{listeners.get('honmaru:reads-changed')!({detail:{view:'b:other',thread:'unrelated'}});await vi.advanceTimersByTimeAsync(300)})
  expect(fetch).toHaveBeenCalledTimes(2)
  await act(async()=>{listeners.get('honmaru:reads-changed')!({detail:{view:'b:general',thread:'second'}});await vi.advanceTimersByTimeAsync(300)})
  expect(fetch).toHaveBeenCalledTimes(4)
  expect(tree!.root.findAllByProps({className:'hx-room-thread'})).toHaveLength(2)
  expect(tree!.root.findByProps({'aria-current':'page'}).findByType('strong').children).toEqual(['second'])
 } finally {act(()=>tree!.unmount());vi.useRealTimers()}
})

test('a thread opened from a link reveals its room without reopening a manual collapse on unrelated renders',async()=>{
 globals();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok([item('root')])));let tree:ReturnType<typeof create>
 const render=(selected:boolean,activeId?:string)=><RoomThreadDirectory api={api} channel="b:general" name="general" selected={selected} activeId={activeId} onOpen={()=>{}}><li>general</li></RoomThreadDirectory>
 await act(async()=>{tree=create(render(false))});await act(async()=>tree!.update(render(true,'root')))
 expect(tree!.root.findByProps({'aria-label':'generalを折りたたむ'})).toBeTruthy()
 act(()=>tree!.root.findByProps({'aria-label':'generalを折りたたむ'}).props.onClick());await act(async()=>tree!.update(render(true,'root')))
 expect(tree!.root.findByProps({'aria-label':'generalを展開'})).toBeTruthy();act(()=>tree!.unmount())
})
