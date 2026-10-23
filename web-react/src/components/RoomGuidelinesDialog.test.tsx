import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {RoomGuidelinesDialog} from './RoomGuidelinesDialog'
import {Dialog} from './Dialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
const api={httpBase:'https://api.test',orgId:'org',sessionToken:'token'}
const reply=(body:any,status=200)=>({ok:status<400,status,json:async()=>body})
const loaded=(canEdit=true,body='Rules',version=3)=>reply({guidelines:{body,version},canEdit})
const button=(tree:ReturnType<typeof create>,name:string)=>tree.root.findAllByType('button').find(n=>n.children.includes(name))!
afterEach(()=>vi.unstubAllGlobals())
test('a pending save uses the reviewed revision, blocks duplicate submission and closing',async()=>{
 let finish!:(v:any)=>void;const fetch=vi.fn().mockResolvedValueOnce(loaded()).mockImplementationOnce(()=>new Promise(r=>finish=r));vi.stubGlobal('fetch',fetch)
 const close=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomGuidelinesDialog api={api} channel="b:room" onClose={close}/>)})
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'New rules'}}))
 const save=button(tree,'保存').props.onClick;act(()=>{save();save();tree.root.findByType(Dialog).props.onClose()})
 expect(fetch).toHaveBeenCalledTimes(2);expect(close).not.toHaveBeenCalled();expect(button(tree,'キャンセル').props.disabled).toBe(true)
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({orgId:'org',channel:'b:room',body:'New rules',version:3})
 await act(async()=>finish(reply({})));expect(close).toHaveBeenCalledOnce();act(()=>tree.unmount())
})
test('conflicts preserve input until explicit replacement; visitors cannot submit',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(loaded()).mockResolvedValueOnce(reply({},409)).mockResolvedValueOnce(loaded(false,'Other rules',4));vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<RoomGuidelinesDialog api={api} channel="b:room" onClose={()=>{}}/>)})
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'My draft'}}));await act(async()=>button(tree,'保存').props.onClick())
 expect(tree.root.findByType('textarea').props.value).toBe('My draft');expect(button(tree,'保存').props.disabled).toBe(true)
 await act(async()=>button(tree,'最新の内容に置き換える').props.onClick())
 expect(tree.root.findByType('textarea').props.value).toBe('Other rules');expect(tree.root.findByType('textarea').props.readOnly).toBe(true);act(()=>tree.unmount())
})
test('late saves cannot close a different room or unlock its pending save',async()=>{
 let first!:(v:any)=>void,second!:(v:any)=>void
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(loaded()).mockImplementationOnce(()=>new Promise(r=>first=r)).mockResolvedValueOnce(loaded()).mockImplementationOnce(()=>new Promise(r=>second=r)))
 const close=vi.fn();let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<RoomGuidelinesDialog api={api} channel="b:first" onClose={close}/>)})
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'First draft'}}));act(()=>button(tree,'保存').props.onClick())
 await act(async()=>tree.update(<RoomGuidelinesDialog api={api} channel="b:second" onClose={close}/>))
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Second draft'}}));act(()=>button(tree,'保存').props.onClick())
 await act(async()=>first(reply({})));act(()=>tree.root.findByType(Dialog).props.onClose());expect(close).not.toHaveBeenCalled()
 await act(async()=>second(reply({},503)));expect(tree.root.findByType('textarea').props.value).toBe('Second draft');expect(button(tree,'保存').props.disabled).toBe(false);act(()=>tree.unmount())
})
