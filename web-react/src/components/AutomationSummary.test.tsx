import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect,test} from 'vitest'
import {AutomationSummary} from './AutomationSummary'
test('review describes schedule, targets, conditions and side effects without interpreting markup',()=>{
 const html=renderToStaticMarkup(<AutomationSummary definition={{name:'Review',enabled:true,trigger:{type:'schedule',cadence:'weekly',weekday:1,hour:9,minute:5,timezone:'Asia/Tokyo'},steps:[{type:'post',channel:'b:ops',text:'<script>alert(1)</script>'},{type:'approval',to:'owner',title:'Proceed?',summary:'Review change'},{type:'followup',minutes:60,text:'Reminder'}]}}/> )
 for(const text of ['毎週 月曜日 09:05','Asia/Tokyo','#ops','承認者: owner','60分後','詳細データ'])expect(html).toContain(text)
 expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;')
})
test('row conditions and disabled state remain visible in the review',()=>{
 const html=renderToStaticMarkup(<AutomationSummary definition={{name:'Rows',enabled:false,trigger:{type:'row',on:'changed',tableId:'tasks',column:'status',where:{status:['Done','Closed']}},steps:[{type:'update_row',values:{status:'Archived'}}]}}/> )
 for(const text of ['停止','更新','対象テーブル: tasks','対象列: status','Done / Closed','Archived'])expect(html).toContain(text)
})

test('review resolves authorized resource names while retaining unknown identifiers',()=>{
 const html=renderToStaticMarkup(<AutomationSummary tables={[{id:'table-id',name:'案件',columns:[{id:'status-id',name:'進捗',type:'select'}]}]} agents={[{id:'agent-id',name:'営業担当'}]} definition={{name:'確認',enabled:true,trigger:{type:'row',tableId:'table-id',column:'status-id',on:'changed',where:{'status-id':['完了']}},steps:[{type:'agent',agentId:'agent-id',prompt:'確認する'},{type:'update_row',values:{'status-id':'確認済み'}},{type:'agent',agentId:'unavailable-agent',prompt:'保留'}]}}/> )
 for(const text of ['対象テーブル: 案件','対象列: 進捗','エージェント: 営業担当','unavailable-agent'])expect(html).toContain(text)
 expect(html).toContain('<dt>進捗</dt>')
})

test('review describes cron, interval and one-time schedule forms',()=>{
 for (const [trigger,label] of [
  [{type:'schedule',kind:'cron',expr:'0 9 * * 1-5',timezone:'Asia/Tokyo'},'Cron 0 9 * * 1-5'],
  [{type:'schedule',kind:'every',everyMs:1800000},'30分ごと'],
  [{type:'schedule',kind:'at',at:'2026-10-27T00:00:00.000Z'},'一度だけ'],
 ] as const) {
  const html=renderToStaticMarkup(<AutomationSummary definition={{name:'Schedule',enabled:true,trigger:trigger as any,steps:[{type:'post',text:'Run'}]}}/> )
  expect(html).toContain(label)
 }
})
