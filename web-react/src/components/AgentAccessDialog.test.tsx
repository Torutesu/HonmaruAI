import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {AgentAccessDialog} from './AgentAccessDialog'
import type {AgentRoleState} from '../utils/harness'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const state:AgentRoleState={version:1,scope:'team',canManage:true,members:[{ref:'maker',name:'Maker Name',role:'admin',owner:true},{ref:'person',name:'Member Name',role:'member',owner:false}],candidates:[{ref:'maker',name:'Maker Name'},{ref:'person',name:'Member Name'}]}
test('ordinary members can prepare their own removal but cannot select an admin role or edit an admin',async()=>{
 const save=vi.fn().mockResolvedValue({version:2}),close=vi.fn();let tree!:ReturnType<typeof create>
 const memberState={...state,canManage:false,canAddMembers:true,members:state.members.map(m=>({...m,mine:m.ref==='person'}))}
 const load=vi.fn().mockResolvedValue(memberState)
 await act(async()=>{tree=create(<AgentAccessDialog load={load} save={save} onClose={close}/>)})
 expect(tree.root.findAllByType('option').some(n=>n.props.value==='admin'||n.props.value==='maker')).toBe(false)
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Remove myself'))!.props.onClick())
 expect(save).not.toHaveBeenCalled()
 expect(tree.root.findAllByType('select')[1].props.value).toBe('none')
 await act(async()=>tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!.props.onClick())
 expect(save).toHaveBeenCalledWith('person','none',1)
 expect(close).toHaveBeenCalledWith('team')
 expect(load).toHaveBeenCalledTimes(1)
 act(()=>tree.unmount())
})
test('role changes use the loaded version, preserve failed drafts and require explicit reload',async()=>{
 const load=vi.fn().mockResolvedValue(state),save=vi.fn().mockRejectedValueOnce(Error('Agent access changed. Reload before saving.')).mockResolvedValue({version:3})
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentAccessDialog load={load} save={save} onClose={vi.fn()}/>)})
 const choose=()=>{act(()=>tree.root.findAllByType('select')[0].props.onChange({target:{value:'person'}}));act(()=>tree.root.findAllByType('select')[1].props.onChange({target:{value:'admin'}}))}
 const button=(text:string)=>tree.root.findAllByType('button').find(n=>n.children.includes(text))!
 choose();await act(async()=>button('Save').props.onClick())
 expect(save).toHaveBeenLastCalledWith('person','admin',1)
 expect(tree.root.findAllByType('select')[1].props.value).toBe('admin')
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Reload')
 load.mockResolvedValue({...state,version:2})
 await act(async()=>button('Reload').props.onClick())
 expect(tree.root.findAllByType('select')[0].props.value).toBe('')
 choose();await act(async()=>button('Save').props.onClick())
 expect(save).toHaveBeenLastCalledWith('person','admin',2)
 act(()=>tree.unmount())
})
test('read-only access has no form and personal sharing is explicit while the maker stays protected',async()=>{
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentAccessDialog load={async()=>({...state,canManage:false})} save={vi.fn()} onClose={vi.fn()}/>)})
 expect(tree.root.findAllByType('select')).toHaveLength(0)
 await act(async()=>tree.update(<AgentAccessDialog load={async()=>({...state,scope:'personal'})} save={vi.fn()} onClose={vi.fn()}/>))
 expect(tree.root.findAllByType('button').some(n=>n.children.includes('Share and save'))).toBe(true)
 await act(async()=>tree.update(<AgentAccessDialog load={async()=>state} save={vi.fn()} onClose={vi.fn()}/>))
 expect(tree.root.findAllByType('option').some(n=>n.props.value==='maker')).toBe(false)
 act(()=>tree.unmount())
})
test('pending saves are deduplicated and a refresh failure is not reported as an unsaved change',async()=>{
 let finish!:(value:unknown)=>void
 const save=vi.fn(()=>new Promise(resolve=>{finish=resolve})),load=vi.fn().mockResolvedValueOnce(state).mockRejectedValue(Error('offline'))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentAccessDialog load={load} save={save} onClose={vi.fn()}/>)})
 act(()=>tree.root.findAllByType('select')[0].props.onChange({target:{value:'person'}}))
 act(()=>tree.root.findAllByType('select')[1].props.onChange({target:{value:'admin'}}))
 const click=tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!.props.onClick
 act(()=>{click();click()});expect(save).toHaveBeenCalledTimes(1)
 await act(async()=>finish({version:2}))
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Saved, but')
 expect(tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!.props.disabled).toBe(true)
 act(()=>tree.unmount())
})

test('successful personal sharing updates the parent scope even when its member refresh fails',async()=>{
 const close=vi.fn(),load=vi.fn().mockResolvedValueOnce({...state,scope:'personal',members:[state.members[0]]}).mockRejectedValue(Error('offline'))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentAccessDialog load={load} save={async()=>({version:2})} onClose={close}/>)})
 act(()=>tree.root.findAllByType('select')[0].props.onChange({target:{value:'person'}}))
 await act(async()=>tree.root.findAllByType('button').find(n=>n.children.includes('Share and save'))!.props.onClick())
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Close'))!.props.onClick())
 expect(close).toHaveBeenCalledWith('team')
 act(()=>tree.unmount())
})
