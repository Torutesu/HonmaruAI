import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

async function setup(conflicts:unknown[]=[],database:any=null) {
 const fork={id:'private-fork',revision:4,entities:[{key:'primary',table:{id:'table',name:'Tasks',columns:[]},rows:[]}]}
 const review={forkId:fork.id,revision:4,checksum:'reviewed-digest',conflicts,changes:[{entity:'primary',tableId:'table',tableName:'Tasks',id:'row',operation:'create',before:null,after:{name:'Draft'}}]}
 const api={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),appDatabase:vi.fn().mockResolvedValue(database||{fork,version:1,entities:fork.entities,migrations:[]}),mergePreview:vi.fn().mockResolvedValue(review),previewDatabaseMigration:vi.fn().mockResolvedValue({previewChecksum:'reviewed-schema-digest',canApply:true,changes:[{entity:'primary',tableName:'Tasks',operations:['convert_column'],rowsScanned:1,rowsChanged:1,examples:[{id:'row',before:{amount:'12'},after:{amount:12}}],blockers:[]}],blockers:[],blockerCount:0}),databaseChange:vi.fn().mockResolvedValue({merged:true})}
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

test('database migration history shows verified plans and hides tampered plans',async()=>{
 const verified={id:'schema_v1',version:2,checksum:'abcdef1234567890',plan:[{op:'add_columns',entity:'primary',columns:[{name:'Priority',type:'number'}]}],createdAt:'2026-11-09T00:00:00.000Z',integrityValid:true}
 const tampered={id:'schema_v2',version:3,checksum:'deadbeef01234567',plan:null,createdAt:'2026-11-09T01:00:00.000Z',integrityValid:false}
 const {tree}=await setup([],{fork:null,version:3,entities:[],migrations:[verified,tampered]})
 const history=tree.root.findByProps({'aria-label':'DB変更履歴'})
 expect(history.findAllByType('summary').map(item=>item.children.join(''))).toEqual(expect.arrayContaining([expect.stringContaining('schema_v1'),expect.stringContaining('schema_v2')]))
 expect(history.findByProps({role:'alert'}).children.join('')).toContain('整合性を確認できません')
 const plans=history.findAllByType('pre').map(item=>item.children.join(''))
 expect(plans).toHaveLength(1)
 expect(plans[0]).toContain('Priority')
 act(()=>tree.unmount())
})

test('a source-Agent connection grant can be enabled and revoked from the App connection UI',async()=>{
 let shared=false
 const connection={name:'repo_api',version:1,endpoint:'https://api.github.com/user',method:'GET',enabled:1,hasToken:1,ownerId:'9101',owned:true,canShare:true}
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn(async()=>({connections:[{...connection,shared,grantExists:shared}],hosts:['api.github.com']})),gateways:vi.fn().mockResolvedValue({gateways:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),connectionChange:vi.fn(async(_id:string,input:any)=>{shared=input.action==='grant';return {granted:shared,revoked:!shared}})}
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<CompanyApp app={{id:'app'} as any} api={api} canManage reload={()=>{}}/> )})
 const button=(name:string)=>tree.root.findAllByType('button').find(item=>item.children.join('')===name)!
 await act(async()=>button('外部接続').props.onClick())
 const selected=()=>tree.root.findAllByType('button').find(item=>item.children.join('').startsWith('repo_api'))!
 await act(async()=>selected().props.onClick())
 await act(async()=>button('このAppに接続を共有').props.onClick())
 expect(api.connectionChange).toHaveBeenLastCalledWith('app',{action:'grant',name:'repo_api'})
 await act(async()=>button('App共有を停止').props.onClick())
 expect(api.connectionChange).toHaveBeenLastCalledWith('app',{action:'revoke',name:'repo_api'})
 act(()=>tree.unmount())
})
