import {env} from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import {afterEach,beforeEach,expect,test} from 'vitest';
import {createApp} from '../src/harness/apps.js';
import {appConversation} from '../src/harness/appConversations.js';
import {notifyAppMentions} from '../src/harness/appConversationFeatures.js';
import {queueAppNotificationPush,sendDuePushes,PUSH_DELAY_MS} from '../src/pushes.js';
import {registerDevice,upsertMembership,upsertUser} from '../src/db.js';
import {resetProviderToken} from '../src/apns.js';
import {fetchMock} from './helpers/fetch-mock.js';

const ORG='personal:app-push';
const TEST_P8=`-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;
const settings=()=>({...env,APP_WEB_URL:'https://app.honmaruai.com',APNS_KEY_ID:'ABC1234567',APNS_TEAM_ID:'TEAM123456',APNS_TOPIC:'com.honmaru.ai',APNS_PRIVATE_KEY:TEST_P8,APNS_ENVIRONMENT:'sandbox'});
let app,tableId,owner,mika,rowId;

beforeEach(async()=>{
 await env.DB.exec(schemaSql.replace(/\n/g,' '));resetProviderToken();fetchMock.activate();
 await upsertUser(env.DB,{githubId:'app-owner',login:'owner',name:'Owner',avatarUrl:null,locale:'en'});
 await upsertUser(env.DB,{githubId:'app-mika',login:'mika',name:'Mika',avatarUrl:null,locale:'ja'});
 await upsertMembership(env.DB,ORG,'app-owner','admin');await upsertMembership(env.DB,ORG,'app-mika','member');
 owner={github_id:'app-owner',login:'owner'};mika='app-mika';
 const made=await createApp(env.DB,{orgId:ORG,by:'app-owner',name:'Tasks',columns:[{name:'Title',type:'text'}]});
 app=made.app;tableId=app.tableId;
 rowId='task-private-data';const at=new Date(Date.now()-120000).toISOString();
 await env.DB.prepare('INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(rowId,tableId,ORG,JSON.stringify({title:'Secret customer details'}),1,'app-owner','app-owner',at,at).run();
});
afterEach(()=>{fetchMock.assertNoPendingInterceptors();fetchMock.deactivate();resetProviderToken()});

async function addAiNotification({readAt=null,record=true}={}){
 const at=new Date(Date.now()-120000).toISOString(),id=Number((await env.DB.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS id FROM hx_app_messages').first()).id);
 await env.DB.prepare('INSERT INTO hx_app_messages(sequence,org_id,app_id,table_id,row_id,author_id,request_id,body,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind(id,ORG,app.id,record?tableId:'',record?rowId:'','__app_ai',`ai_reply_${id}`,'Private reply body must never be sent',at).run();
 await env.DB.prepare('INSERT INTO hx_app_notifications(org_id,app_id,message_id,user_id,kind,read_at) VALUES(?,?,?,?,?,?)')
  .bind(ORG,app.id,id,mika,'ai',readAt).run();
 return id;
}
async function enqueueAndSend(messageId,{now=Date.now(),login='mika'}={}){
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId,userId:mika,login,now});
 await env.DB.prepare('UPDATE push_queue SET due_at=?1 WHERE org_id=?2 AND login=?3').bind(new Date(now+PUSH_DELAY_MS).toISOString(),ORG,login).run();
 return sendDuePushes(settings(),now+PUSH_DELAY_MS+1000);
}

test('App mentions queue idempotently; AI replies queue with record-scoped deep link metadata',async()=>{
 const message=await appConversation(env.DB,ORG,'app-owner',app.id,{body:'@mika please review',requestId:'mention_request_0001'},true);
 await notifyAppMentions(env.DB,ORG,owner,app.id,{body:'@mika please review'},message.messageId,settings());
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:message.messageId,userId:mika,login:'mika'});
 const mention=await env.DB.prepare("SELECT message_id,reason FROM push_queue WHERE org_id=?1 AND login='mika'").bind(ORG).first();
 expect(mention).toMatchObject({message_id:`app:${encodeURIComponent(ORG)}:${encodeURIComponent(app.id)}:${message.messageId}`,reason:'app-mention'});
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE org_id=?1 AND login='mika'").bind(ORG).first()).toMatchObject({n:1});

 const ai=await addAiNotification();
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:ai,userId:mika,login:'mika'});
 const queued=(await env.DB.prepare("SELECT message_id,reason FROM push_queue WHERE org_id=?1 AND login='mika' ORDER BY id").bind(ORG).all()).results;
 expect(queued).toHaveLength(2);expect(queued[1]).toMatchObject({message_id:`app:${encodeURIComponent(ORG)}:${encodeURIComponent(app.id)}:${ai}`,reason:'app-ai'});
});

test('delivery rechecks unread authorization and sends only generic content with an app-record deep link',async()=>{
 const ai=await addAiNotification();await registerDevice(env.DB,{deviceToken:'a'.repeat(64),githubId:mika,login:'mika',environment:'sandbox',platform:'ios'});
 const pushed=[];fetchMock.get('https://api.sandbox.push.apple.com').intercept({path:`/3/device/${'a'.repeat(64)}`,method:'POST'}).reply(opts=>{pushed.push(JSON.parse(opts.body));return {statusCode:200,data:''}});
 const now=Date.now();expect(await enqueueAndSend(ai,{now})).toEqual({sent:1,skipped:0});
 expect(pushed).toHaveLength(1);
 expect(pushed[0]).toMatchObject({kind:'app_activity',orgId:ORG,appId:app.id,messageId:String(ai),tableId,rowId,url:`https://app.honmaruai.com/#/apps/${encodeURIComponent(app.id)}/${encodeURIComponent(ORG)}?chat=1&table=${encodeURIComponent(tableId)}&row=${encodeURIComponent(rowId)}`});
 expect(JSON.stringify(pushed[0])).not.toContain('Private reply body');expect(JSON.stringify(pushed[0])).not.toContain('Secret customer details');
});

test('already-read notifications and revoked App/record access are suppressed before delivery',async()=>{
 const now=Date.now(),read=await addAiNotification({record:false});
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:read,userId:mika,login:'mika',now});
 await env.DB.prepare('UPDATE hx_app_notifications SET read_at=?1 WHERE app_id=?2 AND message_id=?3').bind(new Date(now).toISOString(),app.id,read).run();
 expect(await sendDuePushes(settings(),now+PUSH_DELAY_MS+1000)).toEqual({sent:0,skipped:1});
 const removed=await addAiNotification();
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:removed,userId:mika,login:'mika',now});
 await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3').bind(ORG,tableId,rowId).run();
 expect(await sendDuePushes(settings(),now+PUSH_DELAY_MS+61000)).toEqual({sent:0,skipped:1});
 const privateApp=await addAiNotification({record:false});
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:privateApp,userId:mika,login:'mika',now});
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?1,?2,'private',1)").bind(ORG,app.id).run();
 expect(await sendDuePushes(settings(),now+PUSH_DELAY_MS+121000)).toEqual({sent:0,skipped:1});
});

test('active state suppresses delivery and quiet hours defer without spending an attempt',async()=>{
 const active=await addAiNotification({record:false});
 const now=Date.now();
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:active,userId:mika,login:'mika',now});
 await env.DB.prepare('UPDATE push_queue SET due_at=?1 WHERE message_id=?2').bind(new Date(now+PUSH_DELAY_MS).toISOString(),`app:${encodeURIComponent(ORG)}:${encodeURIComponent(app.id)}:${active}`).run();
 await env.DB.prepare("INSERT INTO workspace_activity(org_id,login,last_active_at,client) VALUES(?1,'mika',?2,'web')").bind(ORG,new Date(now+PUSH_DELAY_MS-5000).toISOString()).run();
 expect(await sendDuePushes(settings(),now+PUSH_DELAY_MS+1000)).toEqual({sent:0,skipped:1});
 await env.DB.prepare('DELETE FROM workspace_activity WHERE org_id=?1 AND login=?2').bind(ORG,'mika').run();
 const quiet=await addAiNotification({record:false}),quietNow=now+PUSH_DELAY_MS+5000;
 await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:quiet,userId:mika,login:'mika',now:quietNow});
 await env.DB.prepare('UPDATE push_queue SET due_at=?1 WHERE message_id=?2').bind(new Date(quietNow+PUSH_DELAY_MS).toISOString(),`app:${encodeURIComponent(ORG)}:${encodeURIComponent(app.id)}:${quiet}`).run();
 const pausedUntil=new Date(quietNow+PUSH_DELAY_MS+120000).toISOString();
 await registerDevice(env.DB,{deviceToken:'d'.repeat(64),githubId:mika,login:'mika',environment:'sandbox',platform:'ios'});
 await env.DB.prepare('UPDATE users SET notify_paused_until=?1 WHERE login=\'mika\'').bind(pausedUntil).run();
 expect(await sendDuePushes(settings(),quietNow+PUSH_DELAY_MS+1000)).toEqual({sent:0,skipped:0});
 const held=await env.DB.prepare("SELECT attempts,last_error FROM push_queue WHERE message_id=?1").bind(`app:${encodeURIComponent(ORG)}:${encodeURIComponent(app.id)}:${quiet}`).first();
 expect(held).toMatchObject({attempts:0,last_error:'held'});
 const pushed=[];fetchMock.get('https://api.sandbox.push.apple.com').intercept({path:`/3/device/${'d'.repeat(64)}`,method:'POST'}).reply(opts=>{pushed.push(JSON.parse(opts.body));return {statusCode:200,data:''}});
 await env.DB.prepare('UPDATE users SET notify_paused_until=NULL WHERE login=\'mika\'').run();
 expect(await sendDuePushes(settings(),Date.parse(pausedUntil)+1000)).toEqual({sent:1,skipped:0});expect(pushed).toHaveLength(1);
});

test('deliverOnce avoids duplicate device sends when another device retries',async()=>{
 const ai=await addAiNotification({record:false}),tokens=['b'.repeat(64),'c'.repeat(64)];
 for(const token of tokens)await registerDevice(env.DB,{deviceToken:token,githubId:mika,login:'mika',environment:'sandbox',platform:'ios'});
 let recovered=false;const sent=[];
 fetchMock.get('https://api.sandbox.push.apple.com').intercept({path:`/3/device/${tokens[0]}`,method:'POST'}).reply(opts=>{sent.push({token:tokens[0],payload:JSON.parse(opts.body)});return {statusCode:200,data:''}}).persist();
 fetchMock.get('https://api.sandbox.push.apple.com').intercept({path:`/3/device/${tokens[1]}`,method:'POST'}).reply(opts=>{sent.push({token:tokens[1],payload:JSON.parse(opts.body)});return {statusCode:recovered?200:503,data:''}}).persist();
 const now=Date.now();await queueAppNotificationPush(settings(),{orgId:ORG,appId:app.id,messageId:ai,userId:mika,login:'mika',now});
 const queue=await env.DB.prepare('SELECT message_id FROM push_queue WHERE org_id=?1 AND login=\'mika\'').bind(ORG).first();
 await env.DB.prepare('UPDATE push_queue SET due_at=?1').bind(new Date(now).toISOString()).run();
 expect(await sendDuePushes(settings(),now)).toEqual({sent:1,skipped:0});
 await env.DB.prepare('UPDATE push_queue SET due_at=?1').bind(new Date(now+61000).toISOString()).run();
 recovered=true;
 expect(await sendDuePushes(settings(),now+61000)).toEqual({sent:1,skipped:0});
 expect(sent.filter(x=>x.token===tokens[0])).toHaveLength(1);expect(sent.filter(x=>x.token===tokens[1])).toHaveLength(2);
 expect(queue.message_id).toContain('app:');
});
