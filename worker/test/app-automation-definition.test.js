import {expect,test} from 'vitest';
import {normalizeAppAutomations,sameAutomation,diffAppAutomations} from '../src/harness/appAutomationDefinition.js';
const item=()=>({key:'invoice_reminder',name:'Invoice reminder',enabled:false,trigger:{type:'manual'},steps:[{type:'post',channel:'b:billing',text:'Review invoices'}]});
const bundle=(items=[item()])=>({version:1,items});
test('declarations are inert normalized data with stable identity and explicit enabled state',()=>{
 const input=bundle();expect(normalizeAppAutomations(input)).toEqual({automations:input});
 expect(normalizeAppAutomations(bundle([]))).toEqual({automations:bundle([])});
 expect(normalizeAppAutomations(bundle([{...item(),enabled:true}])).automations.items[0].enabled).toBe(true);
});
test('rejects duplicate keys, implicit enablement, live identities and credentials',()=>{
 for(const items of [[item(),item()],[{...item(),enabled:undefined}],[{...item(),workflowId:'wf_other'}],[{...item(),hookSecret:'secret'}],[{...item(),key:'../../other'}]])expect(normalizeAppAutomations(bundle(items)).error).toBeTruthy();
});
test('rejects oversized definitions instead of truncating executable content',()=>{
 expect(normalizeAppAutomations(bundle(Array.from({length:13},(_,i)=>({...item(),key:`key${i}`})))).error).toBeTruthy();
 expect(normalizeAppAutomations(bundle([{...item(),steps:[{type:'post',channel:'b:billing',text:'x'.repeat(4001)}]}])).error).toBeTruthy();
 expect(normalizeAppAutomations(bundle([{...item(),steps:Array.from({length:13},()=>item().steps[0])}])).error).toBeTruthy();
});
test('rejects invalid schedules and row values rather than changing their meaning',()=>{
 const trigger={type:'schedule',cadence:'daily',hour:9,minute:0,timezone:'Asia/Tokyo'};
 expect(normalizeAppAutomations(bundle([{...item(),trigger}])).automations.items[0].trigger).toEqual(trigger);
 for(const change of [{hour:24},{minute:-1},{timezone:'not/a-zone'},{cadence:'weekly',weekday:7},{cadence:'monthly',monthday:0}])expect(normalizeAppAutomations(bundle([{...item(),trigger:{...trigger,...change}}])).error).toBeTruthy();
 for(const valid of [
  {type:'schedule',kind:'cron',expr:'0 9 * * 1-5',timezone:'Asia/Tokyo'},
  {type:'schedule',kind:'every',everyMs:600000},
  {type:'schedule',kind:'at',at:'2026-10-26T09:00:00+09:00'},
 ]) {
  const result=normalizeAppAutomations(bundle([{...item(),trigger:valid}]));
  expect(result.automations.items[0].trigger).toEqual(valid.kind==='at'?{...valid,at:'2026-10-26T00:00:00.000Z'}:valid);
 }
 for(const invalid of [
  {type:'schedule',kind:'cron',expr:'* * * * *',timezone:'UTC'},
  {type:'schedule',kind:'every',everyMs:1},
  {type:'schedule',kind:'at',at:'not-a-date'},
 ]) expect(normalizeAppAutomations(bundle([{...item(),trigger:invalid}])).error).toBeTruthy();
 expect(normalizeAppAutomations(bundle([{...item(),steps:[{type:'add_row',tableId:'table',values:[]}]}])).error).toBeTruthy();
});
test('app automations can declare unfiltered row deletion triggers',()=>{
 const trigger={type:'row',tableId:'records',on:'deleted'};
 expect(normalizeAppAutomations(bundle([{...item(),trigger}])).automations.items[0].trigger).toEqual(trigger);
 expect(normalizeAppAutomations(bundle([{...item(),trigger:{...trigger,where:{status:['Done']}}}])).error).toContain('no field data');
});
test('comparison ignores metadata and property order but detects enabled, content and step order drift',()=>{
 const a=item(),b={...a,hookSecret:'do not export',lastRunAt:'now',trigger:{type:'manual'}};
 expect(sameAutomation(a,b)).toBe(true);expect(sameAutomation(a,{...b,enabled:true})).toBe(false);
 const first={type:'post',text:'one',channel:'b:billing'},second={type:'post',text:'two',channel:'b:billing'};
 expect(sameAutomation({...a,steps:[first,second]},{...b,steps:[second,first]})).toBe(false);
 expect(sameAutomation({...a,steps:[first]},{...b,steps:[{channel:'b:billing',text:'one',type:'post'}]})).toBe(true);
});

test('diff distinguishes proposed edits from independent live drift without exposing secrets',()=>{
 const published=bundle(),bindings=[{key:item().key,workflowId:'wf_one',applied:item()}];
 const workflow={...item(),id:'wf_one',hookSecret:'never export',lastRunAt:'now'};
 const plan=draft=>diffAppAutomations({draft,published,bindings,workflows:[workflow]});
 expect(plan(bundle())[0].status).toBe('unchanged');
 expect(plan(bundle([{...item(),name:'Changed'}]))[0].status).toBe('changed');
 expect(plan(bundle([]))[0].status).toBe('removed');
 expect(JSON.stringify(plan(bundle()))).not.toContain('never export');
 const drift=diffAppAutomations({draft:bundle([{...item(),name:'Changed'}]),published,bindings,workflows:[{...workflow,enabled:true}]});
 expect(drift[0]).toMatchObject({status:'drifted',declared:{name:'Changed'},live:{enabled:true},published:{enabled:false}});
 expect(diffAppAutomations({draft:bundle(),published,bindings,workflows:[]})[0].status).toBe('missing');
 expect(diffAppAutomations({draft:bundle(),published:bundle([]),bindings:[],workflows:[]})[0].status).toBe('added');
});
