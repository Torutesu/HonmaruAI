import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi,afterEach} from 'vitest'
import {MemberDepartureDialog} from './MemberDepartureDialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
afterEach(()=>vi.unstubAllGlobals())
const member={ref:'departing',name:'Departing person',mine:true}
const preview={version:'snapshot',member,agents:[{id:'a',name:'Private agent',owned:true,scope:'personal',version:0}],candidates:[{ref:'successor',name:'Successor'}]}
const response=(body:unknown,ok=true)=>({ok,json:async()=>body})
test('departure requires an explicit successor, keeps failed selection, and sends the reviewed version',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(preview)))
 const remove=vi.fn().mockRejectedValue(Error('Workspace responsibilities changed. Reload before removing this member.'))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={member} onRemove={remove} onClose={vi.fn()}/>)})
 const button=()=>tree.root.findAllByType('button').find(n=>n.children.includes('Leave'))!
 expect(button().props.disabled).toBe(true)
 act(()=>tree.root.findByType('select').props.onChange({target:{value:'successor'}}))
 expect(remove).not.toHaveBeenCalled()
 await act(async()=>button().props.onClick())
 expect(remove).toHaveBeenCalledWith({previewVersion:'snapshot',transferTo:'successor'})
 expect(tree.root.findByType('select').props.value).toBe('successor')
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Reload')
 act(()=>tree.unmount())
})
test('a failed preview never enables removal and reload recovers without a transfer field when there are no agents',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response({message:'No permission'},false)).mockResolvedValue(response({...preview,agents:[]}))
 vi.stubGlobal('fetch',fetch);const remove=vi.fn().mockResolvedValue(undefined);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={member} onRemove={remove} onClose={vi.fn()}/>)})
 const button=(label:string)=>tree.root.findAllByType('button').find(n=>n.children.includes(label))!
 expect(button('Leave').props.disabled).toBe(true)
 await act(async()=>button('Reload').props.onClick())
 expect(tree.root.findAllByType('select')).toHaveLength(0)
 await act(async()=>button('Leave').props.onClick())
 expect(remove).toHaveBeenCalledWith({previewVersion:'snapshot'})
 act(()=>tree.unmount())
})
