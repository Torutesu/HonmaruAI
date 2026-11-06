import {env} from 'cloudflare:test';
import {beforeEach,test,expect,vi} from 'vitest';
import worker from '../src/index.js';
import {createSession,upsertMembership,upsertUser} from '../src/db.js';
import {setMode} from '../src/harness/mode.js';
import {requestAgentFileShare} from '../src/harness/fileShares.js';
import {OrgRelay} from '../src/relay.js';

const orgId='personal:file-shares';
const DATA_KEY=btoa('x'.repeat(32));
let token,peerToken,guestToken,secureEnv;
const call=(path,method='GET',body,session=token,targetEnv=secureEnv,raw=false)=>worker.fetch(new Request(`https://example.test${path}${path.includes('?')?'&':'?'}orgId=${orgId}`,{
 method,headers:{'x-session-token':session||'','content-type':raw?'text/plain':'application/json'},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})
}),targetEnv);
async function createFile(path='share.txt',text='original',scope='workspace'){
 const reserved=await call('/hx/files','POST',{scope,path});expect(reserved.status).toBe(201);const {id}=await reserved.json();
 const saved=await call(`/hx/files/${id}/content?expectedVersion=0&size=${new TextEncoder().encode(text).length}`,'PUT',text,token,secureEnv,true);expect(saved.status).toBe(200);
 return id;
}

beforeEach(async()=>{
 secureEnv={...env,DATA_KEY,APP_WEB_URL:'https://app.example.test'};
 for(const [id,login,role] of [['share-owner','share-owner','admin'],['share-peer','share-peer','member']]){
  await upsertUser(env.DB,{githubId:id,login,name:login});await upsertMembership(env.DB,orgId,id,role);
 }
 await upsertUser(env.DB,{githubId:'share-guest',login:'share-guest',name:'share-guest'});await upsertMembership(env.DB,orgId,'share-guest','guest');
 token=await createSession(env.DB,'share-owner','test');peerToken=await createSession(env.DB,'share-peer','test');guestToken=await createSession(env.DB,'share-guest','test');
 await setMode(env.DB,orgId,'harness','share-owner');
});

test('Harness creates an exact reusable snapshot, copies the same URL, updates explicitly, and serves the selected version',async()=>{
 const id=await createFile();
 const created=await call(`/hx/files/${id}/shares`,'POST',{version:1,assets:[],expiresIn:'7d',allowDownload:false,reusable:true,requestKey:'request-share-0001'});
 expect(created.status).toBe(201);const issued=await created.json();
 expect(issued.share).toMatchObject({status:'active',currentRevision:1,reusable:true,allowDownload:false,files:[{fileId:id,version:1,name:'share.txt'}]});
 expect(issued.token).toMatch(/^shr_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
 const listed=await (await call(`/hx/files/${id}/shares`)).json();expect(listed.canManage).toBe(true);expect(listed.shares).toHaveLength(1);
 expect(JSON.stringify(listed)).not.toContain(issued.token);
 const copied=await call(`/hx/files/${id}/shares/${issued.share.id}/copy`,'POST',{});expect(copied.status).toBe(200);expect((await copied.json()).token).toBe(issued.token);
 const metadata=await (await call(`/workspace-file-shares/${issued.token}`,'GET',undefined,null)).json();
 expect(metadata.share).toMatchObject({name:'share.txt',version:1,allowDownload:false,files:[{name:'share.txt',version:1}]});
 const content=await call(`/workspace-file-shares/${issued.token}/content/0`,'GET',undefined,null);
 expect(content.status).toBe(200);expect(content.headers.get('content-disposition')).toContain('inline');expect(await content.text()).toBe('original');
 const newVersion=await call(`/hx/files/${id}/content?expectedVersion=1&size=7`,'PUT','updated',token,secureEnv,true);expect(newVersion.status).toBe(200);
 expect((await (await call(`/workspace-file-shares/${issued.token}`,'GET',undefined,null)).json()).share.version).toBe(1);
 const updated=await call(`/hx/files/${id}/shares/${issued.share.id}/update`,'POST',{version:2,assets:[]});
 expect(updated.status).toBe(200);const updateResult=await updated.json();expect(updateResult.token).toBe(issued.token);expect(updateResult.share.currentRevision).toBe(2);expect(updateResult.share.expiresAt).toBe(issued.share.expiresAt);expect(updateResult.share.allowDownload).toBe(false);
 expect((await (await call(`/workspace-file-shares/${issued.token}`,'GET',undefined,null)).json()).share.version).toBe(2);
 expect((await call(`/workspace-file-shares/${issued.token}/content/0`,'GET',undefined,null)).headers.get('content-disposition')).toContain('inline');
});

test('Simple mode leaves file history intact but keeps public share controls unavailable',async()=>{
 const id=await createFile();await setMode(env.DB,orgId,'simple','share-owner');
 expect((await call(`/hx/files/${id}/shares`)).status).toBe(404);
 expect((await call(`/hx/files/${id}/versions/1/content`)).status).toBe(200);
});

test('only a file manager can recover or revoke a link, and revocation removes future access',async()=>{
 const id=await createFile();
 const created=await call(`/hx/files/${id}/shares`,'POST',{version:1,assets:[],expiresIn:'never',allowDownload:true,reusable:true,requestKey:'request-share-0002'});
 const createdResult=await created.json(),share=createdResult.share,publicToken=createdResult.token;
 expect((await call(`/hx/files/${id}/shares/${share.id}/copy`,'POST',{},peerToken)).status).toBe(404);
 expect((await call(`/hx/files/${id}/shares/${share.id}/revoke`,'POST',{},peerToken)).status).toBe(409);
 const revoked=await call(`/hx/files/${id}/shares/${share.id}/revoke`,'POST',{});expect(revoked.status).toBe(200);
 expect((await call(`/workspace-file-shares/${publicToken}`,'GET',undefined,null)).status).toBe(404);
 const copied=await call(`/hx/files/${id}/shares/${share.id}/copy`,'POST',{});expect(copied.status).toBe(404);
 const after=await (await call(`/hx/files/${id}/shares`)).json();expect(after.shares[0].status).toBe('revoked');
});

test('share mutations bind org, file, actor and login to the authenticated route, and a guest cannot publish',async()=>{
 const id=await createFile(),other=await createFile('other.txt','other');
 const denied=await call(`/hx/files/${id}/shares`,'POST',{version:1,assets:[],expiresIn:'never',allowDownload:true,reusable:true,requestKey:'guest-request-share-0016'},guestToken);
 expect(denied.status).toBe(403);
 expect((await env.DB.prepare('SELECT count(*) AS n FROM hx_workspace_file_shares WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
 const created=await call(`/hx/files/${id}/shares`,'POST',{orgId:'forged-org',fileId:other,userId:'share-peer',login:'share-peer',version:1,assets:[],expiresIn:'never',allowDownload:true,reusable:true,requestKey:'request-share-0017'});
 expect(created.status).toBe(201);const result=await created.json();
 expect(await env.DB.prepare('SELECT org_id,file_id,created_by,created_login FROM hx_workspace_file_shares WHERE id=?1').bind(result.share.id).first()).toMatchObject({org_id:orgId,file_id:id,created_by:'share-owner',created_login:'share-owner'});
 await call(`/hx/files/${id}/content?expectedVersion=1&size=7`,'PUT','updated',token,secureEnv,true);
 const update=await call(`/hx/files/${id}/shares/${result.share.id}/update`,'POST',{orgId:'forged-org',fileId:other,shareId:'forged-share',userId:'share-peer',login:'share-peer',version:2,assets:[]});
 expect(update.status).toBe(200);expect((await update.json()).share.files[0].fileId).toBe(id);
 await expect((await call(`/hx/files/${other}/shares`)).json()).resolves.toMatchObject({shares:[]});
});

test('active snapshots hold their immutable R2 version against purge until the link is revoked',async()=>{
 const id=await createFile();
 const created=await call(`/hx/files/${id}/shares`,'POST',{version:1,assets:[],expiresIn:'never',allowDownload:true,reusable:true,requestKey:'request-share-0003'});
 const share=(await created.json()).share;
 const second=await call(`/hx/files/${id}/content?expectedVersion=1&size=7`,'PUT','updated',token,secureEnv,true);expect(second.status).toBe(200);
 const blocked=await call(`/hx/files/${id}/purge`,'POST',{version:1,reason:'Old version'});expect(blocked.status).toBe(409);
 expect((await call(`/hx/files/${id}/shares/${share.id}/revoke`,'POST',{})).status).toBe(200);
 expect((await call(`/hx/files/${id}/purge`,'POST',{version:1,reason:'Old version'})).status).toBe(200);
});

test('share tokens are MAC-bound to the unchanged workspace encryption key',async()=>{
 const id=await createFile();
 const created=await call(`/hx/files/${id}/shares`,'POST',{version:1,assets:[],expiresIn:'never',allowDownload:true,reusable:true,requestKey:'request-share-0004'});
 const {token:publicToken}=await created.json();
 const tampered=`${publicToken.slice(0,-1)}${publicToken.endsWith('A')?'B':'A'}`;
 expect((await call(`/workspace-file-shares/${tampered}`,'GET',undefined,null)).status).toBe(404);
 const rotated={...secureEnv,DATA_KEY:btoa('y'.repeat(32))};
 expect((await call(`/workspace-file-shares/${publicToken}`,'GET',undefined,null,rotated)).status).toBe(404);
});

test('Agent file-share approval preserves existing expiry/download settings and tells its owner when an update goes stale',async()=>{
 const made=await call('/channels/agents','POST',{orgId,name:'Private file agent',handle:'private-file-agent',instructions:'Help with files.',scope:'personal'});
 expect(made.status).toBe(201);const agent=(await made.json()).agent,channel=`ag:${agent.id}|share-owner`;
 const fileId=await createFile('approved.txt','v1',channel);
 const addTurn=async(id,body)=>env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES(?1,?2,?3,'share-owner','message',?4,?5)`).bind(id,orgId,channel,body,new Date().toISOString()).run();
 await addTurn('share-turn-0001','Please publish the approved file.');
 const first=await requestAgentFileShare(secureEnv,{orgId,userId:'share-owner',login:'share-owner',agentId:agent.id,agentName:agent.name,channel,turnId:'share-turn-0001',fileId,version:1,requestKey:'agent-share-request-0001',expiresIn:'7d',allowDownload:false,reusable:true});
 expect(first.request.status).toBe('pending');expect(first.card.context).toContain('表示のみ');
 const firstDecision={...first.card,decision:{action:'approve',actorUserID:'share-owner',decidedAt:new Date().toISOString()}};
 const relay=Object.create(OrgRelay.prototype);relay.db=env.DB;relay.env={...secureEnv,APP_WEB_URL:'https://app.example.test'};relay.state={waitUntil:vi.fn()};relay.log=vi.fn();relay.broadcastCard=vi.fn();relay.sendTo=vi.fn();relay.deliver=vi.fn();
 await relay.afterDecision(orgId,firstDecision,'share-owner','share-owner');
 const shareRow=await env.DB.prepare(`SELECT s.id,r.expires_at,r.allow_download FROM hx_workspace_file_shares s JOIN hx_workspace_file_share_revisions r ON r.org_id=s.org_id AND r.share_id=s.id AND r.revision=s.current_revision WHERE s.org_id=?1 AND s.file_id=?2`).bind(orgId,fileId).first();
 expect(shareRow).toMatchObject({expires_at:expect.any(String),allow_download:0});
 expect((await env.DB.prepare('SELECT body FROM channel_messages WHERE org_id=?1 AND channel=?2 AND kind=\'agent\' ORDER BY created_at DESC LIMIT 1').bind(orgId,channel).first()).body).toContain('#/file-share/');
 await call(`/hx/files/${fileId}/content?expectedVersion=1&size=2`,'PUT','v2',token,secureEnv,true);
 await addTurn('share-turn-0002','Please update that public file.');
 const update=await requestAgentFileShare(secureEnv,{orgId,userId:'share-owner',login:'share-owner',agentId:agent.id,agentName:agent.name,channel,turnId:'share-turn-0002',fileId,version:2,requestKey:'agent-share-request-0002',shareId:shareRow.id});
 expect(update.request.status).toBe('pending');
 const pending=await env.DB.prepare('SELECT expires_at,allow_download FROM hx_workspace_file_share_requests WHERE org_id=?1 AND id=?2').bind(orgId,update.request.id).first();
 expect(pending).toMatchObject({expires_at:shareRow.expires_at,allow_download:0});
 const updateDecision={...update.card,decision:{action:'approve',actorUserID:'share-owner',decidedAt:new Date().toISOString()}};
 await relay.afterDecision(orgId,updateDecision,'share-owner','share-owner');
 expect(await env.DB.prepare('SELECT expires_at,allow_download FROM hx_workspace_file_share_revisions WHERE org_id=?1 AND share_id=?2 AND revision=2').bind(orgId,shareRow.id).first()).toMatchObject({expires_at:shareRow.expires_at,allow_download:0});
 expect((await env.DB.prepare('SELECT body FROM channel_messages WHERE org_id=?1 AND channel=?2 AND kind=\'agent\' ORDER BY created_at DESC LIMIT 1').bind(orgId,channel).first()).body).toContain('#/file-share/');
 await call(`/hx/files/${fileId}/content?expectedVersion=2&size=2`,'PUT','v3',token,secureEnv,true);
 await addTurn('share-turn-0003','Please publish the next current version.');
 const stale=await requestAgentFileShare(secureEnv,{orgId,userId:'share-owner',login:'share-owner',agentId:agent.id,agentName:agent.name,channel,turnId:'share-turn-0003',fileId,version:3,requestKey:'agent-share-request-0003',shareId:shareRow.id});
 await call(`/hx/files/${fileId}/content?expectedVersion=3&size=2`,'PUT','v4',token,secureEnv,true);
 const staleDecision={...stale.card,decision:{action:'approve',actorUserID:'share-owner',decidedAt:new Date().toISOString()}};
 await relay.afterDecision(orgId,staleDecision,'share-owner','share-owner');
 expect(await env.DB.prepare('SELECT status FROM hx_workspace_file_share_requests WHERE org_id=?1 AND id=?2').bind(orgId,stale.request.id).first()).toMatchObject({status:'stale'});
 const last=await env.DB.prepare('SELECT body FROM channel_messages WHERE org_id=?1 AND channel=?2 AND kind=\'agent\' ORDER BY created_at DESC LIMIT 1').bind(orgId,channel).first();
 expect(last.body).toContain('作成されませんでした');expect(last.body).toContain('もう一度申請');
});
