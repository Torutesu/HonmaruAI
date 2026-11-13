import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {RoomMemberPicker} from './RoomMemberPicker'
import {Dialog} from './Dialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const base={onClose:vi.fn(),onInvite:vi.fn(),onReload:vi.fn(),onAdd:vi.fn()}
test('empty candidate list has workspace invitation rather than a misleading search failure',()=>{
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomMemberPicker {...base} candidates={[]}/>)})
 expect(tree.root.findAllByType('input')).toHaveLength(0)
 expect(tree.root.findByType('p').children).toEqual(['There are no eligible people or agents to add. Invite workspace members or ask an agent owner to share access.'])
 act(()=>tree.root.findByType('button').props.onClick());expect(base.onInvite).toHaveBeenCalledOnce()
 act(()=>tree.unmount())
})
test('retains selections on failure, prevents duplicate submits and blocks closing while pending',async()=>{
 let reject!:(reason:Error)=>void
 const add=vi.fn(()=>new Promise<void>((_,r)=>{reject=r})),close=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMemberPicker {...base} onAdd={add} onClose={close} candidates={[{id:'a',kind:'agent',name:'Assistant'}]}/>)})
 act(()=>tree.root.findByProps({type:'checkbox'}).props.onChange())
 const send=tree.root.findByType('button').props.onClick
 act(()=>{send();send()});expect(add).toHaveBeenCalledOnce()
 act(()=>tree.root.findByType(Dialog).props.onClose());expect(close).not.toHaveBeenCalled()
 await act(async()=>reject(new Error('Conflict')))
 expect(tree.root.findByProps({role:'alert'}).children).toEqual(['Conflict'])
 expect(tree.root.findByProps({type:'checkbox'}).props.checked).toBe(true)
 act(()=>tree.unmount())
})
test('an agent grant can target only explicitly selected room members',()=>{
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomMemberPicker {...base} candidates={[{id:'agent',kind:'agent',name:'Agent',missingAccessMembers:[{id:'ref-a',name:'A'},{id:'ref-b',name:'B'}],canGrantAccess:true}]}/>)})
 const checks=tree.root.findAllByProps({type:'checkbox'})
 act(()=>checks[0].props.onChange())
 const memberChecks=tree.root.findAllByProps({type:'checkbox'}).slice(1)
 act(()=>memberChecks[0].props.onChange())
 const button=tree.root.findByType('button')
 act(()=>{void button.props.onClick()})
 expect(base.onAdd).toHaveBeenCalledWith([expect.objectContaining({id:'agent',grantAccessTo:['ref-a']})])
 act(()=>tree.unmount())
})
