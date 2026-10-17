import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

async function setup(conflicts:unknown[]=[]) {
 const fork={id:'private-fork',revision:4,entities:[{key:'primary',table:{id:'table',name:'Tasks',columns:[]},rows:[]}]}
 const review={forkId:fork.id,revision:4,checksum:'reviewed-digest',conflicts,changes:[{entity:'primary',tableId:'table',tableName:'Tasks',id:'row',operation:'create',before:null,after:{name:'Draft'}}]}
 const api={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),appDatabase:vi.fn().mockResolvedValue({fork,version:1,entities:fork.entities,migrations:[]}),mergePreview:vi.fn().mockResolvedValue(review),databaseChange:vi.fn().mockResolvedValue({merged:true})}
 const reload=vi.fn();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<CompanyApp app={{id:'app'}as any} api={api as any} canManage reload={reload}/> )})
 const button=(name:string)=>tree!.root.findAllByType('button').find(b=>b.children.join('')===name)!
 await act(async()=>button('データベース').props.onClick())
 return {tree:tree!,button,api,reload}
}
test('production merge requires a reviewed diff and sends exactly its checksum and revision',async()=>{
 const {tree,button,api,reload}=await setup()
 expect(button('この差分を本番に反映')).toBeUndefined()
 await act(async()=>button('本番への反映差分を確認').props.onClick())
 expect(api.databaseChange).not.toHaveBeenCalled()
 expect(tree.root.findByProps({'aria-label':'検証DBの反映差分'})).toBeTruthy()
 await act(async()=>button('この差分を本番に反映').props.onClick())
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'merge_apply',forkId:'private-fork',revision:4,checksum:'reviewed-digest'})
 expect(reload).toHaveBeenCalledOnce()
 act(()=>tree.unmount())
})
test('conflicting production rows prevent confirmation',async()=>{
 const {tree,button,api}=await setup([{entity:'primary',id:'row',reason:'Changed'}])
 await act(async()=>button('本番への反映差分を確認').props.onClick())
 expect(button('この差分を本番に反映').props.disabled).toBe(true)
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})
