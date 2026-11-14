import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

async function setup(conflicts:unknown[]=[],database:any=null) {
 const fork={id:'private-fork',revision:4,entities:[{key:'primary',table:{id:'table',name:'Tasks',columns:[]},rows:[]}]}
 const review={forkId:fork.id,revision:4,checksum:'reviewed-digest',resolved:conflicts.length===0,conflicts,changes:[{entity:'primary',tableId:'table',tableName:'Tasks',id:'row',operation:'create' as const,before:null,after:{name:'Draft'}}]}
 const api={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),appDatabase:vi.fn().mockResolvedValue(database||{fork,version:1,entities:fork.entities,migrations:[]}),mergePreview:vi.fn(async(_id:string,_fork:any,resolutions:Record<string,string>={})=>({...review,resolved:conflicts.every((conflict:any)=>Boolean(resolutions[conflict.changeId])),resolutions})),previewDatabaseMigration:vi.fn().mockResolvedValue({previewChecksum:'reviewed-schema-digest',canApply:true,changes:[{entity:'primary',tableName:'Tasks',operations:['convert_column'],rowsScanned:1,rowsChanged:1,examples:[{id:'row',before:{amount:'12'},after:{amount:12}}],blockers:[]}],blockers:[],blockerCount:0}),databaseChange:vi.fn().mockResolvedValue({merged:true,changed:1})}
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
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'merge_apply',forkId:'private-fork',revision:4,checksum:'reviewed-digest',resolutions:{}})
 expect(reload).toHaveBeenCalledOnce()
 act(()=>tree.unmount())
})
test('conflicting production rows require a choice and a second review before confirmation',async()=>{
 const conflict={changeId:'primary:row',entity:'primary',id:'row',reason:'Changed',production:{name:'Live'},preview:{name:'Draft'}}
 const {tree,button,api}=await setup([conflict])
 await act(async()=>button('本番への反映差分を確認').props.onClick())
 expect(button('この差分を本番に反映').props.disabled).toBe(true)
 const select=tree.root.findByProps({'aria-label':'primary row の競合解決'})
 await act(async()=>select.props.onChange({target:{value:'production'}}))
 expect(button('選択内容を再確認').props.disabled).toBe(false)
 await act(async()=>button('選択内容を再確認').props.onClick())
 expect(api.mergePreview).toHaveBeenLastCalledWith('app',expect.objectContaining({id:'private-fork'}),{'primary:row':'production'})
 expect(button('この差分を本番に反映').props.disabled).toBe(false)
 await act(async()=>button('この差分を本番に反映').props.onClick())
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'merge_apply',forkId:'private-fork',revision:4,checksum:'reviewed-digest',resolutions:{'primary:row':'production'}})
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

test('relation builder adds a reviewed single or multiple link to an existing entity without applying it',async()=>{
 const database={fork:null,version:3,entities:[
  {key:'tasks',table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]}},
  {key:'people',table:{id:'people-table',name:'People',columns:[{id:'name',name:'Name',type:'text'}]}}
 ],migrations:[]}
 const {tree,api}=await setup([],database)
 expect(tree.root.findByProps({'aria-label':'データモデル'})).toBeTruthy()
 expect(tree.root.findAllByProps({className:'hx-db-entity'})).toHaveLength(2)
 expect(tree.root.findByProps({'aria-label':'Relation元テーブル'}).props.value).toBe('tasks')
 expect(tree.root.findByProps({'aria-label':'Relation先テーブル'}).props.value).toBe('people')
 const name=tree.root.findByProps({'aria-label':'Relation名'})
 await act(async()=>name.props.onChange({target:{value:'Assignees'}}))
 const cardinality=tree.root.findByProps({'aria-label':'Relationの件数'})
 await act(async()=>cardinality.props.onChange({target:{value:'multiple'}}))
 const form=tree.root.findByProps({className:'hx-db-builder-form hx-db-relation-builder'})
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 const plan=JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)
 expect(plan).toEqual([{op:'add_columns',entity:'tasks',columns:[{name:'Assignees',type:'relation',targetEntity:'people',multiple:true}]}])
 expect(tree.root.findByProps({placeholder:'convert_amount_v1'}).props.value).toMatch(/^schema_/)
 expect(api.previewDatabaseMigration).not.toHaveBeenCalled()
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('new table builder adds an entity with a stable key and starter field to the reviewed plan',async()=>{
 const {tree,api}=await setup()
 const name=tree.root.findByProps({'aria-label':'新しいテーブル名'})
 await act(async()=>name.props.onChange({target:{value:'Customers'}}))
 const form=tree.root.findByProps({className:'hx-db-builder-form'})
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual([{op:'create_entity',entity:'customers',name:'Customers',columns:[{name:'Name',type:'text'}]}])
 expect(api.previewDatabaseMigration).not.toHaveBeenCalled()
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('ambiguous relation migrations let the owner select a target and require a new preview',async()=>{
 const {tree,button,api}=await setup()
 const candidateBlocker={entity:'primary',id:'source-row',column:'Assignee',reason:'Value cannot be converted without data loss.',resolution:{entity:'primary',columnId:'assignee',label:'Alex',candidates:['record-a','record-b']}}
 api.previewDatabaseMigration.mockResolvedValueOnce({previewChecksum:'ambiguous',canApply:false,changes:[],blockers:[candidateBlocker],blockerCount:1}).mockResolvedValueOnce({previewChecksum:'resolved',canApply:true,changes:[],blockers:[],blockerCount:0})
 await act(async()=>tree.root.findByProps({placeholder:'convert_amount_v1'}).props.onChange({target:{value:'link_people_v1'}}))
 const plan=[{op:'convert_column',entity:'primary',column:'assignee',type:'relation',targetEntity:'people',multiple:false,matchBy:'name'}]
 await act(async()=>tree.root.findByProps({'aria-label':'DB変更案'}).props.onChange({target:{value:JSON.stringify(plan)} }))
 await act(async()=>button('変更内容をプレビュー').props.onClick())
 const selection=tree.root.findByProps({'aria-label':'Alex のリンク先レコード'})
 await act(async()=>selection.props.onChange({target:{value:'record-b'}}))
 expect(button('本番への変更を確認').props.disabled).toBe(true)
 const edited=JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)
 expect(edited[0].matchResolutions).toEqual({Alex:'record-b'})
 await act(async()=>button('変更内容をプレビュー').props.onClick())
 expect(api.previewDatabaseMigration).toHaveBeenLastCalledWith('app',{action:'preview',id:'link_people_v1',version:1,operations:[{...plan[0],matchResolutions:{Alex:'record-b'}}]})
 expect(button('本番への変更を確認').props.disabled).toBe(false)
 act(()=>tree.unmount())
})

test('database migration history shows verified plans and prepares an inverse only for verified additive changes',async()=>{
 const verified={id:'schema_v1',version:2,checksum:'abcdef1234567890',plan:[{op:'add_columns',entity:'primary',columns:[{name:'Priority',type:'number'}]}],inverseOperations:[{op:'drop_empty_column',entity:'primary',column:'priority'}],createdAt:'2026-11-09T00:00:00.000Z',integrityValid:true}
 const tampered={id:'schema_v2',version:3,checksum:'deadbeef01234567',plan:null,createdAt:'2026-11-09T01:00:00.000Z',integrityValid:false}
 const {tree}=await setup([],{fork:null,version:3,entities:[],migrations:[verified,tampered]})
 const history=tree.root.findByProps({'aria-label':'DB変更履歴'})
 expect(history.findAllByType('summary').map(item=>item.children.join(''))).toEqual(expect.arrayContaining([expect.stringContaining('schema_v1'),expect.stringContaining('schema_v2')]))
 expect(history.findByProps({role:'alert'}).children.join('')).toContain('整合性を確認できません')
 const plans=history.findAllByType('pre').map(item=>item.children.join(''))
 expect(plans).toHaveLength(1)
 expect(plans[0]).toContain('Priority')
 const rollback=tree.root.findAllByType('button').find(item=>item.children.join('')==='追加列を戻す変更案を作成')
 expect(rollback).toBeTruthy()
 await act(async()=>rollback!.props.onClick())
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual(verified.inverseOperations)
 expect(tree.root.findByProps({placeholder:'convert_amount_v1'}).props.value).toBe('rollback_schema_v1_v3')
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
