import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {HarnessComposerMenu} from './HarnessComposerMenu'
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
test('compact menu preserves actions, disabled state, formatting and dismissal',()=>{
 const listeners=new Map<string,(event:any)=>void>(),attach=vi.fn(),mention=vi.fn(),focus=vi.fn()
 vi.stubGlobal('document',{addEventListener:(key:string,fn:any)=>listeners.set(key,fn),removeEventListener:(key:string)=>listeners.delete(key)})
 let tree!:ReturnType<typeof create>
 try{
  act(()=>{tree=create(<HarnessComposerMenu onAttach={attach} onMention={mention} onDecision={vi.fn()} onSchedule={vi.fn()} canDecide={false} canSchedule={false}><span>Format tools</span></HarnessComposerMenu>,{createNodeMock:el=>el.type==='div'?{contains:()=>false,querySelector:()=>({focus}),querySelectorAll:()=>[{focus}]}:{focus}})})
  const open=()=>act(()=>tree.root.findByProps({'aria-haspopup':'menu'}).props.onClick())
  const item=(label:string)=>tree.root.findAllByProps({role:'menuitem'}).find(x=>x.children.includes(label))!
  open();expect(item('Schedule message').props.disabled).toBe(true);expect(item('Send as a decision').props.disabled).toBe(true)
  act(()=>item('Attach files').props.onClick());expect(attach).toHaveBeenCalledOnce();expect(tree.root.findAllByProps({role:'menu'})).toHaveLength(0)
  open();act(()=>item('Mention someone').props.onClick());expect(mention).toHaveBeenCalledOnce()
  open();act(()=>item('Formatting').props.onClick());expect(tree.root.findAllByProps({className:'hx-composer-format'})).toHaveLength(1)
  act(()=>listeners.get('pointerdown')!({target:{}}));expect(tree.root.findAllByProps({className:'hx-composer-format'})).toHaveLength(0)
  open();act(()=>tree.root.findByProps({className:'hx-composer-add'}).props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}}));expect(tree.root.findAllByProps({role:'menu'})).toHaveLength(0)
  act(()=>tree.unmount());expect(listeners.size).toBe(0)
 }finally{vi.unstubAllGlobals()}
})
test('keyboard opens at either end and Tab restores the trigger before leaving the menu',()=>{
 const first={focus:vi.fn()},last={focus:vi.fn()},trigger={focus:vi.fn()},toolbar={focus:vi.fn()}
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),activeElement:first})
 let tree!:ReturnType<typeof create>
 try{
  act(()=>{tree=create(<HarnessComposerMenu onAttach={vi.fn()} onMention={vi.fn()} onDecision={vi.fn()} onSchedule={vi.fn()} canDecide canSchedule><button>Bold</button></HarnessComposerMenu>,{createNodeMock:el=>el.props.className==='hx-composer-add'?{contains:()=>false,querySelectorAll:()=>[first,last],querySelector:()=>toolbar}:el.props['aria-haspopup']?trigger:null})})
  const key=(name:string,target:any=first)=>act(()=>tree.root.findByProps({className:'hx-composer-add'}).props.onKeyDown({key:name,target,preventDefault:vi.fn(),stopPropagation:vi.fn()}))
  key('ArrowUp',trigger);expect(last.focus).toHaveBeenCalledOnce()
  key('Home');expect(first.focus).toHaveBeenCalledOnce()
  key('End');expect(last.focus).toHaveBeenCalledTimes(2)
  key('Tab');expect(trigger.focus).toHaveBeenCalledOnce();expect(tree.root.findAllByProps({role:'menu'})).toHaveLength(0)
  key('ArrowDown',trigger);expect(first.focus).toHaveBeenCalledTimes(2)
  const formatting=tree.root.findAllByProps({role:'menuitem'}).find(x=>x.children.includes('Formatting'))!
  act(()=>formatting.props.onClick());expect(toolbar.focus).toHaveBeenCalledOnce()
  act(()=>tree.unmount())
 }finally{vi.unstubAllGlobals()}
})
test('reply menus omit unsupported send actions and keep broadcast control accessible',()=>{
 const toggle=vi.fn();vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});let tree!:ReturnType<typeof create>
 try{
  act(()=>{tree=create(<HarnessComposerMenu onAttach={vi.fn()} onMention={vi.fn()} extraActions={<button role="menuitemcheckbox" aria-checked={false} onClick={toggle}>Also send</button>}><span>Formatting</span></HarnessComposerMenu>)})
  act(()=>tree.root.findByProps({'aria-haspopup':'menu'}).props.onClick())
  const names=tree.root.findAllByProps({role:'menuitem'}).flatMap(x=>x.children.filter(x=>typeof x==='string'))
  expect(names).not.toContain('Schedule message');expect(names).not.toContain('Send as a decision')
  act(()=>tree.root.findByProps({role:'menuitemcheckbox'}).props.onClick());expect(toggle).toHaveBeenCalledOnce()
  act(()=>tree.unmount())
 }finally{vi.unstubAllGlobals()}
})
