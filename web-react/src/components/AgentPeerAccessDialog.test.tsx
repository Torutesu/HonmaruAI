import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AgentPeerAccessDialog} from './AgentPeerAccessDialog'
import type {AgentPeerRoleState} from '../utils/harness'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const state:AgentPeerRoleState={version:7,scope:'team',canManage:true,members:[{agentId:'worker',name:'Worker',role:'member'}],candidates:[{id:'worker',name:'Worker'},{id:'reviewer',name:'Reviewer'}]}
test('managed Agent admins can assign an eligible peer using the loaded access version',async()=>{
 const load=vi.fn().mockResolvedValue(state),save=vi.fn().mockResolvedValue({version:8});let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentPeerAccessDialog load={load} save={save} onClose={vi.fn()}/>)})
 expect(tree.root.findAllByType('strong').map(n=>n.children.join(''))).toEqual(['Worker'])
 const selects=tree.root.findAllByType('select')
 act(()=>selects[0].props.onChange({target:{value:'reviewer'}}));act(()=>selects[1].props.onChange({target:{value:'admin'}}))
 await act(async()=>tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!.props.onClick())
 expect(save).toHaveBeenCalledWith('reviewer','admin',7);expect(load).toHaveBeenCalledTimes(2)
 act(()=>tree.unmount())
})
test('a CAS conflict blocks another save until the user explicitly reloads',async()=>{
 const conflict=Object.assign(new Error('Agent access changed. Reload before saving.'),{status:409}),load=vi.fn().mockResolvedValueOnce(state).mockResolvedValue({...state,version:8}),save=vi.fn().mockRejectedValue(conflict);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentPeerAccessDialog load={load} save={save} onClose={vi.fn()}/>)})
 act(()=>tree.root.findAllByType('select')[0].props.onChange({target:{value:'reviewer'}}))
 act(()=>tree.root.findAllByType('select')[1].props.onChange({target:{value:'admin'}}))
 const button=(label:string)=>tree.root.findAllByType('button').find(n=>n.children.includes(label))!
 await act(async()=>button('Save').props.onClick())
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Reload')
 expect(button('Save').props.disabled).toBe(true);expect(save).toHaveBeenCalledTimes(1)
 await act(async()=>button('Reload').props.onClick())
 expect(load).toHaveBeenCalledTimes(2);expect(tree.root.findAllByType('select')[0].props.value).toBe('')
 act(()=>tree.unmount())
})
test('members can inspect but cannot edit peer roles; personal Agents are not editable',async()=>{
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentPeerAccessDialog load={async()=>({...state,canManage:false,candidates:[]})} save={vi.fn()} onClose={vi.fn()}/> )})
 expect(tree.root.findAllByType('select')).toHaveLength(0)
 await act(async()=>tree.update(<AgentPeerAccessDialog load={async()=>({...state,scope:'personal'})} save={vi.fn()} onClose={vi.fn()}/>))
 expect(tree.root.findAllByType('select')).toHaveLength(0)
 act(()=>tree.unmount())
})
