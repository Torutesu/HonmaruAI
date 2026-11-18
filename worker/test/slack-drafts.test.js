import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { fetchMock } from './helpers/fetch-mock.js';

const ORG = 'personal:slack-drafts';
let toru, mika, kenji, agentId, conversation, mikaSession;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, init = {}, over = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, init), { ...env, OPENAI_API_KEY: undefined, ...over }, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const headers = (token) => ({ 'content-type': 'application/json', 'x-session-token': token });
const send = (method, path, token, body, over = {}) => call(path, { method, headers: headers(token), body: JSON.stringify(body) }, over);
const get = (path, token, over = {}) => call(path, { headers: headers(token) }, over);
const q = (value) => new URLSearchParams(value).toString();
const agentPath = () => `/hx/agents/${agentId}/apps`;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  const { createSession, getSession, upsertUser, upsertMembership, upsertBusiness } = await import('../src/db.js');
  for (const [id, login, name, role] of [['18101','toru','Toru','admin'],['18102','mika','Mika','member'],['18103','kenji','Kenji','member']]) {
    await upsertUser(env.DB, { githubId:id, login, name, avatarUrl:null, locale:'en' });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name:'General', createdBy:'18101' });
  toru = await createSession(env.DB, '18101', 'gho_toru');
  mika = await createSession(env.DB, '18102', 'gho_mika');
  kenji = await createSession(env.DB, '18103', 'gho_kenji');
  mikaSession = await getSession(env.DB, mika);
  fetchMock.activate();
  await send('PUT','/orgs/mode',toru,{orgId:ORG,mode:'harness'});
  const made = await send('POST','/channels/agents',mika,{orgId:ORG,name:'Writer',handle:'writer',instructions:'Draft careful Slack messages.',scope:'team'});
  agentId = (await made.json()).agent.id;
  conversation = `ag:${agentId}|mika`;
  await env.DB.prepare(`INSERT INTO connector_config(user_github_id,connector,config,updated_at)
    VALUES ('18102','slack',?1,?2)`).bind(JSON.stringify({connected:true}),new Date().toISOString()).run();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function grantSlack(over = {}) {
  return send('POST',agentPath(),mika,{orgId:ORG,source:'slack'}, {COMPOSIO_API_KEY:'ck-test',...over});
}

async function makeDraft({ text='Message ready for review.', channel='C12345678', thread=null } = {}) {
  const { createSlackDraft } = await import('../src/harness/slackDrafts.js');
  const connection = await env.DB.prepare("SELECT updated_at FROM connector_config WHERE user_github_id='18102' AND connector='slack'").first();
  return createSlackDraft(env.DB,{orgId:ORG,agentId,creatorGithubId:'18102',creatorLogin:'mika',conversation,
    sourceMessageId:'source-message',providerUserId:'18102',connectionVersion:connection.updated_at,
    targetChannel:channel,targetName:'general',targetType:'channel',targetPrivate:false,targetThreadTs:thread,text});
}

function draftUrl(id, conversationValue = `ag:${agentId}`) {
  return `/channels/slack-drafts/${encodeURIComponent(id)}?${q({orgId:ORG,conversation:conversationValue})}`;
}
function draftSendPath(id) { return `/channels/slack-drafts/${encodeURIComponent(id)}/send`; }
function mockSlackDestinations(channel='C12345678', name='general') {
  fetchMock.get('https://backend.composio.dev').intercept({path:'/api/v3/tools/execute/SLACK_LIST_CONVERSATIONS',method:'POST'})
    .reply(200,{successful:true,data:{ok:true,channels:[{id:channel,name,is_private:false,is_archived:false}]}});
}

test('Agent Slack grant is explicit; create and edit persist a private draft without calling Composio', async () => {
  const deniedTools = await (await import('../src/agentTools.js')).agentTools({ ...env, COMPOSIO_API_KEY:'ck-test' }, {
    orgId:ORG,session:mikaSession,personal:true,agentId,agentName:'Writer',agentLogin:'mika',fileScope:conversation,sourceMessageId:'source-message',
  });
  expect(deniedTools.draft_slack_message).toBeUndefined();

  const state = await (await get(`${agentPath()}?${q({orgId:ORG})}`,mika)).json();
  expect(state.nativeConnections.find((source) => source.source === 'slack')).toMatchObject({available:true,enabled:false});
  expect((await grantSlack()).status).toBe(200);
  const granted = await (await get(`${agentPath()}?${q({orgId:ORG})}`,mika)).json();
  expect(granted.nativeConnections.find((source) => source.source === 'slack')).toMatchObject({available:true,enabled:true});

  const tools = await (await import('../src/agentTools.js')).agentTools({ ...env, COMPOSIO_API_KEY:'ck-test' }, {
    orgId:ORG,session:mikaSession,personal:true,agentId,agentName:'Writer',agentLogin:'mika',fileScope:conversation,sourceMessageId:'source-message',
  });
  mockSlackDestinations();
  const result = await tools.draft_slack_message.run({channel_id:'C12345678',thread_ts:'',text:'Please review before sending.'});
  const id = result.match(/"draftId":"([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(result).toContain('honmaru-slack-draft');
  const row = await env.DB.prepare('SELECT * FROM hx_slack_drafts WHERE org_id=?1 AND id=?2').bind(ORG,id).first();
  expect(row).toMatchObject({status:'pending',target_channel:'C12345678',provider_user_id:'18102',text:'Please review before sending.'});

  expect((await get(draftUrl(id),kenji,{COMPOSIO_API_KEY:'ck-test'})).status).toBe(404);
  expect((await get(draftUrl(id,`ag:${agentId}-other`),mika,{COMPOSIO_API_KEY:'ck-test'})).status).toBe(404);
  const loaded = await (await get(draftUrl(id),mika,{COMPOSIO_API_KEY:'ck-test'})).json();
  expect(loaded.draft).toMatchObject({id,text:'Please review before sending.',revision:1,status:'pending',target:{channelId:'C12345678',name:'general',label:'Slack channel',verified:true}});
  const edited = await send('PUT',draftUrl(id),mika,{orgId:ORG,conversation:`ag:${agentId}`,revision:1,text:'Edited by the person.'},{COMPOSIO_API_KEY:'ck-test'});
  expect(edited.status).toBe(200);
  expect((await edited.json()).draft).toMatchObject({text:'Edited by the person.',revision:2,status:'pending'});
});

test('a grant revoked before Send blocks delivery and DLP warnings require an explicit acknowledgement', async () => {
  await grantSlack();
  const draft = await makeDraft({text:'The BLUEBIRD launch moved.'});
  await env.DB.prepare('DELETE FROM hx_agent_slack_draft_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=\'18102\'').bind(ORG,agentId).run();
  const revoked = await send('POST',draftSendPath(draft.id),mika,{orgId:ORG,conversation:`ag:${agentId}`,revision:1},{COMPOSIO_API_KEY:'ck-test'});
  expect(revoked.status).toBe(409);
  expect((await env.DB.prepare('SELECT status FROM hx_slack_drafts WHERE org_id=?1 AND id=?2').bind(ORG,draft.id).first()).status).toBe('pending');

  await grantSlack();
  await send('POST','/orgs/dlp',toru,{orgId:ORG,kind:'keywords',name:'Project names',keywords:'Bluebird',action:'warn'});
  const warned = await send('POST',draftSendPath(draft.id),mika,{orgId:ORG,conversation:`ag:${agentId}`,revision:1},{COMPOSIO_API_KEY:'ck-test'});
  expect(warned.status).toBe(409);
  expect((await warned.json()).code).toBe('dlp-warning');
  expect((await env.DB.prepare('SELECT status FROM hx_slack_drafts WHERE org_id=?1 AND id=?2').bind(ORG,draft.id).first()).status).toBe('pending');
  fetchMock.get('https://backend.composio.dev').intercept({path:'/api/v3/tools/execute/SLACK_SEND_MESSAGE',method:'POST'})
    .reply(200,{successful:true,data:{ok:true,message:{ts:'1726000002.000100'}}});
  const acknowledged = await send('POST',draftSendPath(draft.id),mika,{orgId:ORG,conversation:`ag:${agentId}`,revision:1,dlpAck:true},{COMPOSIO_API_KEY:'ck-test'});
  expect(acknowledged.status).toBe(200);
  expect((await acknowledged.json()).draft.status).toBe('sent');
});

test('a grant revoked immediately after the send claim is rechecked before Slack is called', async () => {
  await grantSlack();
  const draft = await makeDraft({ text: 'Do not send after a mid-flight revocation.' });
  await env.DB.prepare(`CREATE TRIGGER revoke_slack_draft_grant_after_claim
    AFTER UPDATE OF status ON hx_slack_drafts
    WHEN NEW.status='sending' AND OLD.status='pending'
    BEGIN
      DELETE FROM hx_agent_slack_draft_grants
      WHERE org_id=NEW.org_id AND agent_id=NEW.agent_id AND user_github_id=NEW.creator_github_id;
    END`).run();

  const response = await send('POST', draftSendPath(draft.id), mika,
    { orgId: ORG, conversation: `ag:${agentId}`, revision: 1 }, { COMPOSIO_API_KEY: 'ck-test' });

  expect(response.status).toBe(409);
  expect((await response.json()).message).toContain('changed before sending');
  expect(await env.DB.prepare('SELECT status FROM hx_slack_drafts WHERE org_id=?1 AND id=?2')
    .bind(ORG, draft.id).first()).toMatchObject({ status: 'pending' });
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_slack_draft_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=\'18102\'')
    .bind(ORG, agentId).first()).toBeNull();
  fetchMock.assertNoPendingInterceptors();
});

test('parallel Send clicks make one Slack call; replay is rejected after the saved revision is consumed', async () => {
  await grantSlack();
  const draft = await makeDraft({text:'One message only.',channel:'C24681357',thread:'1726000000.000100'});
  let calls=0;
  fetchMock.get('https://backend.composio.dev').intercept({path:'/api/v3/tools/execute/SLACK_SEND_MESSAGE',method:'POST'})
    .reply(async (opts) => { calls+=1; await new Promise((r)=>setTimeout(r,60)); return {statusCode:200,data:{successful:true,data:{ok:true,message:{ts:'1726000001.000200'}}}}; });
  const body={orgId:ORG,conversation:`ag:${agentId}`,revision:1};
  const results=await Promise.all([
    send('POST',draftSendPath(draft.id),mika,body,{COMPOSIO_API_KEY:'ck-test'}),
    send('POST',draftSendPath(draft.id),mika,body,{COMPOSIO_API_KEY:'ck-test'}),
  ]);
  expect(results.map((result)=>result.status).sort()).toEqual([200,409]);
  expect(calls).toBe(1);
  const sent=await (await get(draftUrl(draft.id),mika,{COMPOSIO_API_KEY:'ck-test'})).json();
  expect(sent.draft).toMatchObject({status:'sent',revision:1,target:{channelId:'C24681357',threadTs:'1726000000.000100'}});
  expect((await send('POST',draftSendPath(draft.id),mika,body,{COMPOSIO_API_KEY:'ck-test'})).status).toBe(409);
  expect(calls).toBe(1);
});

test('a provider timeout becomes unknown and cannot be retried automatically or manually', async () => {
  await grantSlack();
  const draft=await makeDraft({text:'Delivery may be uncertain.'});
  fetchMock.get('https://backend.composio.dev').intercept({path:'/api/v3/tools/execute/SLACK_SEND_MESSAGE',method:'POST'})
    .replyWithError(new Error('upstream timed out after request was accepted'));
  const first=await send('POST',draftSendPath(draft.id),mika,{orgId:ORG,conversation:`ag:${agentId}`,revision:1},{COMPOSIO_API_KEY:'ck-test'});
  expect(first.status).toBe(202);
  expect((await first.json()).draft.status).toBe('unknown');
  const retry=await send('POST',draftSendPath(draft.id),mika,{orgId:ORG,conversation:`ag:${agentId}`,revision:1},{COMPOSIO_API_KEY:'ck-test'});
  expect(retry.status).toBe(409);
  expect((await retry.json()).draft.status).toBe('unknown');
});

test('changing the verified channel clears a thread timestamp from the old destination', async () => {
  const draft=await makeDraft({channel:'C11111111',thread:'1726000000.000100'});
  const { updateSlackDraft } = await import('../src/harness/slackDrafts.js');
  const updated=await updateSlackDraft(env.DB,{orgId:ORG,id:draft.id,creatorGithubId:'18102',conversation,revision:1,
    text:'Send this to another channel.',target:{channelId:'C22222222',name:'announcements',type:'channel',private:false}});
  expect(updated).toMatchObject({revision:2,status:'pending',target:{channelId:'C22222222',name:'announcements'}});
  expect(updated.target.threadTs).toBeUndefined();
});

test('a successful HTTP response with a Composio provider error envelope is not marked sent', async () => {
  await grantSlack();
  const draft=await makeDraft({text:'Provider returned an error envelope.'});
  fetchMock.get('https://backend.composio.dev').intercept({path:'/api/v3/tools/execute/SLACK_SEND_MESSAGE',method:'POST'})
    .reply(200,{successful:false,error:'Slack rejected this message',data:{ok:false,error:'channel_not_found'}});
  const response=await send('POST',draftSendPath(draft.id),mika,{orgId:ORG,conversation:`ag:${agentId}`,revision:1},{COMPOSIO_API_KEY:'ck-test'});
  expect(response.status).toBe(202);
  expect((await response.json()).draft.status).toBe('unknown');
  expect((await env.DB.prepare('SELECT status FROM hx_slack_drafts WHERE org_id=?1 AND id=?2').bind(ORG,draft.id).first()).status).not.toBe('sent');
});
