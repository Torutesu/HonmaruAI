import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {RoomCreateDialog} from './RoomCreateDialog'
import {Dialog} from './Dialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const people=[{id:'p1',kind:'person' as const,name:'Alice'},{id:'p2',kind:'person' as const,name:'Bob'},{id:'a1',kind:'agent' as const,name:'Assistant',selected:true}]
const button=(tree:ReturnType<typeof create>,name:string)=>tree.root.findAllByType('button').find(n=>n.children.includes(name))!
test('room creation keeps choices across steps and submits distinct human and agent identifiers',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomCreateDialog people={people} onCreate={save} onClose={vi.fn()}/>)})
 act(()=>tree.root.findAllByType('button').filter(n=>n.props['aria-pressed']!==undefined)[1].props.onClick())
 act(()=>button(tree,'Next').props.onClick())
 expect(button(tree,'Next').props.disabled).toBe(true)
 act(()=>tree.root.findByProps({id:'room-create-name'}).props.onChange({target:{value:'Planning'}}))
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Share useful context.'}}))
 act(()=>button(tree,'Next').props.onClick())
 act(()=>tree.root.findByProps({'aria-label':'Search members'}).props.onChange({target:{value:'Alice'}}))
 act(()=>tree.root.findAllByType('input').find(n=>n.props.type==='checkbox')!.props.onChange())
 act(()=>button(tree,'Back').props.onClick())
 expect(tree.root.findByProps({id:'room-create-name'}).props.value).toBe('Planning')
 act(()=>button(tree,'Next').props.onClick())
 await act(async()=>button(tree,'Create').props.onClick())
 expect(save).toHaveBeenCalledWith(expect.objectContaining({name:'Planning',private:true,guidelines:'Share useful context.',memberRefs:['p1'],agentIds:['a1'],color:'teal'}))
 act(()=>tree.unmount())
})
test('failed creation retains the draft and idempotency key while duplicate submits and closing are blocked',async()=>{
 let reject!:(e:Error)=>void;const save=vi.fn().mockImplementationOnce(()=>new Promise((_,r)=>{reject=r})).mockResolvedValue(undefined),close=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomCreateDialog people={people} onCreate={save} onClose={close}/>)})
 act(()=>button(tree,'Next').props.onClick())
 act(()=>tree.root.findByProps({id:'room-create-name'}).props.onChange({target:{value:'Retry room'}}))
 act(()=>button(tree,'Next').props.onClick())
 const submit=button(tree,'Create').props.onClick
 act(()=>{submit();submit()})
 expect(save).toHaveBeenCalledTimes(1)
 act(()=>tree.root.findByType(Dialog).props.onClose())
 expect(close).not.toHaveBeenCalled()
 await act(async()=>reject(new Error('Try again')))
 expect(tree.root.findByProps({role:'alert'}).children).toEqual(['Try again'])
 await act(async()=>button(tree,'Create').props.onClick())
 expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0])
 act(()=>tree.unmount())
})

test('editing a rejected draft creates a new operation rather than replaying old members',async()=>{
 const save=vi.fn().mockRejectedValue(new Error('Invalid draft'));let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomCreateDialog people={people} onCreate={save} onClose={vi.fn()}/>)})
 act(()=>button(tree,'Next').props.onClick())
 act(()=>tree.root.findByProps({id:'room-create-name'}).props.onChange({target:{value:'Initial'}}))
 act(()=>button(tree,'Next').props.onClick())
 await act(async()=>button(tree,'Create').props.onClick())
 act(()=>button(tree,'Back').props.onClick())
 act(()=>tree.root.findByProps({id:'room-create-name'}).props.onChange({target:{value:'Corrected'}}))
 act(()=>button(tree,'Next').props.onClick())
 await act(async()=>button(tree,'Create').props.onClick())
 expect(save.mock.calls[1][0].name).toBe('Corrected')
 expect(save.mock.calls[1][0].requestId).not.toBe(save.mock.calls[0][0].requestId)
 act(()=>tree.unmount())
})
