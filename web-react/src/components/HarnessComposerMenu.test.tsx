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
  act(()=>{tree=create(<HarnessComposerMenu onAttach={attach} onMention={mention} onDecision={vi.fn()} onSchedule={vi.fn()} canDecide={false} canSchedule={false}><span>Format tools</span></HarnessComposerMenu>,{createNodeMock:el=>el.type==='div'?{contains:()=>false,querySelector:()=>({focus})}:{focus}})})
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
