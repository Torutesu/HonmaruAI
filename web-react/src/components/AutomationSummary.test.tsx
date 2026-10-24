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
