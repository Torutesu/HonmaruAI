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
 act(()=>tree.root.findByProps({'aria-expanded':false}).props.onClick({currentTarget:{focus:vi.fn()}}))
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

test('keeps the menu in the viewport, supports keyboard navigation and releases document listeners',()=>{
 const listeners=new Map<string,Function>(),windowListeners=new Map<string,Function>()
 const first={focus:vi.fn()},last={focus:vi.fn()},anchor={focus:vi.fn(),contains:vi.fn(()=>false),getBoundingClientRect:()=>({right:390,top:280,bottom:310})}
 const popup={offsetWidth:168,offsetHeight:120,style:{} as Record<string,string>,contains:vi.fn(()=>false),querySelector:()=>first,querySelectorAll:()=>[first,last]}
 vi.stubGlobal('document',{activeElement:first,addEventListener:(name:string,fn:Function)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)})
 vi.stubGlobal('window',{innerWidth:400,innerHeight:350,addEventListener:(name:string,fn:Function)=>windowListeners.set(name,fn),removeEventListener:(name:string)=>windowListeners.delete(name)})
 let tree!:ReturnType<typeof create>
 try{
  act(()=>{tree=create(<RoomMembersDialog {...base}/>,{createNodeMock:element=>element.props.className==='room-members-menu'?popup:null})})
  act(()=>tree.root.findByProps({'aria-expanded':false}).props.onClick({currentTarget:anchor}))
  expect(popup.style).toEqual({left:'222px',top:'156px'})
  expect(first.focus).toHaveBeenCalledOnce()
  const preventDefault=vi.fn()
  act(()=>tree.root.findByProps({'aria-label':'Room member actions'}).props.onKeyDown({key:'End',currentTarget:popup,preventDefault}))
  expect(last.focus).toHaveBeenCalledOnce();expect(preventDefault).toHaveBeenCalledOnce()
  act(()=>listeners.get('pointerdown')!({target:{}}))
  expect(tree.root.findByProps({'aria-expanded':false})).toBeTruthy()
  expect(listeners.size).toBe(0);expect(windowListeners.size).toBe(0)
  act(()=>tree.root.findByProps({'aria-expanded':false}).props.onClick({currentTarget:anchor}))
  act(()=>tree.root.findByType(Dialog).props.onClose())
  expect(anchor.focus).toHaveBeenCalledOnce()
 }finally{if(tree)act(()=>tree.unmount());vi.unstubAllGlobals()}
})
