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

const featureRequest=(suffix,method,token,input={})=>worker.fetch(new Request('https://test/apps/'+app.id+'/'+suffix+(method==='GET'?'?orgId='+encodeURIComponent(org):''),{method,headers:{'x-session-token':token,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({orgId:org,...input})})}),env);
test('source inheritance reuses the original thread and preserves room access, record separation and retries',async()=>{
 const {postMessage}=await import('../src/channels.js');
 const {linkApp}=await import('../src/harness/apps.js');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at) VALUES (?,'source','Source','9201',?)").bind(org,new Date().toISOString()).run();
 const root=await postMessage(env.DB,{orgId:org,key:'b:source',authorLogin:'user9201',body:'Original app request'});
 await linkApp(env.DB,org,app.id,'b:source','9201');
 expect((await featureRequest('conversation-source','POST',member,{messageId:root.row.id})).status).toBe(403);
 expect((await featureRequest('conversation-source','POST',owner,{messageId:root.row.id})).status).toBe(200);
 expect((await featureRequest('conversation-source','POST',owner,{messageId:root.row.id})).status).toBe(200);
 const history=await (await request('GET',owner)).json();expect(history.source.threadId).toBe(root.row.id);expect(history.source.messages[0].body).toBe('Original app request');
 expect((await post(owner,'Continue here','source_request_001')).status).toBe(200);
 expect((await post(owner,'Continue here','source_request_001')).status).toBe(200);
 const replies=await env.DB.prepare('SELECT body FROM channel_messages WHERE parent_id=?').bind(root.row.id).all();expect(replies.results.map(r=>r.body)).toEqual(['Continue here']);
 expect((await (await request('GET',owner,{tableId:app.tableId,rowId:row.id})).json()).source).toBeNull();
 await env.DB.prepare('DELETE FROM businesses WHERE org_id=? AND slug=?').bind(org,'source').run();
 expect((await request('GET',owner)).status).toBe(403);expect((await post(owner,'No access','source_request_002')).status).toBe(403);
});
test('mentions notify only accessible members once and reads synchronize across sessions',async()=>{
 const scope={tableId:app.tableId,rowId:row.id};
 await post(owner,'@user9202 please review @user9203 @user9204','mention_request_01',scope);
 await post(owner,'@user9202 please review @user9203 @user9204','mention_request_01',scope);
 const notifications=await (await featureRequest('conversation-notifications','GET',member)).json();expect(notifications.items).toHaveLength(1);expect(notifications.items[0].rowId).toBe(row.id);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_notifications').first()).n).toBe(1);
 expect((await featureRequest('conversation-notifications','POST',member,{messageId:notifications.items[0].messageId})).status).toBe(200);
 const second=await createSession(env.DB,'9202','another-session');expect((await (await featureRequest('conversation-notifications','GET',second)).json()).items[0].readAt).toBeTruthy();
 await env.DB.prepare('DELETE FROM hx_rows WHERE id=?').bind(row.id).run();expect((await (await featureRequest('conversation-notifications','GET',member)).json()).items).toEqual([]);
});
test('creation records its supplied source thread but refuses an unavailable source before creating data',async()=>{
 const {postMessage}=await import('../src/channels.js');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at) VALUES (?,'creation','Creation','9201',?)").bind(org,new Date().toISOString()).run();
 const root=await postMessage(env.DB,{orgId:org,key:'b:creation',authorLogin:'user9201',body:'Create an app'});
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Inherited',columns:[{id:'title',name:'Title',type:'text'}],sourceThreadId:root.row.id});expect(await env.DB.prepare('SELECT channel FROM hx_app_links WHERE app_id=?').bind(made.app.id).first()).toEqual({channel:'b:creation'});
 expect((await (await request('GET',owner,{},made.app.id)).json()).source.threadId).toBe(root.row.id);
 const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps').first();
 expect((await createApp(env.DB,{orgId:org,by:'9201',name:'Invalid',columns:[],sourceThreadId:'missing'})).status).toBe(404);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps').first()).toEqual(count);
});

test('Activity and app inbox share scoped mentions, read state and revoked access',async()=>{
 const activity=async(token)=>await (await worker.fetch(new Request('https://test/channels/activity?orgId='+encodeURIComponent(org),{headers:{'x-session-token':token}}),env)).json();
 const read=async(token,items)=>worker.fetch(new Request('https://test/channels/read',{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,channel:'activity',...(items?{items}:{})})}),env);
 await post(owner,'@user9202 record mention','activity_request_1',{tableId:app.tableId,rowId:row.id});
 const first=(await activity(member)).items.find(i=>i.app);expect(first).toMatchObject({type:'mention',unread:true,app:{id:app.id,tableId:app.tableId,rowId:row.id},message:{body:'@user9202 record mention'}});
 expect((await activity(owner)).items.filter(i=>i.app)).toEqual([]);
 await read(owner,[first.key]);expect((await activity(member)).items.find(i=>i.app).unread).toBe(true);
 expect((await read(member,[first.key])).status).toBe(200);
 expect((await (await featureRequest('conversation-notifications','GET',member)).json()).items[0].readAt).toBeTruthy();
 await post(owner,'@user9202 next','activity_request_2');
 const bell=(await (await featureRequest('conversation-notifications','GET',member)).json()).items[0];
 await featureRequest('conversation-notifications','POST',member,{messageId:bell.messageId});
 expect((await activity(member)).items.filter(i=>i.app&&i.unread)).toEqual([]);
 await post(owner,'@user9202 last','activity_request_3');await read(member);
 expect((await activity(member)).items.filter(i=>i.app&&i.unread)).toEqual([]);
 await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=? AND id=?').bind(org,row.id).run();
 expect((await activity(member)).items.some(i=>i.key===first.key)).toBe(false);
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run();
 expect((await activity(member)).items.filter(i=>i.app)).toEqual([]);
});
