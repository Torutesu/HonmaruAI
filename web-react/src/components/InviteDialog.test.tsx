import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {InviteDialog} from './InviteDialog'

vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (value:string)=>value}))
vi.mock('./Icon',()=>({Icon:()=>null}))

const businesses=[
 {slug:'general',name:'General',isDefaultRoom:true},
 {slug:'planning',name:'Planning'},
]
const checkboxInputs=(tree:ReturnType<typeof create>)=>tree.root.findAllByType('input').filter(node=>node.props.type==='checkbox')

test('new workspace members always receive default Rooms and optional Rooms start unchecked',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({businesses})})
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 try {
  await act(async()=>{tree=create(<InviteDialog httpBase="https://api.test" orgId="org" sessionToken="session" onClose={vi.fn()}/>);await Promise.resolve()})
  const boxes=checkboxInputs(tree)
  expect(boxes).toHaveLength(3)
  expect(boxes[1].props.checked).toBe(true)
  expect(boxes[1].props.disabled).toBe(true)
  expect(boxes[2].props.checked).toBe(false)
  expect(boxes[2].props.disabled).toBe(false)
  expect(tree.root.findByProps({children:'New members join default Rooms automatically, plus any other Rooms selected here.'})).toBeTruthy()
 } finally { if(tree)act(()=>tree.unmount());vi.unstubAllGlobals() }
})

test('Agents start with no Room grants and only explicitly selected Rooms are sent',async()=>{
 const fetch=vi.fn().mockImplementation(async(url:string)=>String(url).includes('/businesses?')
  ? {ok:true,json:async()=>({businesses})}
  : {ok:true,json:async()=>({url:'https://api.test/agent-invite',expiresAt:'2026-11-14T12:00:00Z'})})
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 try {
  await act(async()=>{tree=create(<InviteDialog httpBase="https://api.test" orgId="org" sessionToken="session" initialTab="agent" onClose={vi.fn()}/>);await Promise.resolve()})
  let boxes=checkboxInputs(tree)
  expect(boxes.slice(1).map(box=>box.props.checked)).toEqual([false,false])
  const agentRoom=boxes[2]
  act(()=>agentRoom.props.onChange({target:{checked:true}}))
  await act(async()=>tree.root.findAllByType('button').find(node=>node.children.includes('Copy single-use link'))!.props.onClick())
  expect(JSON.parse(fetch.mock.calls[1][1].body).channels).toEqual(['planning'])
 } finally { if(tree)act(()=>tree.unmount());vi.unstubAllGlobals() }
})
