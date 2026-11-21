import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

test('server action history loads own paged runs and only fetches a result when explicitly opened',async()=>{
 const runItem={id:'run-1',actionName:'report',actionVersion:3,status:'succeeded',createdAt:1000,startedAt:1001,finishedAt:1002}
 const api:any={
  appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),
  appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),
  actionRunHistory:vi.fn().mockResolvedValueOnce({runs:[runItem],nextCursor:'next-page'}).mockResolvedValueOnce({runs:[],nextCursor:undefined}),
  actionJob:vi.fn().mockResolvedValue({job:{...runItem,result:{stdout:'safe output'}}}),
 }
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<CompanyApp app={{id:'app'}as any} api={api} canManage reload={vi.fn()}/>);await Promise.resolve()})
 const button=(text:string)=>tree!.root.findAllByType('button').find(item=>item.children.join('')===text)!
 expect(api.actionRunHistory).not.toHaveBeenCalled()
 await act(async()=>button('Load execution history').props.onClick())
 expect(api.actionRunHistory).toHaveBeenCalledWith('app',undefined)
 expect(tree!.root.findAllByProps({role:'list'})).toHaveLength(0)
 expect(tree!.root.findAllByType('strong').some(item=>item.children.join('').includes('report'))).toBe(true)
 expect(tree!.root.findAllByType('pre').some(item=>item.children.join('').includes('safe output'))).toBe(false)
 await act(async()=>button('View result').props.onClick())
 expect(api.actionJob).toHaveBeenCalledWith('app','run-1')
 expect(tree!.root.findAllByType('pre').some(item=>item.children.join('').includes('safe output'))).toBe(true)
 await act(async()=>button('Load more runs').props.onClick())
 expect(api.actionRunHistory).toHaveBeenLastCalledWith('app','next-page')
 act(()=>tree!.unmount())
})

test('an opened in-progress action result refreshes automatically until it finishes',async()=>{
 vi.useFakeTimers()
 const runItem={id:'run-live',actionName:'report',actionVersion:2,status:'running',createdAt:1000,startedAt:1001,finishedAt:null}
 const api:any={
  appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),
  appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),
  actionRunHistory:vi.fn().mockResolvedValue({runs:[runItem]}),
  actionJob:vi.fn().mockResolvedValueOnce({job:{...runItem,result:null}}).mockResolvedValueOnce({job:{...runItem,status:'succeeded',finishedAt:1003,result:{stdout:'done'}}}),
 }
 let tree:ReturnType<typeof create>|undefined
 try{
  await act(async()=>{tree=create(<CompanyApp app={{id:'app'}as any} api={api} canManage reload={vi.fn()}/>);await Promise.resolve()})
  const button=(text:string)=>tree!.root.findAllByType('button').find(item=>item.children.join('')===text)!
  await act(async()=>button('Load execution history').props.onClick())
  await act(async()=>button('View result').props.onClick())
  expect(api.actionJob).toHaveBeenCalledTimes(1)
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000)})
  expect(api.actionJob).toHaveBeenCalledTimes(2)
  expect(tree!.root.findAllByType('pre').some(item=>item.children.join('').includes('done'))).toBe(true)
 }finally{
  if(tree)act(()=>tree!.unmount())
  vi.useRealTimers()
 }
})

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

test('typed column builder adds a select column with bounded options to the reviewed plan',async()=>{
 const {tree,api}=await setup()
 const name=tree.root.findByProps({'aria-label':'新しい列名'})
 await act(async()=>name.props.onChange({target:{value:'Status'}}))
 const type=tree.root.findByProps({'aria-label':'新しい列の型'})
 await act(async()=>type.props.onChange({target:{value:'select'}}))
 const options=tree.root.findByProps({'aria-label':'列の選択肢'})
 await act(async()=>options.props.onChange({target:{value:'Open, In progress, Done, Open'}}))
 const form=tree.root.findByProps({className:'hx-db-builder-form hx-db-column-builder'})
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual([{op:'add_columns',entity:'primary',columns:[{name:'Status',type:'select',options:['Open','In progress','Done']}]}])
 expect(api.previewDatabaseMigration).not.toHaveBeenCalled()
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('preview database schema builder sends an additive operation against its current revision',async()=>{
 const {tree,api}=await setup()
 const form=tree.root.findByProps({'aria-label':'検証DBの列を追加'})
 const name=form.findAllByType('input')[0]
 await act(async()=>name.props.onChange({target:{value:'Review status'}}))
 const type=form.findAllByType('select').at(-1)!
 await act(async()=>type.props.onChange({target:{value:'select'}}))
 const options=form.findAllByType('input').at(-1)!
 await act(async()=>options.props.onChange({target:{value:'Open, Done, Open'}}))
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'fork_schema',forkId:'private-fork',revision:4,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Review status',type:'select',options:['Open','Done']}]}]})
 act(()=>tree.unmount())
})

test('preview database advanced schema editor supports rename, conversion, drop and entity operations',async()=>{
 const {tree,api}=await setup()
 const form=tree.root.findByProps({'aria-label':'検証DBの高度なスキーマ変更'})
 const editor=tree.root.findByProps({'aria-label':'検証DBのスキーマ変更案'})
 const operations=[{op:'rename_column',entity:'primary',column:'task',name:'Title'},{op:'convert_column',entity:'primary',column:'amount',type:'number'},{op:'drop_empty_column',entity:'primary',column:'unused'},{op:'create_entity',entity:'people',name:'People',columns:[{name:'Name',type:'text'}]}]
 await act(async()=>editor.props.onChange({target:{value:JSON.stringify(operations,null,2)}}))
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'fork_schema',forkId:'private-fork',revision:4,operations})
 expect(tree.root.findAllByType('summary').some(item=>item.children.join('')==='列の変換・削除・テーブル追加')).toBe(true)
 act(()=>tree.unmount())
})

test('preview database queues deletion of an empty secondary entity without applying it',async()=>{
 const fork={id:'private-fork',revision:4,entities:[
  {key:'primary',table:{id:'table',name:'Tasks',columns:[]},rows:[]},
  {key:'people',table:{id:'people-table',name:'People',columns:[{id:'name',name:'Name',type:'text'}]},rows:[]},
 ]}
 const {tree,api}=await setup([],{fork,version:1,entities:fork.entities,migrations:[]})
 const deleteProposal=tree.root.findAllByType('button').find(item=>item.children.join('')==='「People」の空テーブル削除案を追加')!
 await act(async()=>deleteProposal.props.onClick())
 expect(JSON.parse(tree.root.findByProps({'aria-label':'検証DBのスキーマ変更案'}).props.value)).toEqual([{op:'drop_entity',entity:'people'}])
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('legacy preview warns before adopting current production as an explicit baseline',async()=>{
 const fork={id:'legacy-fork',revision:8,hasBaseline:false,entities:[{key:'primary',table:{id:'table',name:'Tasks',columns:[]},rows:[{id:'row',values:{name:'Draft'},updatedAt:'2026-11-01T00:00:00.000Z'}]}]}
 const {tree,button,api}=await setup([],{fork,version:3,entities:fork.entities,migrations:[]})
 expect(tree.root.findByProps({'aria-label':'旧検証DBの比較基準'})).toBeTruthy()
 await act(async()=>button('古い検証DBの差分を引き継ぐ').props.onClick())
 expect(api.databaseChange).not.toHaveBeenCalled()
 expect(tree.root.findByProps({role:'alertdialog'})).toBeTruthy()
 await act(async()=>button('キャンセル').props.onClick())
 expect(api.databaseChange).not.toHaveBeenCalled()
 await act(async()=>button('古い検証DBの差分を引き継ぐ').props.onClick())
 await act(async()=>button('現在の本番を基準に保存').props.onClick())
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'fork_rebase_legacy',forkId:'legacy-fork',revision:8})
 act(()=>tree.unmount())
})

test('existing column rename builder uses the stable column ID without applying it',async()=>{
 const database={fork:null,version:2,entities:[{key:'primary',table:{id:'tasks',name:'Tasks',columns:[{id:'old_name',name:'Old name',type:'text'},{id:'status',name:'Status',type:'select',options:['Open','Done']}]}}],migrations:[]}
 const {tree,api}=await setup([],database)
 const form=tree.root.findByProps({className:'hx-db-builder-form hx-db-manage-column'})
 const rename=tree.root.findByProps({'aria-label':'変更後の列名'})
 await act(async()=>rename.props.onChange({target:{value:'Account name'}}))
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual([{op:'rename_column',entity:'primary',column:'old_name',name:'Account name'}])
 expect(api.previewDatabaseMigration).not.toHaveBeenCalled()
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('existing column conversion builder adds select options to the reviewed migration plan',async()=>{
 const database={fork:null,version:2,entities:[{key:'primary',table:{id:'tasks',name:'Tasks',columns:[{id:'status',name:'Status',type:'text'}]}}],migrations:[]}
 const {tree,api}=await setup([],database)
 const action=tree.root.findByProps({'aria-label':'列の変更操作'})
 await act(async()=>action.props.onChange({target:{value:'convert'}}))
 const type=tree.root.findByProps({'aria-label':'変更後の列型'})
 await act(async()=>type.props.onChange({target:{value:'select'}}))
 const options=tree.root.findByProps({'aria-label':'変換後の選択肢'})
 await act(async()=>options.props.onChange({target:{value:'Open, Done, Open'}}))
 const form=tree.root.findByProps({className:'hx-db-builder-form hx-db-manage-column'})
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual([{op:'convert_column',entity:'primary',column:'status',type:'select',options:['Open','Done']}])
 expect(api.previewDatabaseMigration).not.toHaveBeenCalled()
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('existing column relation conversion captures explicit target and cardinality',async()=>{
 const database={fork:null,version:2,entities:[{key:'primary',table:{id:'tasks',name:'Tasks',columns:[{id:'owners',name:'Owners',type:'text'}]}},{key:'people',table:{id:'people',name:'People',columns:[{id:'name',name:'Name',type:'text'}]}}],migrations:[]}
 const {tree,api}=await setup([],database)
 const action=tree.root.findByProps({'aria-label':'列の変更操作'})
 await act(async()=>action.props.onChange({target:{value:'convert'}}))
 const type=tree.root.findByProps({'aria-label':'変更後の列型'})
 await act(async()=>type.props.onChange({target:{value:'relation'}}))
 const target=tree.root.findByProps({'aria-label':'変換先Relationテーブル'})
 await act(async()=>target.props.onChange({target:{value:'people'}}))
 const cardinality=tree.root.findByProps({'aria-label':'変換先Relationの件数'})
 await act(async()=>cardinality.props.onChange({target:{value:'multiple'}}))
 const form=tree.root.findByProps({className:'hx-db-builder-form hx-db-manage-column'})
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual([{op:'convert_column',entity:'primary',column:'owners',type:'relation',targetEntity:'people',multiple:true}])
 expect(api.previewDatabaseMigration).not.toHaveBeenCalled()
 expect(api.databaseChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('empty-column removal is only proposed and remains subject to migration preview',async()=>{
 const database={fork:null,version:2,entities:[{key:'primary',table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'},{id:'legacy',name:'Legacy',type:'text'}]}}],migrations:[]}
 const {tree,api}=await setup([],database)
 const action=tree.root.findByProps({'aria-label':'列の変更操作'})
 await act(async()=>action.props.onChange({target:{value:'drop'}}))
 const column=tree.root.findByProps({'aria-label':'編集する列'})
 await act(async()=>column.props.onChange({target:{value:'legacy'}}))
 const form=tree.root.findByProps({className:'hx-db-builder-form hx-db-manage-column'})
 await act(async()=>form.props.onSubmit({preventDefault:vi.fn()}))
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual([{op:'drop_empty_column',entity:'primary',column:'legacy'}])
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

test('database migration history shows verified plans and prepares an inverse only for verified reversible schema changes',async()=>{
 const verified={id:'schema_v1',version:2,checksum:'abcdef1234567890',plan:[{op:'add_columns',entity:'primary',columns:[{name:'Priority',type:'number'}]},{op:'rename_column',entity:'primary',column:'task',name:'Title'}],inverseOperations:[{op:'rename_column',entity:'primary',column:'task',name:'Task'},{op:'drop_empty_column',entity:'primary',column:'priority'}],createdAt:'2026-11-09T00:00:00.000Z',integrityValid:true}
 const tampered={id:'schema_v2',version:3,checksum:'deadbeef01234567',plan:null,createdAt:'2026-11-09T01:00:00.000Z',integrityValid:false}
 const {tree,api,button}=await setup([],{fork:null,version:3,entities:[],migrations:[verified,tampered]})
 const history=tree.root.findByProps({'aria-label':'DB変更履歴'})
 expect(history.findAllByType('summary').map(item=>item.children.join(''))).toEqual(expect.arrayContaining([expect.stringContaining('schema_v1'),expect.stringContaining('schema_v2')]))
 expect(history.findByProps({role:'alert'}).children.join('')).toContain('整合性を確認できません')
 const plans=history.findAllByType('pre').map(item=>item.children.join(''))
 expect(plans).toHaveLength(1)
 expect(plans[0]).toContain('Priority')
 const rollback=tree.root.findAllByType('button').find(item=>/rollback|逆変更|ロールバック/i.test(item.children.join('')))
 expect(rollback).toBeTruthy()
 await act(async()=>rollback!.props.onClick())
 expect(JSON.parse(tree.root.findByProps({'aria-label':'DB変更案'}).props.value)).toEqual(verified.inverseOperations)
 expect(tree.root.findByProps({placeholder:'convert_amount_v1'}).props.value).toBe('rollback_schema_v1_v3')
 expect(api.databaseChange).not.toHaveBeenCalled()
 await act(async()=>button('変更内容をプレビュー').props.onClick())
 expect(api.previewDatabaseMigration).toHaveBeenLastCalledWith('app',{action:'preview',id:'rollback_schema_v1_v3',version:3,operations:verified.inverseOperations})
 expect(api.databaseChange).not.toHaveBeenCalled()
 await act(async()=>button('本番への変更を確認').props.onClick())
 await act(async()=>button('このDB変更を適用').props.onClick())
 expect(api.databaseChange).toHaveBeenCalledWith('app',{action:'migrate',id:'rollback_schema_v1_v3',version:3,operations:verified.inverseOperations,previewChecksum:'reviewed-schema-digest'})
 act(()=>tree.unmount())
})

test('database migration history explains when the bounded rollback snapshot was omitted',async()=>{
 const oversized={id:'large_snapshot',version:2,checksum:'abcdef1234567890',plan:[],inverseOperations:null,rollbackUnavailableReason:'snapshot_limit' as const,createdAt:'2026-11-09T00:00:00.000Z',integrityValid:true}
 const {tree}=await setup([],{fork:null,version:2,entities:[],migrations:[oversized]})
 expect(tree.root.findAllByType('p').some(item=>/上限|safe rollback|snapshot/i.test(item.children.join('')))).toBe(true)
 act(()=>tree.unmount())
})

test('database migration history explains legacy rollback limits only for verified journals',async()=>{
 const legacy={id:'legacy_schema_v1',version:1,checksum:'abcdef1234567890',plan:[{op:'add_columns',entity:'primary',columns:[{name:'Legacy',type:'text'}]}],inverseOperations:null,rollbackUnavailableReason:'legacy_format',createdAt:'2026-11-09T00:00:00.000Z',integrityValid:true}
 const tampered={...legacy,id:'tampered_legacy',integrityValid:false,plan:null,rollbackUnavailableReason:'legacy_format'}
 const {tree}=await setup([],{fork:null,version:1,entities:[],migrations:[legacy,tampered]})
 const history=tree.root.findByProps({'aria-label':'DB変更履歴'})
 expect(history.findAllByType('p').some(item=>item.children.join('').includes('original data was not saved'))).toBe(true)
 expect(history.findAllByType('button').some(item=>item.children.join('').includes('ロールバック'))).toBe(false)
 expect(history.findAllByType('p').some(item=>item.children.join('').includes('tampered_legacy'))).toBe(false)
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

test('Google OAuth connection starts from the saved App connection without exposing a client secret',async()=>{
 const connection={name:'google_api',version:2,endpoint:'https://www.googleapis.com/drive/v3/files',method:'GET',enabled:1,hasToken:1,authMode:'oauth',oauthProvider:'google',oauthClientId:'1234567890-abcdefgh.apps.googleusercontent.com',oauthScope:'drive.readonly',oauthConfigured:true,oauthConnected:false,oauthRequiresReauthorization:false,owned:true}
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[connection]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),connectionChange:vi.fn().mockResolvedValue({authorizeUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=high-entropy'})}
 const popup={opener:{},location:{replace:vi.fn()},close:vi.fn()};const open=vi.fn(()=>popup)
 vi.stubGlobal('window',{open});vi.stubGlobal('location',{origin:'https://example.com'})
 let tree!:ReturnType<typeof create>
 try{
  await act(async()=>{tree=create(<CompanyApp app={{id:'app'} as any} api={api} canManage reload={()=>{}}/>);await Promise.resolve()})
  const button=(name:string)=>tree.root.findAllByType('button').find(item=>item.children.join('')===name)!
  await act(async()=>button('外部接続').props.onClick())
  await act(async()=>tree.root.findAllByType('button').find(item=>item.children.join('').startsWith('google_api'))!.props.onClick())
  const authSelect=tree.root.findAllByType('select').find(item=>item.findAllByType('option').some(option=>option.props.value==='oauth'))!
  await act(async()=>authSelect.props.onChange({target:{value:'oauth'}}))
  expect(tree.root.findAllByType('input').some(input=>input.props.type==='password'&&input.props.value)).toBe(false)
  await act(async()=>button('Googleアカウントを接続').props.onClick())
  expect(api.connectionChange).toHaveBeenCalledWith('app',{action:'oauth_start',name:'google_api'})
  expect(open).toHaveBeenCalledWith('about:blank','_blank')
  expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=high-entropy')
 }finally{vi.unstubAllGlobals();if(tree)act(()=>tree.unmount())}
})
