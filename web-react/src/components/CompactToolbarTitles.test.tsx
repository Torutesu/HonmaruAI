import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppViewControls} from './AppViewControls'
import {PersonalViewControls} from './PersonalViewControls'
import {AppDataMenu} from './AppDataMenu'

vi.mock('../utils/i18n',()=>({useT:()=>(key:string,values?:Record<string,unknown>)=>key.replace(/\{(\w+)\}/g,(match,name)=>values?.[name]==null?match:String(values[name]))}))
afterEach(()=>vi.unstubAllGlobals())

test('compact viewer icon controls retain their labels and expose titles',()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
  const view={id:'all',type:'table' as const,name:'All'},columns=[{id:'title',name:'Title',type:'text' as const}]
  const save=vi.fn().mockResolvedValue(undefined)
  let tree:ReturnType<typeof create>
  act(()=>{tree=create(<><AppViewControls view={view} columns={columns} canEdit save={save}/><PersonalViewControls view={view} columns={columns} personal={false} control="fields" state={{revision:0,views:[],computed:[],layouts:{}}} save={save} onSelect={()=>{}} onSettings={()=>{}}/><AppDataMenu wrapText={false} save={save}/></>)})
  const button=(text:string)=>tree!.root.findAllByType('button').find(item=>item.children.includes(text))!
  expect(button('Fields').props.title).toBe('Fields')
  expect(button('Filter records').props.title).toBe('Filter records')
  expect(button('Group records').props.title).toBe('Group records')
  for(const label of ['Fields','Filter records','Group records'])expect(button(label).props['aria-label']).toBe(label)
  const menu=tree!.root.findByProps({'aria-label':'More data viewer actions'})
  expect(menu.props.title).toBe('More data viewer actions')
  expect(menu.props['aria-label']).toBe('More data viewer actions')
  act(()=>tree!.unmount())
})

test('filter title and accessible name retain the active condition count',()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
  const view={id:'all',type:'table' as const,name:'All',filters:[{column:'title',op:'eq',value:'A'}],where:{title:['A']}}
  let tree:ReturnType<typeof create>
  act(()=>{tree=create(<AppViewControls view={view} columns={[{id:'title',name:'Title',type:'text'}]} canEdit save={vi.fn()}/>)})
  const filter=tree!.root.findByProps({'aria-label':'Filter records (2 active)'})
  expect(filter.props.title).toBe('Filter records (2 active)')
  expect(filter.findByProps({className:'hx-count'}).children).toEqual(['2'])
  act(()=>tree!.unmount())
})
