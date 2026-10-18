import {env} from 'cloudflare:test';
import {beforeEach,expect,test,vi} from 'vitest';
import schema from '../schema.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {createApp} from '../src/harness/apps.js';
import {addRow} from '../src/harness/tables.js';
import {appConversation} from '../src/harness/appConversations.js';
import {replyToApp,appNotifications} from '../src/harness/appConversationFeatures.js';
const completer=vi.fn();
const org='personal:app-ai',user={github_id:'9301',login:'aiuser'};let app,row;
beforeEach(async()=>{
 vi.clearAllMocks();await env.DB.exec(schema.replace(/\n/g,' '));
 await upsertUser(env.DB,{githubId:'9301',login:'aiuser',name:'AI user'});await upsertMembership(env.DB,org,'9301','admin');
 ({app}=await createApp(env.DB,{orgId:org,by:'9301',name:'AI tasks',columns:[{id:'title',name:'Title',type:'text'}]}));
 ({row}=await addRow(env.DB,org,app.tableId,{title:'Only this record'},'9301'));
});
test('AI uses only this record and conversation, emits one reply and notification for duplicate dispatches',async()=>{
 const complete=vi.fn().mockResolvedValue('A focused answer');completer.mockResolvedValue(complete);
 await appConversation(env.DB,org,'9301',app.id,{body:'Unrelated app discussion',requestId:'unrelated_request'},true);
 const input={tableId:app.tableId,rowId:row.id,body:'@AI summarize',requestId:'record_ai_request'};
 const saved=await appConversation(env.DB,org,'9301',app.id,input,true);
 await appConversation(env.DB,org,'9301',app.id,{...input,body:'Later question must not be included',requestId:'later_question_req'},true);
 await Promise.all([replyToApp(env,org,user,app.id,input,saved.messageId,{makeCompleter:completer}),replyToApp(env,org,user,app.id,input,saved.messageId,{makeCompleter:completer})]);
 expect(complete).toHaveBeenCalledTimes(1);expect(complete.mock.calls[0][1]).toContain('Only this record');expect(complete.mock.calls[0][1]).not.toContain('Unrelated app discussion');expect(complete.mock.calls[0][1]).not.toContain('Later question');
 const history=await appConversation(env.DB,org,'9301',app.id,input);expect(history.messages.at(-1)).toMatchObject({body:'A focused answer',authorName:'AI'});
 const notifications=await appNotifications(env.DB,org,'9301',app.id,{});expect(notifications.items).toHaveLength(1);expect(notifications.items[0].kind).toBe('ai');
});
test('no model or allowance produces explicit failure without a fabricated AI reply',async()=>{
 completer.mockResolvedValue(null);const input={body:'@AI help',requestId:'missing_model_req'};
 const saved=await appConversation(env.DB,org,'9301',app.id,input,true);await replyToApp(env,org,user,app.id,input,saved.messageId,{makeCompleter:completer});
 expect((await appConversation(env.DB,org,'9301',app.id,{})).messages).toHaveLength(1);
 expect(await env.DB.prepare('SELECT status,error FROM hx_app_ai_replies WHERE message_id=?').bind(saved.messageId).first()).toMatchObject({status:'failed',error:expect.any(String)});
});
test('access lost during generation prevents storing the response or notification',async()=>{
 completer.mockResolvedValue(async()=>{await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,'9301').run();return 'Must not persist'});
 const input={body:'@AI help',requestId:'revoked_access_req'};const saved=await appConversation(env.DB,org,'9301',app.id,input,true);await replyToApp(env,org,user,app.id,input,saved.messageId,{makeCompleter:completer});
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_messages WHERE author_id='__app_ai'").first()).n).toBe(0);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_notifications').first()).n).toBe(0);
});
