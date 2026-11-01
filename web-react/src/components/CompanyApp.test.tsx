import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

async function setup(conflicts:unknown[]=[]) {
 const fork={id:'private-fork',revision:4,entities:[{key:'primary',table:{id:'table',name:'Tasks',columns:[]},rows:[]}]}
 const review={forkId:fork.id,revision:4,checksum:'reviewed-digest',conflicts,changes:[{entity:'primary',tableId:'table',tableName:'Tasks',id:'row',operation:'create',before:null,after:{name:'Draft'}}]}
 const api={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),appDatabase:vi.fn().mockResolvedValue({fork,version:1,entities:fork.entities,migrations:[]}),mergePreview:vi.fn().mockResolvedValue(review),previewDatabaseMigration:vi.fn().mockResolvedValue({previewChecksum:'reviewed-schema-digest',canApply:true,changes:[{entity:'primary',tableName:'Tasks',operations:['convert_column'],rowsScanned:1,rowsChanged:1,examples:[{id:'row',before:{amount:'12'},after:{amount:12}}],blockers:[]}],blockers:[],blockerCount:0}),databaseChange:vi.fn().mockResolvedValue({merged:true})}
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
test('database changes require a fresh data preview and apply its checksum',async()=>{
 const {tree,button,api,reload}=await setup()
 const change={op:'convert_column',entity:'primary',column:'amount',type:'number'}
 const idInput=tree.root.findByProps({placeholder:'convert_amount_v1'})
 await act(async()=>idInput.props.onChange({target:{value:'convert_amount_v2'}}))
 const planInput=tree.root.findByProps({'aria-label':'DB変更案'})
 await act(async()=>planInput.props.onChange({target:{value:JSON.stringify([change])}}))
 expect(button('本番への変更を確認').props.disabled).toBe(true)
 await act(async()=>button('変更内容をプレビュー').props.onClick())
 expect(api.previewDatabaseMigration).toHaveBeenCalledWith('app',{action:'preview',id:'convert_amount_v2',version:1,operations:[change]})
 expect(tree.root.findByProps({'aria-label':'DB変更プレビュー'})).toBeTruthy()
 await act(async()=>button('本番への変更を確認').props.onClick())
 await act(async()=>button('このDB変更を適用').props.onClick())
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'migrate',id:'convert_amount_v2',version:1,operations:[change],previewChecksum:'reviewed-schema-digest'})
 expect(reload).toHaveBeenCalledOnce()
 act(()=>tree.unmount())
})
