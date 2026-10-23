import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AgentMemoryHistory} from './AgentMemoryHistory'
vi.mock('./Dialog',()=>({Dialog:({children}:any)=><section>{children}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=>(s:string)=>s}))
test('history keeps loaded evidence on page failure and retries the same cursor',async()=>{
 const row={id:'one',version:0,verdict:'keep',evidence:'<script>inert</script>',by:'owner',reviewerName:'Owner',at:'2026-10-24'}
 const load=vi.fn().mockResolvedValueOnce({reviews:[row],nextCursor:'next'}).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({reviews:[row,{...row,id:'two'}],nextCursor:null})
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AgentMemoryHistory memory={{id:'m',text:'Policy',source:'person',createdAt:'2026-01-01'}} load={load} onClose={()=>{}}/>)})
 expect(tree.root.findAllByType('article')).toHaveLength(1)
 expect(tree.root.findAllByType('script')).toHaveLength(0)
 await act(async()=>{tree.root.findByType('button').props.onClick()})
 expect(tree.root.findByProps({role:'alert'}).children).toContain('Offline')
 expect(tree.root.findAllByType('article')).toHaveLength(1)
 await act(async()=>{tree.root.findByType('button').props.onClick()})
 expect(load.mock.calls).toEqual([[undefined],['next'],['next']])
 expect(tree.root.findAllByType('article')).toHaveLength(2)
 expect(tree.root.findAllByType('button')).toHaveLength(0)
 act(()=>tree.unmount())
})
