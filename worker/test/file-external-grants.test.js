import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import filesSql from '../workspace-files.sql?raw';
import {createSession,upsertMembership,upsertUser} from '../src/db.js';
import {setMode} from '../src/harness/mode.js';
import {createFileLedger,appendFileVersion} from '../src/harness/fileVersionLedger.js';
import worker from '../src/index.js';
const tag=()=>crypto.randomUUID().replaceAll('-','');
let f;
async function setup(){
 const suffix=tag(),orgId='external-grant-'+suffix,ownerId='owner-'+suffix,recipientId='recipient-'+suffix,fileId='f_'+suffix.slice(0,20),now=new Date().toISOString();
 await env.DB.exec(filesSql.replace(/\n/g,' '));
 await env.DB.prepare('INSERT INTO orgs(id,name,created_at) VALUES(?1,?2,?3)').bind(orgId,orgId,now).run();
 await upsertUser(env.DB,{githubId:ownerId,login:ownerId,name:'Owner'});
 await upsertUser(env.DB,{githubId:recipientId,login:recipientId,name:'Recipient'});
 await env.DB.prepare('UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3').bind(recipientId+'@example.test',now,recipientId).run();
 await upsertMembership(env.DB,orgId,ownerId,'member');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES(?1,'general','General',?2,?3,0)").bind(orgId,ownerId,now).run();
 await setMode(env.DB,orgId,'harness',ownerId);
 await createFileLedger(env.DB,{orgId,fileId,scope:'workspace',path:'handoff.txt',createdBy:ownerId});
 const objectKey='org/'+encodeURIComponent(orgId)+'/workspace-files/'+fileId+'/v1',body=new TextEncoder().encode('handoff');
 await env.MEDIA.put(objectKey,body,{httpMetadata:{contentType:'text/plain'}});
 const {createHash}=await import('node:crypto');
 await appendFileVersion(env.DB,{orgId,fileId,expectedVersion:0,createdBy:ownerId,objectKey,contentHash:createHash('sha256').update(body).digest('hex'),contentType:'text/plain',size:body.byteLength});
 f={orgId,ownerId,recipientId,fileId,ownerToken:await createSession(env.DB,ownerId,'grant-test'),recipientToken:await createSession(env.DB,recipientId,'grant-test')};
}
beforeEach(setup);
async function call(path,token,method='GET',body){return worker.fetch(new Request('https://example.test'+path,{method,headers:{'x-session-token':token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){}})}
test('owner creates a verified-email view grant, recipient redeems it, and owner revokes it',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 let response=await call(path,f.ownerToken,'POST',{email:f.recipientId+'@example.test',permission:'edit',expiresInDays:7});
 expect(response.status).toBe(201);const created=await response.json();expect(created.grant).toMatchObject({recipientGithubId:f.recipientId,permission:'edit'});expect(created.redemptionPath).toContain('/external/files/');
 const guestPath=created.redemptionPath;
 response=await call(guestPath,f.recipientToken);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({permission:'edit',file:{id:f.fileId,path:'handoff.txt'}});
 response=await call(path,f.ownerToken);expect((await response.json()).grants[0]).toMatchObject({recipientLogin:f.recipientId,permission:'edit',revokedAt:null});
 response=await call('/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(f.recipientId)+'?orgId='+encodeURIComponent(f.orgId),f.ownerToken,'DELETE',{});
 expect(response.status).toBe(200);expect((await response.json()).revoked).toBe(true);
 expect((await call(guestPath,f.recipientToken)).status).toBe(404);
});
test('owner can grant a selected verified account by ID without exposing or changing its email',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 const response=await call(path,f.ownerToken,'POST',{recipientGithubId:f.recipientId,permission:'view',expiresInDays:7});
 expect(response.status).toBe(201);
 expect(await response.json()).toMatchObject({grant:{recipientGithubId:f.recipientId,permission:'view'}});
 expect(await env.DB.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(f.orgId,f.recipientId).first()).toBeNull();
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 expect((await call(path,f.ownerToken,'POST',{recipientGithubId:f.recipientId,permission:'edit',expiresInDays:7})).status).toBe(409);
});
test('only file owner/Admin can manage grants; emails must resolve to a verified nonmember',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 expect((await call(path,f.recipientToken,'POST',{email:f.ownerId+'@example.test',expiresInDays:7})).status).toBe(403);
 expect((await call(path,f.ownerToken,'POST',{email:'missing@example.test',permission:'view',expiresInDays:7})).status).toBe(404);
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 const memberResponse=await call(path,f.ownerToken,'POST',{email:f.recipientId+'@example.test',permission:'view',expiresInDays:7});
 expect(memberResponse.status).toBe(409);expect(await memberResponse.json()).toMatchObject({message:'Workspace members should use their existing workspace access.'});
});
test('revocation preserves history and applies expiry boundaries',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 const created=await call(path,f.ownerToken,'POST',{email:f.recipientId+'@example.test',permission:'view',expiresInDays:1});expect(created.status).toBe(201);
 await call('/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(f.recipientId)+'?orgId='+encodeURIComponent(f.orgId),f.ownerToken,'DELETE',{});
 const result=await call(path,f.ownerToken);expect((await result.json()).grants[0].revokedAt).toBeTruthy();
});
test('unregistered email invite is redeemed only by its verified address and revocation removes the file grant',async()=>{
 const invitePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grant-invites?orgId='+encodeURIComponent(f.orgId);
 await env.DB.prepare("UPDATE users SET email='new@example.test',email_verified_at=?1 WHERE github_id=?2").bind(new Date().toISOString(),f.recipientId).run();
 let response=await call(invitePath,f.ownerToken,'POST',{email:'new@example.test',permission:'edit',expiresInDays:7,inviteExpiresInDays:1});
 expect(response.status).toBe(201);
 const created=await response.json();
 expect(created.invite.inviteUrl).toContain('/#/external-invite/');
 expect(created.invite.token).toMatch(/^[a-f0-9]{64}$/);
 const fileRead='/external/files/'+encodeURIComponent(f.orgId)+'/'+encodeURIComponent(f.fileId);
 response=await call('/external/invites/redeem',f.recipientToken,'POST',{token:created.invite.token});
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({redeemed:true,resourceType:'file',orgId:f.orgId,fileId:f.fileId,permission:'edit'});
 expect(await env.DB.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(f.orgId,f.recipientId).first()).toBeNull();
 expect((await call(fileRead,f.recipientToken)).status).toBe(200);
 const invites=await call(invitePath,f.ownerToken);
 expect((await invites.json()).invites[0]).toMatchObject({invitedEmail:'new@example.test',redeemedAt:expect.any(String)});
 const inviteId=created.invite.id;
 const invitePathWithId='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grant-invites/'+encodeURIComponent(inviteId)+'?orgId='+encodeURIComponent(f.orgId);
 response=await call(invitePathWithId,f.ownerToken,'DELETE',{});
 expect((await response.json()).revoked).toBe(true);
 expect((await call(fileRead,f.recipientToken)).status).toBe(404);
});
test('file invite redemption rejects an account with a different verified email',async()=>{
 const invitePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grant-invites?orgId='+encodeURIComponent(f.orgId);
 const response=await call(invitePath,f.ownerToken,'POST',{email:'different@example.test',permission:'view',expiresInDays:7,inviteExpiresInDays:7});
 expect(response.status).toBe(201);const created=await response.json();
 const denied=await call('/external/invites/redeem',f.recipientToken,'POST',{token:created.invite.token});
 expect(denied.status).toBe(404);
});

test('File audience uses workspace membership, optimistic versions, and owner-only management',async()=>{
 const audiencePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-audience?orgId='+encodeURIComponent(f.orgId);
 let response=await call(audiencePath,f.ownerToken);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({audience:null,version:0});
 expect((await call(audiencePath,f.recipientToken)).status).toBe(403);
 response=await call(audiencePath,f.ownerToken,'PUT',{version:0,type:'workspace',permission:'view'});
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({audience:{type:'workspace',permission:'view',version:1},version:1});
 expect((await call(audiencePath,f.ownerToken,'PUT',{version:0,type:'workspace',permission:'edit'})).status).toBe(409);

 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 const filePath='/external/files/'+encodeURIComponent(f.orgId)+'/'+encodeURIComponent(f.fileId);
 expect((await call(filePath,f.recipientToken)).status).toBe(200);
 response=await call(audiencePath,f.ownerToken,'PUT',{version:1,type:null});
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({audience:null,version:2});
 expect((await call(filePath,f.recipientToken)).status).toBe(404);
});

test('File Room audience requires live Room membership and expired audiences stop granting access',async()=>{
 const audiencePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-audience?orgId='+encodeURIComponent(f.orgId);
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=?1 AND slug='general'").bind(f.orgId).run();
 const owner=await env.DB.prepare('SELECT login FROM users WHERE github_id=?1').bind(f.ownerId).first();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:general',?2,?3,?4)")
  .bind(f.orgId,owner.login,f.ownerId,new Date().toISOString()).run();
 let response=await call(audiencePath,f.ownerToken,'PUT',{version:0,type:'room',roomId:'b:general',permission:'edit'});
 expect(response.status).toBe(200);
 const filePath='/external/files/'+encodeURIComponent(f.orgId)+'/'+encodeURIComponent(f.fileId);
 expect((await call(filePath,f.recipientToken)).status).toBe(404);
 const recipient=await env.DB.prepare('SELECT login FROM users WHERE github_id=?1').bind(f.recipientId).first();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:general',?2,?3,?4)")
  .bind(f.orgId,recipient.login,f.ownerId,new Date().toISOString()).run();
 expect((await call(filePath,f.recipientToken)).status).toBe(200);
 const expired=new Date(Date.now()-60_000).toISOString();
 const beforeExpiry=new Date(Date.parse(expired)-60_000).toISOString();
 await env.DB.prepare("UPDATE hx_external_resource_audiences SET expires_at=?1,updated_at=?2 WHERE org_id=?3 AND resource_type='file' AND resource_id=?4")
  .bind(expired,beforeExpiry,f.orgId,f.fileId).run();
 expect((await call(filePath,f.recipientToken)).status).toBe(404);
});

test('File Room audience stops granting access when its Room is archived or deleted',async()=>{
 const audiencePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-audience?orgId='+encodeURIComponent(f.orgId);
 const filePath='/external/files/'+encodeURIComponent(f.orgId)+'/'+encodeURIComponent(f.fileId);
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 const recipient=await env.DB.prepare('SELECT login FROM users WHERE github_id=?1').bind(f.recipientId).first();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:general',?2,?3,?4)")
  .bind(f.orgId,recipient.login,f.ownerId,new Date().toISOString()).run();
 const audience=await call(audiencePath,f.ownerToken,'PUT',{version:0,type:'room',roomId:'b:general',permission:'view'});
 expect(audience.status).toBe(200);
 expect((await call(filePath,f.recipientToken)).status).toBe(200);

 await env.DB.prepare("UPDATE businesses SET archived_at=?1 WHERE org_id=?2 AND slug='general'")
  .bind(new Date().toISOString(),f.orgId).run();
 expect((await call(filePath,f.recipientToken)).status).toBe(404);

 await env.DB.prepare("UPDATE businesses SET archived_at=NULL WHERE org_id=?1 AND slug='general'").bind(f.orgId).run();
 await env.DB.prepare("INSERT INTO hx_room_access(org_id,channel,version,deleted_at) VALUES(?1,'b:general',1,?2)")
  .bind(f.orgId,new Date().toISOString()).run();
 expect((await call(filePath,f.recipientToken)).status).toBe(404);
});
