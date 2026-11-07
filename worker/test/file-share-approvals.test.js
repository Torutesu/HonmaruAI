import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import sql from '../workspace-files.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {createFileLedger} from '../src/harness/fileVersionLedger.js';
import {uploadFileVersion} from '../src/harness/fileUpload.js';
import {proposePublicFileShare,approvePublicFileShare,revokePublicFileShare,servePublicFileShare} from '../src/harness/fileShareApprovals.js';
import {handleFileShareRoutes} from '../src/harness/fileShareApprovals.js';
import {fileAgentTools} from '../src/harness/fileAgentTools.js';
import {setMode} from '../src/harness/mode.js';

const orgId='share-org',fileId='public-report',ownerId='share-owner',otherId='share-other';
const upload=(expectedVersion=0,text='approved snapshot')=>uploadFileVersion(env,{orgId,fileId,userId:ownerId,expectedVersion,
 stream:new Blob([text]).stream(),size:new TextEncoder().encode(text).length,contentType:'text/plain'});
const propose=(overrides={})=>proposePublicFileShare(env,{orgId,fileId,version:1,userId:ownerId,login:'share-owner',
 requestKey:crypto.randomUUID().replaceAll('-',''),expiresIn:86400,allowDownload:false,...overrides});
const approve=(requestId,userId=ownerId,login='share-owner')=>approvePublicFileShare(env,{orgId,requestId,userId,login});
const publicGet=token=>servePublicFileShare(new Request('https://honmaru.test/hx/public-file-shares/'+token),env,token);


const roomScope='b:share-room',roomAgentId='share-room-agent',roomMessageId='source-request',roomFileId='room-report',sessionToken='source-session-token';
async function prepareRoomProposal(){
 const at=new Date().toISOString();
 await env.DB.prepare('INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES(?,?,?,?,?,0)').bind(orgId,'share-room','Share Room',ownerId,at).run();
 await env.DB.prepare('INSERT INTO hx_room_access(org_id,channel,version) VALUES(?,?,1)').bind(orgId,roomScope).run();
 await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?,?,?,?,?)').bind(orgId,roomScope,'share-owner','share-owner',at).run();
 await env.DB.prepare('INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(orgId,roomAgentId,'share-room-agent','Share Agent','Review files','team','share-owner',at,at).run();
 await env.DB.prepare('INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES(?,?,?,?,?)').bind(orgId,roomScope,roomAgentId,'share-owner',at).run();
 await env.DB.prepare('INSERT INTO sessions(token,github_id,github_access_token,created_at,expires_at) VALUES(?,?,?,?,?)').bind(sessionToken,ownerId,'unused',at,new Date(Date.now()+86400000).toISOString()).run();
 await env.DB.prepare('INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').bind(roomMessageId,orgId,roomScope,'share-owner','message','Please share the approved report.',at).run();
 await createFileLedger(env.DB,{orgId,fileId:roomFileId,scope:roomScope,path:'room-report.txt',createdBy:ownerId});
 await uploadFileVersion(env,{orgId,fileId:roomFileId,userId:ownerId,expectedVersion:0,stream:new Blob(['managed-room snapshot']).stream(),size:21,contentType:'text/plain'});
 await setMode(env.DB,orgId,'harness',ownerId);
}
async function roomProposalTools(agentId=roomAgentId){
 return fileAgentTools(env,{orgId,session:{github_id:ownerId,token:sessionToken},personal:false,ownAgentsOnly:false,
  fileScope:roomScope,taint:{value:false},fileProposalAgentId:agentId,sourceMessageId:roomMessageId,managedRoom:true});
}
async function makeRoomProposal(){
 const tools=await roomProposalTools();
 return JSON.parse(await tools.request_public_file_share.run({fileId:roomFileId,version:1,expiresIn:86400,allowDownload:false}));
}

beforeEach(async()=>{
 await env.DB.exec(sql.replace(/\n/g,' '));
 await upsertUser(env.DB,{githubId:ownerId,login:'share-owner',name:'Owner'});
 await upsertUser(env.DB,{githubId:otherId,login:'share-other',name:'Other'});
 await upsertMembership(env.DB,orgId,ownerId,'member');
 await upsertMembership(env.DB,orgId,otherId,'member');
 await createFileLedger(env.DB,{orgId,fileId,scope:'workspace',path:'report.txt',createdBy:ownerId});
 await upload();
 await setMode(env.DB,orgId,'harness',ownerId);
});


test('direct share management API is disabled in Simple while existing bearer links remain valid',async()=>{
 const activeRequest=await propose();
 const published=await approve(activeRequest.requestId);
 const pending=await propose();
 await setMode(env.DB,orgId,'simple',ownerId);
 const call=async(path,method='GET',body)=>{
  const url=new URL(path,'https://honmaru.test');
  url.searchParams.set('orgId',orgId);
  const request=new Request(url,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
  return handleFileShareRoutes(request,env,url,{orgId,userId:ownerId,login:'share-owner'});
 };
 const responses=await Promise.all([
  call('/hx/files/share-requests'),
  call('/hx/files/share-requests/approve','POST',{requestId:pending.requestId}),
  call('/hx/files/share-requests/decline','POST',{requestId:pending.requestId}),
  call('/hx/files/shares/'+published.shareId+'/revoke','POST'),
  call('/hx/files/'+fileId+'/share-requests','POST',{version:1,requestKey:crypto.randomUUID().replaceAll('-',''),expiresIn:86400,allowDownload:false}),
 ]);
 expect(responses.map(response=>response.status)).toEqual([404,404,404,404,404]);
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE org_id=? AND id=?').bind(orgId,pending.requestId).first()).status).toBe('pending');
 expect((await env.DB.prepare('SELECT revoked_at FROM hx_public_file_shares WHERE org_id=? AND id=?').bind(orgId,published.shareId).first()).revoked_at).toBeNull();
 const existing=await publicGet(published.url.split('/').at(-1));
 expect(existing.status).toBe(200);
 expect(await existing.text()).toBe('approved snapshot');
});


test('proposal route passes the path file ID to the approval request and rejects malformed IDs',async()=>{
 const request=new Request('https://honmaru.test/hx/files/public-report/share-requests?orgId='+orgId,{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({version:1,requestKey:crypto.randomUUID().replaceAll('-',''),expiresIn:86400,allowDownload:false}),
 });
 const response=await handleFileShareRoutes(request,env,new URL(request.url),{orgId,userId:ownerId,login:'share-owner'});
 expect(response.status).toBe(201);
 const result=await response.json();expect(result.fileId).toBe(fileId);
 const stored=await env.DB.prepare('SELECT file_id FROM hx_file_share_requests WHERE id=?').bind(result.requestId).first();
 expect(stored.file_id).toBe(fileId);

 const malformed=new Request('https://honmaru.test/hx/files/%E0%A4%A/share-requests?orgId='+orgId,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,requestKey:'malformed-path-request-key',expiresIn:86400}),
 });
 const rejected=await handleFileShareRoutes(malformed,env,new URL(malformed.url),{orgId,userId:ownerId,login:'share-owner'});
 expect(rejected.status).toBe(400);
});

test('Agent proposal creates no token; only the file owner can approve and the published snapshot can be revoked',async()=>{
 const request=await propose();
 expect(request.status).toBe('pending');expect(request).not.toHaveProperty('url');
 expect((await env.DB.prepare('SELECT * FROM hx_public_file_shares').all()).results).toHaveLength(0);
 expect((await env.DB.prepare('SELECT action FROM hx_file_share_audit').all()).results.map(x=>x.action)).toEqual(['proposed']);

 expect((await approve(request.requestId,otherId,'share-other')).status).toBe(403);
 const published=await approve(request.requestId);
 expect(published.url).toMatch(/^\/hx\/public-file-shares\/[A-Za-z0-9_-]{40,60}$/);
 const token=published.url.split('/').at(-1);
 const stored=await env.DB.prepare('SELECT token_hash,content_hash,file_version FROM hx_public_file_shares WHERE id=?').bind(published.shareId).first();
 expect(stored.token_hash).not.toBe(token);expect(stored.token_hash).toHaveLength(64);
 expect(stored.file_version).toBe(1);

 let response=await publicGet(token);expect(response.status).toBe(200);expect(await response.text()).toBe('approved snapshot');
 expect(response.headers.get('cache-control')).toContain('no-store');
 expect(response.headers.get('content-security-policy')).toContain('sandbox');
 expect(await revokePublicFileShare(env,{orgId,shareId:published.shareId,userId:ownerId,login:'share-owner'})).toHaveProperty('revokedAt');
 response=await publicGet(token);expect(response.status).toBe(404);
 expect((await env.DB.prepare("SELECT action FROM hx_file_share_audit ORDER BY id").all()).results.map(x=>x.action)).toEqual(['proposed','approved','revoked']);
});


test('Harness exposes source-bound public share proposals for one assigned managed-room Agent',async()=>{
 await prepareRoomProposal();
 const simple=await setMode(env.DB,orgId,'simple',ownerId);
 expect(simple.mode).toBe('simple');
 expect(await roomProposalTools()).toEqual({});
 await setMode(env.DB,orgId,'harness',ownerId);
 expect(await roomProposalTools(null)).toEqual({});
 const proposal=await makeRoomProposal();
 expect(proposal.status).toBe('pending');
 const stored=await env.DB.prepare('SELECT requester_membership,source_agent_id,source_message_id,source_scope,source_turn_hash,source_session_created_at FROM hx_file_share_requests WHERE id=?').bind(proposal.requestId).first();
 expect(stored).toMatchObject({source_agent_id:roomAgentId,source_message_id:roomMessageId,source_scope:roomScope});
 expect(stored.requester_membership).toContain('/');
 expect(stored.source_turn_hash).toMatch(/^[a-f0-9]{64}$/);
 expect(stored.source_session_created_at).toBeTruthy();
 const approved=await approvePublicFileShare(env,{orgId,requestId:proposal.requestId,userId:ownerId,login:'share-owner'});
 expect(approved.url).toMatch(/^\/hx\/public-file-shares\//);
});

test('existing private Agent proposals also persist source binding',async()=>{
 const at=new Date().toISOString(),directAgentId='share-direct-agent',directScope=`ag:${directAgentId}|share-owner`,directMessage='direct-source',directSession='direct-source-session',directFile='direct-report';
 await env.DB.prepare('INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(orgId,directAgentId,directAgentId,'Private Share Agent','Review files','personal','share-owner',at,at).run();
 await env.DB.prepare('INSERT INTO sessions(token,github_id,github_access_token,created_at,expires_at) VALUES(?,?,?,?,?)').bind(directSession,ownerId,'unused',at,new Date(Date.now()+86400000).toISOString()).run();
 await env.DB.prepare('INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').bind(directMessage,orgId,directScope,'share-owner','message','Please share this private report.',at).run();
 await createFileLedger(env.DB,{orgId,fileId:directFile,scope:directScope,path:'private-report.txt',createdBy:ownerId});
 await uploadFileVersion(env,{orgId,fileId:directFile,userId:ownerId,expectedVersion:0,stream:new Blob(['private agent snapshot']).stream(),size:22,contentType:'text/plain'});
 await setMode(env.DB,orgId,'harness',ownerId);
 const tools=await fileAgentTools(env,{orgId,session:{github_id:ownerId,token:directSession},personal:true,ownAgentsOnly:true,fileScope:directScope,
  fileProposalAgentId:directAgentId,sourceMessageId:directMessage,taint:{value:false}});
 const proposal=JSON.parse(await tools.request_public_file_share.run({fileId:directFile,version:1,expiresIn:86400,allowDownload:false}));
 const stored=await env.DB.prepare('SELECT source_agent_id,source_message_id,source_scope,source_turn_hash FROM hx_file_share_requests WHERE id=?').bind(proposal.requestId).first();
 expect(stored).toMatchObject({source_agent_id:directAgentId,source_message_id:directMessage,source_scope:directScope});
 expect(stored.source_turn_hash).toMatch(/^[a-f0-9]{64}$/);
 const approved=await approvePublicFileShare(env,{orgId,requestId:proposal.requestId,userId:ownerId,login:'share-owner'});
 expect(approved.url).toMatch(/^\/hx\/public-file-shares\//);
});

test('editing the source turn makes a pending managed-room Agent proposal stale',async()=>{
 await prepareRoomProposal();
 const proposal=await makeRoomProposal();
 await env.DB.prepare('UPDATE channel_messages SET body=?,content_version=content_version+1 WHERE org_id=? AND id=?').bind('changed source request',orgId,roomMessageId).run();
 const result=await approvePublicFileShare(env,{orgId,requestId:proposal.requestId,userId:ownerId,login:'share-owner'});
 expect(result.status).toBe(409);
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(proposal.requestId).first()).status).toBe('stale');
 expect((await env.DB.prepare('SELECT * FROM hx_public_file_shares WHERE request_id=?').bind(proposal.requestId).all()).results).toHaveLength(0);
});

test('changing the bound source scope makes a pending proposal stale',async()=>{
 await prepareRoomProposal();
 const proposal=await makeRoomProposal();
 await env.DB.prepare('UPDATE hx_file_share_requests SET source_scope=? WHERE org_id=? AND id=?').bind('b:other-room',orgId,proposal.requestId).run();
 const result=await approvePublicFileShare(env,{orgId,requestId:proposal.requestId,userId:ownerId,login:'share-owner'});
 expect(result.status).toBe(409);
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(proposal.requestId).first()).status).toBe('stale');
 expect((await env.DB.prepare('SELECT * FROM hx_public_file_shares WHERE request_id=?').bind(proposal.requestId).all()).results).toHaveLength(0);
});

test('removing the room Agent assignment or requester membership invalidates approval',async()=>{
 for(const revoke of [
  ()=>env.DB.prepare('DELETE FROM channel_agents WHERE org_id=? AND channel=? AND agent_id=?').bind(orgId,roomScope,roomAgentId).run(),
  ()=>env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(orgId,roomScope,'share-owner').run(),
 ]){
  await prepareRoomProposal();
  const proposal=await makeRoomProposal();
  await revoke();
  const result=await approvePublicFileShare(env,{orgId,requestId:proposal.requestId,userId:ownerId,login:'share-owner'});
  expect(result.status).toBe(409);
  expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(proposal.requestId).first()).status).toBe('stale');
  await env.DB.prepare('DELETE FROM channel_messages WHERE org_id=? AND id=?').bind(orgId,roomMessageId).run();
  await env.DB.prepare('DELETE FROM channel_agents WHERE org_id=? AND channel=? AND agent_id=?').bind(orgId,roomScope,roomAgentId).run();
  await env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(orgId,roomScope,'share-owner').run();
  await env.DB.prepare('DELETE FROM hx_room_access WHERE org_id=? AND channel=?').bind(orgId,roomScope).run();
  await env.DB.prepare('DELETE FROM businesses WHERE org_id=? AND slug=?').bind(orgId,'share-room').run();
  await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(sessionToken).run();
  await env.DB.prepare('DELETE FROM custom_agents WHERE org_id=? AND id=?').bind(orgId,roomAgentId).run();
  await env.DB.prepare('DELETE FROM hx_workspace_files WHERE org_id=? AND id=?').bind(orgId,roomFileId).run();
 }
});

test('approval INSERT atomically fences a room Agent removal after source precheck',async()=>{
 await prepareRoomProposal();
 const proposal=await makeRoomProposal();
 const target=env.DB;
 const racingDb=new Proxy(target,{get(db,key){
  if(key==='batch')return async statements=>{
   await db.prepare('DELETE FROM channel_agents WHERE org_id=? AND channel=? AND agent_id=?').bind(orgId,roomScope,roomAgentId).run();
   return db.batch(statements);
  };
  const value=Reflect.get(db,key,db);
  return typeof value==='function'?value.bind(db):value;
 }});
 const result=await approvePublicFileShare({DB:racingDb},{orgId,requestId:proposal.requestId,userId:ownerId,login:'share-owner'});
 expect(result.status).toBe(409);
 expect((await target.prepare('SELECT * FROM hx_public_file_shares WHERE request_id=?').bind(proposal.requestId).all()).results).toHaveLength(0);
 expect((await target.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(proposal.requestId).first()).status).toBe('pending');
});

test('revoking the source session invalidates a pending managed-room Agent proposal',async()=>{
 await prepareRoomProposal();
 const proposal=await makeRoomProposal();
 await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(sessionToken).run();
 const result=await approvePublicFileShare(env,{orgId,requestId:proposal.requestId,userId:ownerId,login:'share-owner'});
 expect(result.status).toBe(409);
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(proposal.requestId).first()).status).toBe('stale');
});

test('the review queue returns authorized file snapshot metadata but never the token',async()=>{
 const request=await propose(),published=await approve(request.requestId);
 const token=published.url.split('/').at(-1);
 const queueRequest=new Request('https://honmaru.test/hx/files/share-requests?orgId='+orgId);
 const response=await handleFileShareRoutes(queueRequest,env,new URL(queueRequest.url),{orgId,userId:ownerId,login:'share-owner'});
 const result=await response.json();
 expect(result.requests[0]).toMatchObject({fileId,filePath:'report.txt',scope:'workspace',version:1,currentVersion:1,contentType:'text/plain',size:17,status:'approved',shareId:published.shareId});
 expect(JSON.stringify(result)).not.toContain(token);
 const hidden=await handleFileShareRoutes(queueRequest,env,new URL(queueRequest.url),{orgId,userId:otherId,login:'share-other'});
 expect((await hidden.json()).requests).toEqual([]);
});

test('an approval is rejected after the file revision changes and no bearer token is created',async()=>{
 const request=await propose();
 expect((await upload(1,'new revision')).saved).toBe(true);
 const result=await approve(request.requestId);
 expect(result.status).toBe(409);expect(result.error).toMatch(/fresh approval/i);
 expect((await env.DB.prepare('SELECT * FROM hx_public_file_shares').all()).results).toHaveLength(0);
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(request.requestId).first()).status).toBe('stale');
 expect((await env.DB.prepare("SELECT action FROM hx_file_share_audit WHERE request_id=? ORDER BY id").bind(request.requestId).all()).results.map(x=>x.action)).toEqual(['proposed','stale']);
});

test('an approved old snapshot stops serving as soon as its file revision changes',async()=>{
 const request=await propose(),published=await approve(request.requestId),token=published.url.split('/').at(-1);
 expect((await publicGet(token)).status).toBe(200);
 expect((await upload(1,'changed')).saved).toBe(true);
 expect((await publicGet(token)).status).toBe(404);
});

test('public snapshot content disposition preserves a sanitized Unicode basename',async()=>{
 await env.DB.prepare('UPDATE hx_workspace_files SET path=? WHERE org_id=? AND id=?')
  .bind('nested/日本語 "unsafe".txt',orgId,fileId).run();
 const request=await propose(),published=await approve(request.requestId),token=published.url.split('/').at(-1);
 const response=await publicGet(token),header=response.headers.get('content-disposition');
 expect(header).toContain('filename*=');
 const encoded=header.match(/filename\*=UTF-8''([^;]+)/)?.[1];
 expect(encoded).toBeTruthy();
 expect(decodeURIComponent(encoded)).toBe('日本語 _unsafe_.txt');
 expect(header).not.toContain('nested/');
 expect(header).not.toContain('"unsafe"');
 expect(header).not.toMatch(/[\r\n]/);
});

test('owner can decline a pending request atomically and no token or link is created',async()=>{
 const request=await propose();
 const url='https://honmaru.test/hx/files/share-requests/decline?orgId='+orgId;
 const asOther=new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:request.requestId})});
 const denied=await handleFileShareRoutes(asOther,env,new URL(url),{orgId,userId:otherId,login:'share-other'});
 expect(denied.status).toBe(403);
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(request.requestId).first()).status).toBe('pending');
 const asOwner=new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:request.requestId})});
 const declined=await handleFileShareRoutes(asOwner,env,new URL(url),{orgId,userId:ownerId,login:'share-owner'});
 expect(declined.status).toBe(200);
 expect(await declined.json()).toMatchObject({requestId:request.requestId,status:'declined'});
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE id=?').bind(request.requestId).first()).status).toBe('declined');
 expect((await env.DB.prepare('SELECT * FROM hx_public_file_shares').all()).results).toHaveLength(0);
 expect((await env.DB.prepare('SELECT action FROM hx_file_share_audit WHERE request_id=?').bind(request.requestId).all()).results.map(x=>x.action)).toEqual(['proposed','declined']);
 const repeatedRequest=new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:request.requestId})});
 const repeat=await handleFileShareRoutes(repeatedRequest,env,new URL(url),{orgId,userId:ownerId,login:'share-owner'});
 expect(repeat.status).toBe(404);
});
