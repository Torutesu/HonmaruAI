import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { SkillActionsMenu } from './SkillActionsMenu'
vi.mock('../utils/i18n',()=>({useT:()=> (text:string)=>text}))
test('menu dismisses outside or with Escape and restores focus without removing the skill',()=>{
 const listeners=new Map<string,(event:any)=>void>(), remove=vi.fn(), focus=vi.fn()
 class TestNode {}
 vi.stubGlobal('Node',TestNode)
 vi.stubGlobal('document',{addEventListener:(key:string,fn:any)=>listeners.set(key,fn),removeEventListener:(key:string)=>listeners.delete(key)})
 const details={open:false,contains:()=>false};let tree!:ReturnType<typeof create>
 try {
  act(()=>{tree=create(<SkillActionsMenu name="Review" disabled={false} onRemove={remove}/>,{createNodeMock:el=>el.type==='details'?details:{focus}})})
  const open=()=>act(()=>{details.open=true;tree.root.findByType('details').props.onToggle({currentTarget:details})})
  open();act(()=>listeners.get('keydown')!({key:'Escape',preventDefault(){}}))
  expect(details.open).toBe(false);expect(focus).toHaveBeenCalledOnce();expect(remove).not.toHaveBeenCalled()
  open();act(()=>listeners.get('pointerdown')!({target:new TestNode()}))
  expect(details.open).toBe(false);expect(remove).not.toHaveBeenCalled()
  open();act(()=>tree.root.findByType('button').props.onClick())
  expect(remove).toHaveBeenCalledOnce();expect(details.open).toBe(false)
  act(()=>tree.unmount());expect(listeners.size).toBe(0)
 } finally {vi.unstubAllGlobals()}
})
