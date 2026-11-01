import React from 'react'
import type {Trigger,TriggerType,Table,App,AppEntity,ConditionScalar} from '../utils/harness'
import {ScheduleTriggerFields} from './ScheduleTriggerFields'

const conditionIncludes=(condition:ConditionScalar|ConditionScalar[]|undefined,value:string)=>
 Array.isArray(condition)?condition.includes(value):condition===value

export interface TriggerAppOption {app:Pick<App,'id'|'name'>;entities:AppEntity[]}
export function AutomationTriggerEditor({trigger,tables,apps=[],onChange}:{trigger:Trigger;tables:Table[];apps?:TriggerAppOption[];onChange:(trigger:Trigger)=>void}) {
 const table=tables.find(t=>t.id===trigger.tableId)
 const app=apps.find(value=>value.app.id===trigger.appId)
 const entity=app?.entities.find(value=>value.key===trigger.entityId)
 const change=(patch:Partial<Trigger>)=>onChange({...trigger,...patch})
 const setWhere=(key:string,value:ConditionScalar|ConditionScalar[]|undefined)=>{
  const where={...trigger.when?.where}
  if(value===undefined||(Array.isArray(value)&&!value.length))delete where[key];else where[key]=value
  change({when:Object.keys(where).length?{where}:undefined})
 }
 return <div className="hx-step"><label>実行条件<select value={trigger.type} onChange={e=>{
  const type=e.target.value as TriggerType
  onChange(type==='schedule'?{type,cadence:'daily',hour:9,minute:0,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}:type==='row'?{type,tableId:tables[0]?.id||'',on:'changed'}:type==='app_record_change'?{type,appId:apps[0]?.app.id||'',entityId:apps[0]?.entities[0]?.key||'',events:['insert','update']}:{type})
 }}><option value="manual">手動実行</option><option value="schedule">スケジュール</option><option value="row">データ変更</option><option value="app_record_change">アプリのレコード変更</option><option value="webhook">Webhook受信</option></select></label>
 {trigger.type==='schedule'&&<ScheduleTriggerFields trigger={trigger} onChange={onChange}/>}
 {trigger.type==='row'&&<>
  <label>対象テーブル<select value={trigger.tableId||''} onChange={e=>onChange({type:'row',on:trigger.on||'changed',tableId:e.target.value})}><option value="">選択してください</option>{tables.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
  <label>変更の種類<select value={trigger.on||'changed'} onChange={e=>change({on:e.target.value as Trigger['on'],...(e.target.value==='deleted'?{where:undefined,column:undefined}:{})})}><option value="added">追加</option><option value="changed">更新</option><option value="deleted">削除</option><option value="any">追加・更新</option></select></label>
  {trigger.on!=='deleted'&&<>
   <label>更新を監視する列<select value={trigger.column||''} onChange={e=>change({column:e.target.value||undefined})}><option value="">すべての列</option>{table?.columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   {table?.columns.filter(c=>c.type==='select').map(c=><fieldset key={c.id}><legend>{c.name}の条件</legend>{c.options?.map(value=><label key={value}><input type="checkbox" checked={trigger.where?.[c.id]?.includes(value)||false} onChange={e=>{const values=trigger.where?.[c.id]||[];const next=e.target.checked?[...values,value]:values.filter(v=>v!==value);const where={...trigger.where};if(next.length)where[c.id]=next;else delete where[c.id];change({where:Object.keys(where).length?where:undefined})}}/>{value}</label>)}<small>選択しない場合はすべての値が対象です。</small></fieldset>)}
   <small>削除イベントにはレコードの値は含まれません。</small>
  </>}
 </>}
 {trigger.type==='app_record_change'&&<>
  <label>対象アプリ<select value={trigger.appId||''} onChange={e=>{const next=apps.find(value=>value.app.id===e.target.value);onChange({type:'app_record_change',appId:e.target.value,entityId:next?.entities[0]?.key||'',events:trigger.events?.length?trigger.events:['insert','update']})}}><option value="">選択してください</option>{apps.map(value=><option key={value.app.id} value={value.app.id}>{value.app.name}</option>)}</select></label>
  <label>対象エンティティ<select value={trigger.entityId||''} onChange={e=>change({entityId:e.target.value,when:undefined})}><option value="">選択してください</option>{app?.entities.map(value=><option key={value.key} value={value.key}>{value.table.name}</option>)}</select></label>
  <fieldset><legend>変更イベント</legend>{(['insert','update','delete'] as const).map(event=><label key={event}><input type="checkbox" checked={trigger.events?.includes(event)||false} onChange={e=>{const events=new Set(trigger.events||[]);e.target.checked?events.add(event):events.delete(event);change({events:[...events] as Trigger['events']})}}/>{event==='insert'?'追加':event==='update'?'更新':'削除'}</label>)}</fieldset>
  {entity?.table.columns.map(column=><fieldset key={column.id}><legend>{column.name}の条件</legend>{column.type==='select'?<>{column.options?.map(value=><label key={value}><input type="checkbox" checked={conditionIncludes(trigger.when?.where[column.id],value)} onChange={e=>{const old=trigger.when?.where[column.id];const values=Array.isArray(old)?old:old===undefined?[]:[old];setWhere(column.id,e.target.checked?[...values,value]:values.filter(v=>v!==value))}}/>{value}</label>)}<small>選択しない場合はすべての値が対象です。</small></>:column.type==='checkbox'?<label>等しい<select value={trigger.when?.where[column.id]===true?'true':trigger.when?.where[column.id]===false?'false':''} onChange={e=>setWhere(column.id,e.target.value===''?undefined:e.target.value==='true')}><option value="">すべて</option><option value="true">チェック済み</option><option value="false">未チェック</option></select></label>:<label>等しい<input type={column.type==='number'?'number':column.type==='date'?'date':'text'} value={String(trigger.when?.where[column.id]??'')} onChange={e=>setWhere(column.id,e.target.value===''?undefined:column.type==='number'?Number(e.target.value):e.target.value)}/></label>}</fieldset>)}
  {trigger.events?.includes('delete')&&trigger.when?.where&&<small>削除イベントにはフィールド値がないため、この条件には一致しません。</small>}
  {!apps.length&&<p className="row-sub">利用できるアプリがありません。</p>}
 </>}
 {trigger.type==='row'&&tables.length===0&&<div className="row-sub">先にアプリを作成してください。</div>}
 {trigger.type==='webhook'&&<p>公開すると、この自動化専用のWebhookが作成されます。</p>}
 </div>
}
