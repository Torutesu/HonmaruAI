import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AgentMemoryConversion} from './AgentMemoryConversion'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=>(s:string)=>s}))
test('conversion preserves its retry identity, guards duplicate submission and shows inherited scope',async()=>{
 const save=vi.fn().mockRejectedValueOnce(new Error('Temporary failure')).mockResolvedValue(undefined),close=vi.fn()
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryConversion memory={{id:'m',text:'Policy',body:'<script>inert</script>',channel:'b:source',source:'person',createdAt:'2026-01-01'}} agentName="Assistant" conversationName="Source room" onClose={close} onSave={save}/>)})
 const submit=()=>tree.root.findAllByType('button').find(b=>b.children.includes('Create and install skill'))!
 expect(tree.root.findAllByType('script')).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).toContain('Current access is checked')
 await act(async()=>{submit().props.onClick();submit().props.onClick()})
 expect(save).toHaveBeenCalledTimes(1)
 expect(close).not.toHaveBeenCalled()
 expect(save.mock.calls[0][0]).toBe(false)
 await act(async()=>{submit().props.onClick()})
 expect(save.mock.calls[1]).toEqual(save.mock.calls[0])
 expect(close).toHaveBeenCalledTimes(1)
 act(()=>tree.unmount())
})
test('changing the keep choice gives the new operation a new request identity',async()=>{
 const save=vi.fn().mockRejectedValue(new Error('Conflict'))
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryConversion memory={{id:'m',text:'Policy',source:'person',createdAt:'2026-01-01'}} agentName="Assistant" onClose={()=>{}} onSave={save}/>)})
 const submit=()=>tree.root.findAllByType('button').find(b=>b.children.includes('Create and install skill'))!
 await act(async()=>{submit().props.onClick()})
 act(()=>tree.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}))
 await act(async()=>{submit().props.onClick()})
 expect(save.mock.calls[1][0]).toBe(true)
 expect(save.mock.calls[1][1]).not.toBe(save.mock.calls[0][1])
 act(()=>tree.unmount())
})
