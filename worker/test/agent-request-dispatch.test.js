import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {postMessage} from '../src/channels.js';
import {decorateAgentRequestStatuses} from '../src/agentRequestDispatch.js';
const request={sessionKey:'h1:session',agentIds:['agent'],locale:'ja'};
const input={orgId:'org',key:'b:room',authorLogin:'alice',body:'  Task\r\nplease  ',agentRequest:request};
beforeEach(async()=>{await env.DB.exec(schema.replace(/\n/g,' '));});

test('a source and its dispatch commit together, preserving normalized source and hashed credentials only',async()=>{
  const {row}=await postMessage(env.DB,input);
  const dispatch=await env.DB.prepare('SELECT * FROM hx_agent_request_dispatch WHERE org_id=?1 AND message_id=?2').bind('org',row.id).first();
  expect(row.body).toBe('Task\nplease');expect(dispatch).toMatchObject({status:'pending',session_key:'h1:session',agent_ids:'["agent"]',locale:'ja'});
  const {sourceFingerprint}=await import('../src/harness/agentAssignments.js');
  expect(dispatch.source_hash).toBe(await sourceFingerprint(row));
  expect(await decorateAgentRequestStatuses(env.DB,'org',[{rowId:row.id,status:'unknown',answered:0}])).toEqual([{rowId:row.id,status:'pending_delivery',answered:0}]);
  expect(await decorateAgentRequestStatuses(env.DB,'org',[{rowId:row.id,status:'running',answered:0}])).toEqual([{rowId:row.id,status:'running',answered:0}]);
});

test('failure to persist delivery rolls back the message and attachment claim',async()=>{
  await env.DB.prepare("INSERT INTO message_files(id,org_id,channel,uploader,name,type,size,created_at) VALUES ('file','org','b:room','alice','report.txt','text/plain',10,'2026-10-24')").run();
  await env.DB.exec("CREATE TRIGGER fail_request_dispatch BEFORE INSERT ON hx_agent_request_dispatch BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await expect(postMessage(env.DB,{...input,withFiles:true,files:{login:'alice',ids:['file']}})).rejects.toThrow();
  expect((await env.DB.prepare('SELECT id FROM channel_messages').all()).results).toEqual([]);
  expect((await env.DB.prepare("SELECT message_id FROM message_files WHERE id='file'").first()).message_id).toBeNull();
  expect((await env.DB.prepare('SELECT message_id FROM hx_agent_request_dispatch').all()).results).toEqual([]);
});

test('client retries cannot create another message or another delivery',async()=>{
  const first=await postMessage(env.DB,{...input,clientId:'tmp-request-retry'});
  const replay=await postMessage(env.DB,{...input,clientId:'tmp-request-retry'});
  expect(replay.replay).toBe(true);expect(replay.row.id).toBe(first.row.id);
  expect((await env.DB.prepare('SELECT message_id FROM hx_agent_request_dispatch').all()).results).toHaveLength(1);
});
