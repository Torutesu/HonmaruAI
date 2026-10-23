import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {RoomMembersDialog,type RoomMemberRow} from './RoomMembersDialog'
import {Dialog} from './Dialog'
vi.mock('./Dialog',()=>({Dialog:({children}:any)=><section>{children}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const member:RoomMemberRow={id:'a',kind:'agent',name:'Assistant',role:'admin',canChangeRole:true,canRemove:true}
const base={members:[member],onReload:vi.fn(),onProfile:vi.fn(),onRole:vi.fn(),onRemove:vi.fn(),onClose:vi.fn()}
test('read-only participants have no action menu or add control',()=>{
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomMembersDialog {...base} members={[{...member,canChangeRole:false,canRemove:false}]}/> )})
 expect(tree.root.findAllByType('button')).toHaveLength(1)
 act(()=>tree.unmount())
})
test('failed role changes keep the menu open, preserve roles and permit a retry',async()=>{
 let reject!:(error:Error)=>void;const change=vi.fn(()=>new Promise<void>((_,r)=>{reject=r}));let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomMembersDialog {...base} onRole={change}/> )})
 act(()=>tree.root.findByProps({'aria-expanded':false}).props.onClick())
 const menu=tree.root.findByProps({'aria-label':'Room member actions'})
 const setMember=menu.findAllByType('button')[1].props.onClick
 act(()=>{setMember();setMember()});expect(change).toHaveBeenCalledTimes(1)
 expect(change).toHaveBeenCalledWith(member,'member')
 act(()=>tree.root.findByType(Dialog).props.onClose());expect(base.onClose).not.toHaveBeenCalled()
 await act(async()=>reject(new Error('Reload before saving.')))
 expect(tree.root.findByProps({role:'alert'}).children).toEqual(['Reload before saving.'])
 expect(tree.root.findByProps({'aria-expanded':true})).toBeTruthy()
 act(()=>tree.root.findByType(Dialog).props.onClose())
 expect(tree.root.findByProps({'aria-expanded':false})).toBeTruthy()
 act(()=>tree.unmount())
})
