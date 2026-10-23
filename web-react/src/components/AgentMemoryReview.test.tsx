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
