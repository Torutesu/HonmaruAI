import React from 'react'
import type {AutomationDefinition,Step,Trigger,Table} from '../utils/harness'

function triggerText(trigger:Trigger) {
 if(trigger.type==='manual')return '手動で実行したとき'
 if(trigger.type==='webhook')return 'Webhookを受信したとき'
 if(trigger.type==='row')return `データが${trigger.on==='added'?'追加':trigger.on==='changed'?'更新':'追加・更新'}されたとき`
 const cadence=({daily:'毎日',weekdays:'平日',weekly:'毎週',monthly:'毎月'} as Record<string,string>)[trigger.cadence||'']||trigger.cadence
 const day=trigger.cadence==='weekly'?` ${['日','月','火','水','木','金','土'][trigger.weekday??0]}曜日`:trigger.cadence==='monthly'?` ${trigger.monthday}日`:''
 return `${cadence}${day} ${String(trigger.hour??0).padStart(2,'0')}:${String(trigger.minute??0).padStart(2,'0')}（${trigger.timezone}）`
}
const labels={post:'ルームに投稿',agent:'エージェントに依頼',add_row:'レコードを追加',update_row:'レコードを更新',approval:'承認を依頼',followup:'後でフォローアップ'}
interface Resources {tables?:Table[];agents?:Array<{id:string;name:string}>}
function StepSummary({step,tables=[],agents=[],triggerTable}:{step:Step;triggerTable?:Table}&Resources) {
 const table=tables.find(t=>t.id===step.tableId)||triggerTable
 return <li><strong>{labels[step.type]}</strong>
  {step.channel&&<p>投稿先: {step.channel.replace(/^b:/,'#')}</p>}
  {step.agentId&&<p>エージェント: {agents.find(a=>a.id===step.agentId)?.name||step.agentId}</p>}
  {step.tableId&&<p>テーブル: {tables.find(t=>t.id===step.tableId)?.name||step.tableId}</p>}
  {step.to&&<p>承認者: {step.to}</p>}
  {step.minutes!==undefined&&<p>{step.minutes}分後</p>}
  {step.title&&<p>{step.title}</p>}
  {(step.text||step.prompt||step.summary)&&<p className="hx-automation-content">{step.text||step.prompt||step.summary}</p>}
  {step.values&&<dl>{Object.entries(step.values).map(([key,value])=><React.Fragment key={key}><dt>{table?.columns.find(c=>c.id===key)?.name||key}</dt><dd>{typeof value==='object'?JSON.stringify(value):String(value)}</dd></React.Fragment>)}</dl>}
 </li>
}
export function AutomationSummary({definition,tables=[],agents=[]}:{definition:AutomationDefinition|null}&Resources) {
 if(!definition)return <p>処理なし</p>
 const table=tables.find(t=>t.id===definition.trigger.tableId)
 return <div className="hx-automation-summary"><p><strong>{definition.name}</strong> · {definition.enabled?'有効':'停止'}</p><p>{triggerText(definition.trigger)}</p>
  {definition.trigger.tableId&&<p>対象テーブル: {table?.name||definition.trigger.tableId}</p>}
  {definition.trigger.column&&<p>対象列: {table?.columns.find(c=>c.id===definition.trigger.column)?.name||definition.trigger.column}</p>}
  {definition.trigger.where&&<dl>{Object.entries(definition.trigger.where).map(([key,values])=><React.Fragment key={key}><dt>{table?.columns.find(c=>c.id===key)?.name||key}</dt><dd>{values.join(' / ')}</dd></React.Fragment>)}</dl>}
  <ol>{definition.steps.map((step,index)=><StepSummary key={index} step={step} tables={tables} agents={agents} triggerTable={table}/>)}</ol>
  <details><summary>詳細データ</summary><pre>{JSON.stringify(definition,null,2)}</pre></details>
 </div>
}
