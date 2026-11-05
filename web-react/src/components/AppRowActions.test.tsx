import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AppRowActions } from './AppRowActions'

const documentStub:any={body:{},activeElement:null,addEventListener:vi.fn(),removeEventListener:vi.fn()}
const windowStub:any={innerWidth:1024,innerHeight:768,addEventListener:vi.fn(),removeEventListener:vi.fn()}
beforeEach(()=>{vi.stubGlobal('document',documentStub);vi.stubGlobal('window',windowStub)})
let tree:ReturnType<typeof create>|undefined
afterEach(()=>{if(tree)act(()=>tree!.unmount());tree=undefined;vi.unstubAllGlobals();vi.clearAllMocks()})

test('the row kebab exposes keyboard-operable detail and delete menu items',()=>{
  const onOpen=vi.fn(),onDelete=vi.fn()
  const triggerNode={isConnected:true,focus:vi.fn(),getBoundingClientRect:()=>({right:500,bottom:200})}
  tree=create(<AppRowActions label="Rina's task" actionsLabel="Actions" openLabel="Open details" deleteLabel="Delete row" onOpen={onOpen} onDelete={onDelete}/>,{createNodeMock:element=>{
    if(element.type==='button')return triggerNode
    if(element.type==='ul')return {querySelectorAll:()=>[],contains:()=>false}
    if(element.type==='div')return {getBoundingClientRect:()=>({left:0,top:0,right:220,bottom:100,width:220,height:100}),querySelector:()=>null,contains:()=>false}
    return {}
  }})
  const trigger=tree.root.findByProps({className:'hx-record-menu-trigger'})
  expect(trigger.props.type).toBe('button')
  expect(trigger.props['aria-label']).toBe("Rina's taskの操作")
  expect(trigger.props['aria-haspopup']).toBe('menu')
  expect(trigger.props['aria-expanded']).toBe(false)
  documentStub.activeElement=triggerNode
  act(()=>trigger.props.onClick({currentTarget:triggerNode}))
  expect(tree.root.findByProps({role:'menu'}).props['aria-label']).toBe('Actions')
  expect(tree.root.findAllByProps({role:'menuitem'}).map(item=>item.findByProps({className:'row-menu-label'}).children.join(''))).toEqual(['Open details','Delete row'])
  const items=tree.root.findAllByProps({role:'menuitem'})
  act(()=>items[0].props.onClick())
  expect(onOpen).toHaveBeenCalledOnce()
  expect(onDelete).not.toHaveBeenCalled()
})

test('the delete action calls the caller',()=>{
  const onOpen=vi.fn(),onDelete=vi.fn()
  const triggerNode={isConnected:true,focus:vi.fn(),getBoundingClientRect:()=>({right:500,bottom:200})}
  tree=create(<AppRowActions label="Task" actionsLabel="Actions" openLabel="Open details" deleteLabel="Delete row" onOpen={onOpen} onDelete={onDelete}/>,{createNodeMock:element=>element.type==='button'?triggerNode:element.type==='ul'?{querySelectorAll:()=>[],contains:()=>false}:element.type==='div'?{getBoundingClientRect:()=>({left:0,top:0,right:220,bottom:100,width:220,height:100}),querySelector:()=>null,contains:()=>false}:{}})
  const trigger=tree.root.findByProps({className:'hx-record-menu-trigger'})
  documentStub.activeElement=triggerNode
  act(()=>trigger.props.onClick({currentTarget:triggerNode}))
  const deleteItem=tree.root.findAllByProps({role:'menuitem'})[1]
  act(()=>deleteItem.props.onClick())
  expect(onDelete).toHaveBeenCalledOnce()
  expect(onOpen).not.toHaveBeenCalled()
})

test('the delete action stays disabled while a row is deleting',()=>{
  const triggerNode={isConnected:true,focus:vi.fn(),getBoundingClientRect:()=>({right:500,bottom:200})}
  tree=create(<AppRowActions label="Task" actionsLabel="Actions" openLabel="Open details" deleteLabel="Delete row" onOpen={vi.fn()} onDelete={vi.fn()} deleteDisabled/>,{createNodeMock:element=>element.type==='button'?triggerNode:element.type==='ul'?{querySelectorAll:()=>[],contains:()=>false}:element.type==='div'?{getBoundingClientRect:()=>({left:0,top:0,right:220,bottom:100,width:220,height:100}),querySelector:()=>null,contains:()=>false}:{}})
  act(()=>tree!.root.findByProps({className:'hx-record-menu-trigger'}).props.onClick({currentTarget:triggerNode}))
  expect(tree!.root.findAllByProps({role:'menuitem'})[1].props.disabled).toBe(true)
})
