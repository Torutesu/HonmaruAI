import React from 'react'
import type {Trigger,TriggerType,Table} from '../utils/harness'
export function AutomationTriggerEditor({trigger,tables,onChange}:{trigger:Trigger;tables:Table[];onChange:(trigger:Trigger)=>void}) {
 const table=tables.find(t=>t.id===trigger.tableId)
 const change=(patch:Partial<Trigger>)=>onChange({...trigger,...patch})
 return <div className="hx-step"><label>実行条件<select value={trigger.type} onChange={e=>{
  const type=e.target.value as TriggerType
  onChange(type==='schedule'?{type,cadence:'daily',hour:9,minute:0,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}:type==='row'?{type,tableId:tables[0]?.id||'',on:'changed'}:{type})
 }}><option value="manual">手動実行</option><option value="schedule">スケジュール</option><option value="row">データ変更</option><option value="webhook">Webhook受信</option></select></label>
 {trigger.type==='schedule'&&<>
  <label>繰り返し<select value={trigger.cadence} onChange={e=>change({cadence:e.target.value,...(e.target.value==='weekly'?{weekday:trigger.weekday??1}:{}),...(e.target.value==='monthly'?{monthday:trigger.monthday??1}:{})})}><option value="daily">毎日</option><option value="weekdays">平日</option><option value="weekly">毎週</option><option value="monthly">毎月</option></select></label>
  {trigger.cadence==='weekly'&&<label>曜日<select value={trigger.weekday??1} onChange={e=>change({weekday:Number(e.target.value)})}>{['日','月','火','水','木','金','土'].map((day,i)=><option key={day} value={i}>{day}曜日</option>)}</select></label>}
  {trigger.cadence==='monthly'&&<label>日付<input type="number" min={1} max={31} value={trigger.monthday??1} onChange={e=>change({monthday:Number(e.target.value)})}/></label>}
  <label>時刻<input type="time" value={`${String(trigger.hour??9).padStart(2,'0')}:${String(trigger.minute??0).padStart(2,'0')}`} onChange={e=>{if(!e.target.value)return;const [hour,minute]=e.target.value.split(':').map(Number);change({hour,minute})}}/></label>
  <label>タイムゾーン<input value={trigger.timezone||''} placeholder="Asia/Tokyo" onChange={e=>change({timezone:e.target.value})}/></label>
 </>}
 {trigger.type==='row'&&<>
  <label>対象テーブル<select value={trigger.tableId||''} onChange={e=>onChange({type:'row',on:trigger.on||'changed',tableId:e.target.value})}><option value="">選択してください</option>{tables.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
  <label>変更の種類<select value={trigger.on||'changed'} onChange={e=>change({on:e.target.value as Trigger['on']})}><option value="added">追加</option><option value="changed">更新</option><option value="any">追加・更新</option></select></label>
  <label>更新を監視する列<select value={trigger.column||''} onChange={e=>change({column:e.target.value||undefined})}><option value="">すべての列</option>{table?.columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
  {table?.columns.filter(c=>c.type==='select').map(c=><fieldset key={c.id}><legend>{c.name}の条件</legend>{c.options?.map(value=><label key={value}><input type="checkbox" checked={trigger.where?.[c.id]?.includes(value)||false} onChange={e=>{const values=trigger.where?.[c.id]||[];const next=e.target.checked?[...values,value]:values.filter(v=>v!==value);const where={...trigger.where};if(next.length)where[c.id]=next;else delete where[c.id];change({where:Object.keys(where).length?where:undefined})}}/>{value}</label>)}<small>選択しない場合はすべての値が対象です。</small></fieldset>)}
 </>}
 {trigger.type==='webhook'&&<p>公開すると、この自動化専用のWebhookが作成されます。</p>}
 </div>
}
