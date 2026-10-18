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
