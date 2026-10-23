import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi,afterEach} from 'vitest'
import {RoomJoinDialog} from './RoomJoinDialog'
import {Dialog} from './Dialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
afterEach(()=>vi.unstubAllGlobals())
const api={httpBase:'https://example.test',orgId:'team',sessionToken:'test'}
const rooms=[{channel:'b:planning',name:'Planning',joined:false,memberCount:2},{channel:'b:general',name:'General',joined:true,memberCount:3}]
const response=(body:unknown,ok=true)=>({ok,json:async()=>body})
test('search filters unjoined rooms and excludes rooms already joined',async()=>{
 const fetch=vi.fn().mockResolvedValue(response({rooms}));vi.stubGlobal('fetch',fetch)
 const joined=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomJoinDialog api={api} onClose={vi.fn()} onJoined={joined}/>)})
 expect(tree.root.findAllByType('li')).toHaveLength(1)
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'general'}}))
 expect(tree.root.findAllByType('li')).toHaveLength(0)
 expect(joined).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1)
 act(()=>tree.unmount())
})
test('failed joining preserves the search and offers retry; pending cannot duplicate or close',async()=>{
 let resolve!:(r:unknown)=>void
 const fetch=vi.fn().mockResolvedValueOnce(response({rooms})).mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValue(response({joined:true}))
 vi.stubGlobal('fetch',fetch);const joined=vi.fn(),close=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomJoinDialog api={api} onClose={close} onJoined={joined}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'plan'}}))
 const click=tree.root.findAllByType('button').find(b=>b.children.includes('Join'))!.props.onClick
 act(()=>{click();click()})
 expect(fetch).toHaveBeenCalledTimes(2)
 act(()=>tree.root.findByType(Dialog).props.onClose());expect(close).not.toHaveBeenCalled()
 await act(async()=>resolve(response({message:'Room is private'},false)))
 expect(tree.root.findByProps({role:'alert'}).children).toContain('Room is private')
 expect(tree.root.findByType('input').props.value).toBe('plan')
 await act(async()=>tree.root.findAllByType('button').find(b=>b.children.includes('Join'))!.props.onClick())
 expect(joined).toHaveBeenCalledWith('b:planning')
 expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({orgId:'team',channel:'b:planning'})
 act(()=>tree.unmount())
})
test('completion after closing the workspace cannot navigate the next workspace',async()=>{
 let resolve!:(r:unknown)=>void
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response({rooms})).mockImplementationOnce(()=>new Promise(r=>{resolve=r})))
 const joined=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomJoinDialog api={api} onClose={vi.fn()} onJoined={joined}/>)})
 act(()=>tree.root.findAllByType('button').find(b=>b.children.includes('Join'))!.props.onClick())
 act(()=>tree.unmount())
 await act(async()=>resolve(response({joined:true})))
 expect(joined).not.toHaveBeenCalled()
})
