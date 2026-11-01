import React from 'react'
import type {Trigger,TriggerType,Table,App,AppEntity,Column,ConditionScalar} from '../utils/harness'
import {ScheduleTriggerFields} from './ScheduleTriggerFields'

const conditionIncludes=(condition:ConditionScalar|ConditionScalar[]|undefined,value:string)=>
 Array.isArray(condition)?condition.includes(value):condition===value
const validDateCondition=(value:string)=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false
 const date=new Date(`${value}T00:00:00Z`)
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value
}

export interface TriggerAppOption {app:Pick<App,'id'|'name'>;entities:AppEntity[]}
export function AutomationTriggerEditor({trigger,tables,apps=[],onChange}:{trigger:Trigger;tables:Table[];apps?:TriggerAppOption[];onChange:(trigger:Trigger)=>void}) {
 const rowFiltersBeforeDelete=React.useRef<{tableId:string|undefined;where:Trigger['where'];column:Trigger['column']}|null>(null)
 const [rowRestoreWarning,setRowRestoreWarning]=React.useState(false)
 React.useEffect(()=>{rowFiltersBeforeDelete.current=null;setRowRestoreWarning(false)},[trigger.type,trigger.tableId])
 const table=tables.find(t=>t.id===trigger.tableId)
 const app=apps.find(value=>value.app.id===trigger.appId)
 const entity=app?.entities.find(value=>value.key===trigger.entityId)
 // Older and API-created row filters may contain scalars or non-select
 // conditions even though the legacy UI type only describes string arrays.
 const rowWhere=trigger.where as unknown as Record<string,ConditionScalar|ConditionScalar[]>|undefined
 const rowResolvesTo=(column:Column,key:string)=>
  table?.columns.find(candidate=>candidate.id===key||candidate.name.toLowerCase()===key.toLowerCase())?.id===column.id
 const rowConditionKeys=(column:Column)=>Object.keys(rowWhere||{}).filter(key=>rowResolvesTo(column,key))
 // Resolve names exactly as the Worker does. Keep an existing name key when
 // editing so a second, conflicting condition is not silently introduced.
 const resolvesTo=(column:Column,key:string)=>
  entity?.table.columns.find(candidate=>candidate.id===key||candidate.name.toLowerCase()===key.toLowerCase())?.id===column.id
 const conditionKeys=(column:Column)=>Object.keys(trigger.when?.where||{}).filter(key=>resolvesTo(column,key))
 const change=(patch:Partial<Trigger>)=>onChange({...trigger,...patch})
 const setWhere=(key:string,value:ConditionScalar|ConditionScalar[]|undefined)=>{
  const where={...trigger.when?.where}
  if(value===undefined||(Array.isArray(value)&&!value.length)){delete where[key]}else Object.defineProperty(where,key,{value,enumerable:true,configurable:true,writable:true})
  change({when:Object.keys(where).length?{where}:undefined})
 }
 const setRowWhere=(key:string,value:ConditionScalar|ConditionScalar[]|undefined)=>{
  const where={...rowWhere}
  if(value===undefined||(Array.isArray(value)&&!value.length)){delete where[key]}else Object.defineProperty(where,key,{value,enumerable:true,configurable:true,writable:true})
  change({where:Object.keys(where).length?where as unknown as Record<string,string[]>:undefined})
 }
 return <div className="hx-step"><label>実行条件<select value={trigger.type} onChange={e=>{
  const type=e.target.value as TriggerType
  rowFiltersBeforeDelete.current=null;setRowRestoreWarning(false)
  onChange(type==='schedule'?{type,cadence:'daily',hour:9,minute:0,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}:type==='row'?{type,tableId:tables[0]?.id||'',on:'changed'}:type==='app_record_change'?{type,appId:apps[0]?.app.id||'',entityId:apps[0]?.entities[0]?.key||'',events:['insert','update']}:{type})
 }}><option value="manual">手動実行</option><option value="schedule">スケジュール</option><option value="row">データ変更</option><option value="app_record_change">アプリのレコード変更</option><option value="webhook">Webhook受信</option></select></label>
 {trigger.type==='schedule'&&<ScheduleTriggerFields trigger={trigger} onChange={onChange}/>}
 {trigger.type==='row'&&<>
  <label>対象テーブル<select value={trigger.tableId||''} onChange={e=>{rowFiltersBeforeDelete.current=null;setRowRestoreWarning(false);onChange({type:'row',on:trigger.on||'changed',tableId:e.target.value})}}><option value="">選択してください</option>{tables.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
  <label>変更の種類<select value={trigger.on||'changed'} onChange={e=>{const on=e.target.value as Trigger['on'];if(on==='deleted'){rowFiltersBeforeDelete.current={tableId:trigger.tableId,where:trigger.where,column:trigger.column};change({on,where:undefined,column:undefined})}else{const saved=trigger.on==='deleted'&&rowFiltersBeforeDelete.current?.tableId===trigger.tableId?rowFiltersBeforeDelete.current:null;setRowRestoreWarning(previous=>previous||(trigger.on==='deleted'&&!saved));rowFiltersBeforeDelete.current=null;change({on,...(saved?{where:saved.where,column:saved.column}:{})})}}}><option value="added">追加</option><option value="changed">更新</option><option value="deleted">削除</option><option value="any">追加・更新</option></select></label>
  {trigger.on==='deleted'&&<small>削除イベントにはフィールド条件と監視列を適用できません。{rowFiltersBeforeDelete.current?'編集中に別の種類へ戻すと、元の条件を復元します。':'保存・再読み込み後は以前の条件を自動復元できません。'}</small>}
  {rowRestoreWarning&&<p role="alert">以前の条件は復元されていません。実行対象が広がる可能性があります。保存・公開前に条件と監視列を設定してください。</p>}
  {trigger.on!=='deleted'&&<>
   <label>更新を監視する列<select value={table?.columns.find(c=>trigger.column&&rowResolvesTo(c,trigger.column))?.id||trigger.column||''} onChange={e=>{const column=table?.columns.find(c=>c.id===e.target.value);change({column:column?[column.id,column.name].find(key=>rowResolvesTo(column,key)):e.target.value||undefined})}}><option value="">すべての列</option>{trigger.column&&!table?.columns.some(c=>rowResolvesTo(c,trigger.column!))&&<option value={trigger.column}>不明な列: {trigger.column}</option>}{table?.columns.map(c=><option key={c.id} value={c.id} disabled={![c.id,c.name].some(key=>rowResolvesTo(c,key))}>{c.name}</option>)}</select></label>
   {table?.columns.filter(c=>c.type==='select').map(column=>{
    const keys=rowConditionKeys(column),safeKey=[column.id,column.name].find(candidate=>rowResolvesTo(column,candidate))
    const key=keys[0]||safeKey||column.id,condition=rowWhere&&Object.hasOwn(rowWhere,key)?rowWhere[key]:undefined
    const supported=condition===undefined||(Array.isArray(condition)?condition.length>0&&condition.every(value=>typeof value==='string'&&column.options?.includes(value)):typeof condition==='string'&&column.options?.includes(condition))
    const locked=keys.length>1||(!keys.length&&!safeKey)||!supported
    return <React.Fragment key={column.id}><fieldset disabled={locked}><legend>{column.name}の条件</legend>{locked?<small>この条件は現在の画面では編集できません。既存の条件は保持されます。{keys.length>0&&<code>{JSON.stringify(Object.fromEntries(keys.map(name=>[name,rowWhere?.[name]])))}</code>}</small>:<>{column.options?.map(value=><label key={value}><input type="checkbox" checked={conditionIncludes(condition,value)} onChange={e=>{const values=Array.isArray(condition)?condition:condition===undefined?[]:[condition];setRowWhere(key,e.target.checked?[...values,value]:values.filter(v=>v!==value))}}/>{value}</label>)}<small>選択しない場合はすべての値が対象です。</small></>}</fieldset>{locked&&keys.length>0&&<div><small>条件を削除すると、公開後の実行対象が広がる場合があります。</small>{keys.map(name=><button type="button" key={name} onClick={()=>setRowWhere(name,undefined)} aria-label={`${name}の条件を削除`}>{name}の条件を削除</button>)}</div>}</React.Fragment>
   })}
   {table&&Object.keys(rowWhere||{}).some(key=>!table.columns.some(column=>column.type==='select'&&rowResolvesTo(column,key)))&&<div role="alert"><p>この画面で編集できない条件があります。削除すると、公開後の実行対象が広がる場合があります。</p>{Object.keys(rowWhere||{}).filter(key=>!table.columns.some(column=>column.type==='select'&&rowResolvesTo(column,key))).map(key=><div key={key}><code>{key}: {JSON.stringify(rowWhere?.[key])}</code> <button type="button" onClick={()=>setRowWhere(key,undefined)} aria-label={`${key}の条件を削除`}>条件を削除</button></div>)}</div>}
   <small>削除イベントにはレコードの値は含まれません。</small>
  </>}
 </>}
 {trigger.type==='app_record_change'&&<>
  <label>対象アプリ<select value={trigger.appId||''} onChange={e=>{const next=apps.find(value=>value.app.id===e.target.value);onChange({type:'app_record_change',appId:e.target.value,entityId:next?.entities[0]?.key||'',events:trigger.events?.length?trigger.events:['insert','update']})}}><option value="">選択してください</option>{apps.map(value=><option key={value.app.id} value={value.app.id}>{value.app.name}</option>)}</select></label>
  <label>対象エンティティ<select value={trigger.entityId||''} onChange={e=>change({entityId:e.target.value,when:undefined})}><option value="">選択してください</option>{app?.entities.map(value=><option key={value.key} value={value.key}>{value.table.name}</option>)}</select></label>
  <fieldset><legend>変更イベント</legend>{(['insert','update','delete'] as const).map(event=><label key={event}><input type="checkbox" checked={trigger.events?.includes(event)||false} onChange={e=>{const events=new Set(trigger.events||[]);e.target.checked?events.add(event):events.delete(event);change({events:[...events] as Trigger['events']})}}/>{event==='insert'?'追加':event==='update'?'更新':'削除'}</label>)}</fieldset>
  {entity?.table.columns.map(column=>{
   const keys=conditionKeys(column),safeKey=[column.id,column.name].find(candidate=>resolvesTo(column,candidate))
   const key=keys[0]||safeKey||column.id,where=trigger.when?.where
   const condition=where&&Object.hasOwn(where,key)?where[key]:undefined
   const supported=condition===undefined||(column.type==='select'
    ? (Array.isArray(condition)?condition.length>0&&condition.every(value=>typeof value==='string'&&column.options?.includes(value)):typeof condition==='string'&&column.options?.includes(condition))
    : column.type==='checkbox'?typeof condition==='boolean'
    : column.type==='number'?typeof condition==='number'&&Number.isFinite(condition)
    : typeof condition==='string'&&condition!==''&&(column.type!=='date'||validDateCondition(condition)))
   const locked=keys.length>1||(!keys.length&&!safeKey)||!supported
   return <React.Fragment key={column.id}><fieldset disabled={locked}><legend>{column.name}の条件</legend>
    {locked?<small>この条件は現在の画面では編集できません。既存の条件は保持されます。{keys.length>0&&<code>{JSON.stringify(Object.fromEntries(keys.map(name=>[name,where?.[name]])))}</code>}</small>:column.type==='select'?<>{column.options?.map(value=><label key={value}><input type="checkbox" checked={conditionIncludes(condition,value)} onChange={e=>{const values=Array.isArray(condition)?condition:condition===undefined?[]:[condition];setWhere(key,e.target.checked?[...values,value]:values.filter(v=>v!==value))}}/>{value}</label>)}<small>選択しない場合はすべての値が対象です。</small></>:column.type==='checkbox'?<label>等しい<select value={condition===true?'true':condition===false?'false':''} onChange={e=>setWhere(key,e.target.value===''?undefined:e.target.value==='true')}><option value="">すべて</option><option value="true">チェック済み</option><option value="false">未チェック</option></select></label>:<label>等しい<input type={column.type==='number'?'number':column.type==='date'?'date':'text'} value={String(condition??'')} onChange={e=>setWhere(key,e.target.value===''?undefined:column.type==='number'?Number(e.target.value):e.target.value)}/></label>}
   </fieldset>{locked&&keys.length>0&&<div><small>条件を削除すると、公開後の実行対象が広がる場合があります。</small>{keys.map(name=><button type="button" key={name} onClick={()=>setWhere(name,undefined)} aria-label={`${name}の条件を削除`}>{name}の条件を削除</button>)}</div>}</React.Fragment>
  })}
  {entity&&Object.keys(trigger.when?.where||{}).some(key=>!entity.table.columns.some(column=>resolvesTo(column,key)))&&<div role="alert"><p>現在のフィールドに対応しない条件があります。保存するには修復が必要です。条件を削除すると、公開後の実行対象が広がる場合があります。</p>{Object.keys(trigger.when?.where||{}).filter(key=>!entity.table.columns.some(column=>resolvesTo(column,key))).map(key=><div key={key}><code>{key}: {JSON.stringify(trigger.when?.where[key])}</code> <button type="button" onClick={()=>setWhere(key,undefined)} aria-label={`${key}の条件を削除`}>条件を削除</button></div>)}</div>}
  {trigger.events?.includes('delete')&&trigger.when?.where&&<small>削除イベントにはフィールド値がないため、この条件には一致しません。</small>}
  {!apps.length&&<p className="row-sub">利用できるアプリがありません。</p>}
 </>}
 {trigger.type==='row'&&tables.length===0&&<div className="row-sub">先にアプリを作成してください。</div>}
 {trigger.type==='webhook'&&<p>公開すると、この自動化専用のWebhookが作成されます。</p>}
 </div>
}
