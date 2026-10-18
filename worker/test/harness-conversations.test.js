import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import worker from '../src/index.js';
import {createSession,upsertUser,upsertMembership} from '../src/db.js';
import {createApp} from '../src/harness/apps.js';
import {addRow} from '../src/harness/tables.js';
const org='personal:conversation';let owner,member,guest,other,app,row;
const request=(method,token,input={},target=app.id)=>worker.fetch(new Request('https://test/apps/'+target+'/conversation'+(method==='GET'?'?'+new URLSearchParams({orgId:org,...input}):''),{method,headers:{'x-session-token':token,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({orgId:org,...input})})}),env);
beforeEach(async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 const tokens=[];
 for(const [id,role] of [['9201','admin'],['9202','member'],['9203','guest'],['9204','member']]){await upsertUser(env.DB,{githubId:id,login:'user'+id,name:'User '+id});await upsertMembership(env.DB,id==='9204'?'personal:other':org,id,role);tokens.push(await createSession(env.DB,id,'test-token'));}
 [owner,member,guest,other]=tokens;
 ({app}=await createApp(env.DB,{orgId:org,by:'9201',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]}));
 ({row}=await addRow(env.DB,org,app.tableId,{title:'First'},'9201'));
});
const post=(token,body,requestId='request_0000000001',scope={})=>request('POST',token,{body,requestId,...scope});
test('app and record conversations have stable identities, independent histories and idempotent sends',async()=>{
 const empty=await (await request('GET',owner)).json();expect(empty.messages).toEqual([]);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_messages').first()).n).toBe(0);
 expect((await post(owner,'Hello')).status).toBe(200);expect((await post(owner,'Hello')).status).toBe(200);
 expect((await post(owner,'Different')).status).toBe(409);
 const secondSession=await createSession(env.DB,'9201','test-second');
 const restored=await (await request('GET',secondSession)).json();expect(restored.threadId).toBe(empty.threadId);expect(restored.messages).toHaveLength(1);expect(restored.messages[0]).toMatchObject({authorId:'9201',body:'Hello'});
 const scope={tableId:app.tableId,rowId:row.id};expect((await post(member,'Record note','request_0000000001',scope)).status).toBe(200);
 const record=await (await request('GET',owner,scope)).json();expect(record.threadId).not.toBe(empty.threadId);expect(record.messages.map(m=>m.body)).toEqual(['Record note']);
 expect((await (await request('GET',member)).json()).messages.map(m=>m.body)).toEqual(['Hello']);
});
test('membership, current app visibility and record ownership gate reads and writes',async()=>{
 await post(owner,'Private later');
 for(const token of [guest,other]){expect((await request('GET',token)).status).toBe(403);expect((await post(token,'Blocked')).status).toBe(403);}
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run();
 expect((await request('GET',member)).status).toBe(404);expect((await post(member,'Blocked')).status).toBe(404);expect((await request('GET',owner)).status).toBe(200);
 expect((await request('GET',owner,{tableId:app.tableId,rowId:'missing'})).status).toBe(404);
 expect((await request('GET',owner,{tableId:'foreign',rowId:row.id})).status).toBe(404);
 await env.DB.prepare('DELETE FROM hx_rows WHERE id=?').bind(row.id).run();expect((await request('GET',owner,{tableId:app.tableId,rowId:row.id})).status).toBe(404);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,'9201').run();expect((await request('GET',owner)).status).toBe(403);
});
test('history pages are chronological with no duplicate boundaries; malformed input is rejected',async()=>{
 for(let n=0;n<52;n++)expect((await post(owner,'message '+n,'request_'+String(n).padStart(16,'0'))).status).toBe(200);
 const latest=await (await request('GET',owner)).json();expect(latest.messages).toHaveLength(50);expect(latest.hasMore).toBe(true);expect(latest.messages[0].body).toBe('message 2');
 const earlier=await (await request('GET',owner,{before:String(latest.messages[0].id)})).json();expect(earlier.messages.map(m=>m.body)).toEqual(['message 0','message 1']);expect(earlier.hasMore).toBe(false);
 for(const input of [{tableId:app.tableId},{before:'-1'},{before:'NaN'}])expect((await request('GET',owner,input)).status).toBe(400);
 expect((await post(owner,' ')).status).toBe(400);expect((await post(owner,'x'.repeat(4001))).status).toBe(400);expect((await post(owner,'Hi','short')).status).toBe(400);
});
test('simultaneous retries converge and other apps or records never share a thread',async()=>{
 const results=await Promise.all([post(owner,'One'),post(owner,'One')]);expect(results.map(r=>r.status)).toEqual([200,200]);
 expect((await (await request('GET',owner)).json()).messages).toHaveLength(1);
 const {row:second}=await addRow(env.DB,org,app.tableId,{title:'Second'},'9201');
 await post(owner,'Only first','request_record_01',{tableId:app.tableId,rowId:row.id});
 expect((await (await request('GET',owner,{tableId:app.tableId,rowId:second.id})).json()).messages).toEqual([]);
 const {app:another}=await createApp(env.DB,{orgId:org,by:'9201',name:'Another',columns:[{id:'title',name:'Title',type:'text'}]});
 expect((await (await request('GET',owner,{},another.id)).json()).messages).toEqual([]);
 expect((await request('GET',owner,{tableId:app.tableId,rowId:row.id},another.id)).status).toBe(404);
});
