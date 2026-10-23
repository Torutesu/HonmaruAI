import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AgentMemoryReview} from './AgentMemoryReview'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=>(s:string)=>s}))
test('review requires evidence, retains it after a stale-version failure, and prevents overlapping submits',async()=>{
 const close=vi.fn(),save=vi.fn().mockRejectedValueOnce(new Error('Reload before reviewing')).mockResolvedValue(undefined)
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryReview memory={{id:'m',text:'Policy',body:'<script>inert</script>',source:'person',createdAt:'2026-01-01'}} onClose={close} onSave={save}/>)})
 const confirm=()=>tree.root.findAllByType('button').find(b=>b.children.includes('Confirm memory'))!
 expect(confirm().props.disabled).toBe(true)
 expect(tree.root.findAllByType('script')).toHaveLength(0)
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Checked with the owner'}}))
 await act(async()=>{confirm().props.onClick();confirm().props.onClick()})
 expect(save).toHaveBeenCalledTimes(1)
 expect(close).not.toHaveBeenCalled()
 expect(tree.root.findByType('textarea').props.value).toBe('Checked with the owner')
 expect(tree.root.findByProps({role:'alert'}).children).toContain('Reload before reviewing')
 await act(async()=>{confirm().props.onClick()})
 expect(close).toHaveBeenCalledTimes(1)
 act(()=>tree.unmount())
})

test('update review submits revised content with evidence and preserves edits on conflict',async()=>{
 const save=vi.fn().mockRejectedValueOnce(new Error('Conflict')).mockResolvedValue(undefined),close=vi.fn()
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryReview memory={{id:'m',text:'Original',title:'Policy',body:'Original',source:'person',createdAt:'2026-01-01'}} onClose={close} onSave={save}/>)})
 act(()=>tree.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}))
 const fields=()=>tree.root.findAllByType('textarea')
 act(()=>fields()[1].props.onChange({target:{value:'Revised body'}}))
 act(()=>fields()[2].props.onChange({target:{value:'Checked source'}}))
 const confirm=()=>tree.root.findAllByType('button').find(b=>b.children.includes('Update and confirm memory'))!
 await act(async()=>confirm().props.onClick())
 expect(save).toHaveBeenCalledWith('Checked source',expect.objectContaining({body:'Revised body',title:'Policy'}))
 expect(fields()[1].props.value).toBe('Revised body')
 expect(fields()[2].props.value).toBe('Checked source')
 expect(close).not.toHaveBeenCalled()
 await act(async()=>confirm().props.onClick())
 expect(close).toHaveBeenCalledTimes(1)
 act(()=>tree.unmount())
})
