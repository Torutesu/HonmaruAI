import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,it,vi} from 'vitest'
import {WorkspaceSwitcher} from './WorkspaceSwitcher'
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
it('Escape dismisses only the workspace menu, restores focus and leaves IME input alone',()=>{
 const listeners=new Map<string,(e:any)=>void>(),focus=vi.fn()
 vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('document',{addEventListener:(type:string,fn:any)=>listeners.set(type,fn),removeEventListener:(type:string)=>listeners.delete(type)})
 let tree!:ReturnType<typeof create>
 try{
  act(()=>{tree=create(<WorkspaceSwitcher workspaces={[{id:'team:one',name:'One',role:'owner'}]} currentId="team:one" onSwitch={vi.fn()} onSettings={vi.fn()} onCreate={vi.fn()} onJoin={vi.fn()} onLogout={vi.fn()}/>,{createNodeMock:()=>({querySelector:()=>({focus})})})})
  act(()=>tree.root.findByProps({className:'ws-button'}).props.onClick())
  const composingEvent={key:'Escape',isComposing:true,preventDefault:vi.fn(),stopPropagation:vi.fn()}
  act(()=>listeners.get('keydown')!(composingEvent))
  expect(tree.root.findAllByProps({role:'menu'})).toHaveLength(1)
  expect(composingEvent.preventDefault).not.toHaveBeenCalled()
  const event={key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()}
  act(()=>listeners.get('keydown')!(event))
  expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopPropagation).toHaveBeenCalledOnce()
  expect(focus).toHaveBeenCalledOnce();expect(tree.root.findAllByProps({role:'menu'})).toHaveLength(0)
  act(()=>tree.unmount())
 }finally{vi.unstubAllGlobals()}
})
