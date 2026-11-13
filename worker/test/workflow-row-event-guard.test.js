import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import {addRow,createTable,deleteRow,updateRow} from '../src/harness/tables.js';

// A watched row write is one batch: the guarded row change, then its outbox
// event. When the guard rejects the change the caller gets a conflict, and
// the event must not have been committed either, or the cron would start
// Workflows on values that were never stored.
const ORG='personal:row-event-guard',BY='9601';
const rejected={sql:()=>'0',binds:[]};
let table;
const outbox=()=>env.DB.prepare('SELECT id,status FROM hx_workflow_row_event_outbox WHERE org_id=?1 AND table_id=?2 ORDER BY created_at,id').bind(ORG,table.id).all().then(r=>r.results);

beforeEach(async()=>{
 ({table}=await createTable(env.DB,{orgId:ORG,name:'Orders',columns:[{name:'Name',type:'text'}],by:BY}));
 const at=new Date().toISOString();
 await env.DB.prepare(`INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at)
  VALUES('wf-row-guard',?1,'Watch orders',1,?2,'[]',?3,?4,?4)`).bind(ORG,JSON.stringify({type:'row',tableId:table.id,on:'any'}),BY,at).run();
});

test('a rejected row insert leaves no workflow event',async()=>{
 expect((await addRow(env.DB,ORG,table.id,{Name:'Never saved'},BY,undefined,null,rejected)).status).toBe(409);
 expect(await outbox()).toEqual([]);
});

test('a rejected row update leaves no workflow event',async()=>{
 const added=await addRow(env.DB,ORG,table.id,{Name:'Original'},BY);
 const before=await outbox();
 expect(before).toEqual([{id:added.rowEventId,status:'pending'}]);
 expect((await updateRow(env.DB,ORG,table.id,added.row.id,{Name:'Never saved'},BY,added.row.updatedAt,undefined,null,rejected)).status).toBe(409);
 expect(await outbox()).toEqual(before);
});

test('a rejected row delete leaves no workflow event',async()=>{
 const added=await addRow(env.DB,ORG,table.id,{Name:'Still here'},BY);
 const before=await outbox();
 expect((await deleteRow(env.DB,ORG,table.id,added.row.id,added.row.updatedAt,null,rejected,{by:BY})).status).toBe(409);
 expect(await outbox()).toEqual(before);
});

test('applied row writes still queue exactly one event each',async()=>{
 const added=await addRow(env.DB,ORG,table.id,{Name:'First'},BY);
 const updated=await updateRow(env.DB,ORG,table.id,added.row.id,{Name:'Second'},BY,added.row.updatedAt);
 const deleted=await deleteRow(env.DB,ORG,table.id,added.row.id,updated.row.updatedAt,null,undefined,{by:BY});
 expect(deleted.deleted).toBe(true);
 const ids=[added.rowEventId,updated.rowEventId,deleted.rowEventId];
 expect(ids.every(Boolean)).toBe(true);
 expect((await outbox()).map(row=>row.id).sort()).toEqual([...ids].sort());
});
