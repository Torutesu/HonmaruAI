import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import filesSql from '../workspace-files.sql?raw';
import migrationsSql from '../migrations.sql?raw';
import {createSession,upsertMembership,upsertUser} from '../src/db.js';
import {setMode} from '../src/harness/mode.js';
import {createFileLedger,appendFileVersion} from '../src/harness/fileVersionLedger.js';
import worker from '../src/index.js';
import {sealCollaboratorRef} from '../src/harness/collaboratorRefs.js';
const tag=()=>crypto.randomUUID().replaceAll('-','');
let f;
async function setup(){
 const suffix=tag(),orgId='external-grant-'+suffix,ownerId='owner-'+suffix,adminId='admin-'+suffix,memberId='member-'+suffix,recipientId='recipient-'+suffix,fileId='f_'+suffix.slice(0,20),now=new Date().toISOString();
 await env.DB.exec(filesSql.replace(/\n/g,' '));
 for(const sql of migrationsSql.split('\n').filter(line=>/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS idx_hx_external_file_link_|^CREATE TABLE IF NOT EXISTS hx_external_file_link_/.test(line)))await env.DB.exec(sql);
 await env.DB.prepare('INSERT INTO orgs(id,name,created_at) VALUES(?1,?2,?3)').bind(orgId,orgId,now).run();
 await upsertUser(env.DB,{githubId:ownerId,login:ownerId,name:'Owner'});
 await upsertUser(env.DB,{githubId:adminId,login:adminId,name:'Admin'});
 await upsertUser(env.DB,{githubId:memberId,login:memberId,name:'Member'});
 await upsertUser(env.DB,{githubId:recipientId,login:recipientId,name:'Recipient'});
 await env.DB.prepare('UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3').bind(recipientId+'@example.test',now,recipientId).run();
 await upsertMembership(env.DB,orgId,ownerId,'member');
 await upsertMembership(env.DB,orgId,adminId,'admin');
 await upsertMembership(env.DB,orgId,memberId,'member');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES(?1,'general','General',?2,?3,0)").bind(orgId,ownerId,now).run();
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES(?1,'private-room','Private Room',?2,?3,1)").bind(orgId,ownerId,now).run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:private-room',?2,?2,?3)").bind(orgId,ownerId,now).run();
 await setMode(env.DB,orgId,'harness',ownerId);
 await createFileLedger(env.DB,{orgId,fileId,scope:'workspace',path:'handoff.txt',createdBy:ownerId});
 const objectKey='org/'+encodeURIComponent(orgId)+'/workspace-files/'+fileId+'/v1',body=new TextEncoder().encode('handoff');
 await env.MEDIA.put(objectKey,body,{httpMetadata:{contentType:'text/plain'}});
 const {createHash}=await import('node:crypto');
 await appendFileVersion(env.DB,{orgId,fileId,expectedVersion:0,createdBy:ownerId,objectKey,contentHash:createHash('sha256').update(body).digest('hex'),contentType:'text/plain',size:body.byteLength});
 f={orgId,ownerId,adminId,memberId,recipientId,fileId,ownerToken:await createSession(env.DB,ownerId,'grant-test'),adminToken:await createSession(env.DB,adminId,'grant-test'),memberToken:await createSession(env.DB,memberId,'grant-test'),recipientToken:await createSession(env.DB,recipientId,'grant-test')};
}
beforeEach(setup);
// A collaborator the share dialog picked: the handle the search would give out.
const picked=(id=f.recipientId)=>sealCollaboratorRef(env.DB,{orgId:f.orgId,resourceType:'file',resourceId:f.fileId},id);
async function call(path,token,method='GET',body){return worker.fetch(new Request('https://example.test'+path,{method,headers:{'x-session-token':token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){}})}
test('reusable File links hash tokens, grant only signed-in nonmembers, and revoke only link-created grants',async()=>{
 const base=`/hx/files/${encodeURIComponent(f.fileId)}/external-links`,path=base+`?orgId=${encodeURIComponent(f.orgId)}`;
 const createdResponse=await call(path,f.ownerToken,'POST',{permission:'edit',expiresAt:null});expect(createdResponse.status).toBe(201);const created=await createdResponse.json();
 expect(created.inviteUrl).toContain('/#/external-invite/');
 expect(await env.DB.prepare('SELECT token_hash FROM hx_external_file_link_shares WHERE id=?1').bind(created.link.id).first()).toMatchObject({token_hash:expect.not.stringMatching(created.token)});
 expect((await (await call(path,f.ownerToken)).json()).links[0]).not.toHaveProperty('token');
 expect((await call('/external/invites/redeem','', 'POST',{token:created.token})).status).toBe(401);
 const redeemed=await call('/external/invites/redeem',f.recipientToken,'POST',{token:created.token});expect(redeemed.status).toBe(200);expect(await redeemed.json()).toMatchObject({redeemed:true,resourceType:'file',fileId:f.fileId,permission:'edit'});
 expect((await call('/external/invites/redeem',f.memberToken,'POST',{token:created.token})).status).toBe(404);
 const revoke=await call(`${base}/${encodeURIComponent(created.link.id)}?orgId=${encodeURIComponent(f.orgId)}`,f.ownerToken,'DELETE',{});expect((await revoke.json()).revoked).toBe(true);
 expect((await call('/external/files/'+encodeURIComponent(f.orgId)+'/'+encodeURIComponent(f.fileId),f.recipientToken)).status).toBe(404);
});
test('owner creates a verified-email view grant, recipient redeems it, and owner revokes it',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 let response=await call(path,f.ownerToken,'POST',{email:f.recipientId+'@example.test',permission:'edit',expiresInDays:7});
 expect(response.status).toBe(201);const created=await response.json();expect(created.grant).toMatchObject({recipientRef:expect.stringMatching(/^c1\./),recipientEmail:f.recipientId+'@example.test',permission:'edit'});expect(created.redemptionPath).toContain('/external/files/');
 const guestPath=created.redemptionPath;
 response=await call(guestPath,f.recipientToken);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({permission:'edit',file:{id:f.fileId,path:'handoff.txt'}});
 response=await call(path,f.ownerToken);expect((await response.json()).grants[0]).toMatchObject({recipientLogin:f.recipientId,permission:'edit',revokedAt:null});
 response=await call('/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(f.recipientId)+'?orgId='+encodeURIComponent(f.orgId),f.ownerToken,'DELETE',{});
 expect(response.status).toBe(200);expect((await response.json()).revoked).toBe(true);
 expect((await call(guestPath,f.recipientToken)).status).toBe(404);
});
test('owner can grant a selected verified account by ID without exposing or changing its email',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 const response=await call(path,f.ownerToken,'POST',{recipientRef:await picked(),permission:'view',expiresInDays:7});
 expect(response.status).toBe(201);
 expect(await response.json()).toMatchObject({grant:{recipientRef:expect.stringMatching(/^c1\./),recipientLogin:f.recipientId,recipientName:'Recipient',recipientEmail:null,permission:'view'}});
 expect(await env.DB.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(f.orgId,f.recipientId).first()).toBeNull();
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 expect((await call(path,f.ownerToken,'POST',{recipientRef:await picked(),permission:'edit',expiresInDays:7})).status).toBe(409);
});
// #956: an email sign-up's account id and login are both its address.
test('File sharing names an outside email account by handle and never returns its address',async()=>{
 const address='ada-'+tag()+'@acme.test',id='email:'+address;
 await upsertUser(env.DB,{githubId:id,login:'u:'+address,name:'Ada'});
 await env.DB.prepare('UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3').bind(address,new Date().toISOString(),id).run();
 const search=await call('/external/collaborators/search?'+new URLSearchParams({orgId:f.orgId,resourceType:'file',resourceId:f.fileId,q:'acme.test'}),f.ownerToken);
 expect(search.status).toBe(200);const searchText=await search.text();expect(searchText).not.toContain(address);
 const [person]=JSON.parse(searchText).people;expect(person).toEqual({ref:expect.stringMatching(/^c1\./),name:'Ada',login:null});
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 const granted=await call(path,f.ownerToken,'POST',{recipientRef:person.ref,permission:'view',expiresInDays:7});
 expect(granted.status).toBe(201);const grantedText=await granted.text();expect(grantedText).not.toContain(address);
 const listedText=await (await call(path,f.ownerToken)).text();expect(listedText).not.toContain(address);
 const [grant]=JSON.parse(listedText).grants;expect(grant).toMatchObject({recipientName:'Ada',recipientLogin:null,recipientEmail:null});
 // The audit record still names the account, which managers do not read.
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE org_id=?1 AND action='workspace.file_external_grant_created'").bind(f.orgId).first()).toMatchObject({count:1});
 // A handle from the list manages that grant.
 const updatePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(grant.recipientRef)+'?orgId='+encodeURIComponent(f.orgId);
 const updated=await call(updatePath,f.ownerToken,'PATCH',{permission:'edit',expiresAt:null});expect(updated.status).toBe(200);expect(await updated.text()).not.toContain(address);
 expect((await env.DB.prepare("SELECT permission FROM hx_external_resource_grants WHERE org_id=?1 AND resource_type='file' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL").bind(f.orgId,f.fileId,id).first())).toMatchObject({permission:'edit'});
 const revoked=await call(updatePath,f.ownerToken,'DELETE',{});expect(await revoked.json()).toMatchObject({revoked:true});
});
test('file owner changes an active external collaborator permission and expiry in place',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 const created=await call(path,f.ownerToken,'POST',{recipientRef:await picked(),permission:'view',expiresInDays:7});
 expect(created.status).toBe(201);
 const nextExpiry=new Date(Date.now()+30*86400000).toISOString();
 const updatePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(f.recipientId)+'?orgId='+encodeURIComponent(f.orgId);
 const updated=await call(updatePath,f.ownerToken,'PATCH',{permission:'edit',expiresAt:nextExpiry});
 expect(updated.status).toBe(200);
 expect(await updated.json()).toMatchObject({updated:true,recipientRef:f.recipientId,permission:'edit',expiresAt:nextExpiry});
 expect((await env.DB.prepare("SELECT permission,expires_at FROM hx_external_resource_grants WHERE org_id=?1 AND resource_type='file' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL").bind(f.orgId,f.fileId,f.recipientId).first())).toMatchObject({permission:'edit',expires_at:nextExpiry});
 const auditCount=async()=>Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE org_id=?1 AND action='workspace.file_external_grant_updated'").bind(f.orgId).first()).count);
 expect(await auditCount()).toBe(1);
 expect((await call(updatePath,f.memberToken,'PATCH',{permission:'view',expiresAt:null})).status).toBe(403);
 expect((await call(updatePath,f.recipientToken,'PATCH',{permission:'view',expiresAt:null})).status).toBe(403);
 expect((await call(updatePath,f.ownerToken,'PATCH',{permission:'view'})).status).toBe(400);
 expect(await auditCount()).toBe(1);
 const adminExpiry=new Date(Date.now()+7*86400000).toISOString();
 expect((await call(updatePath,f.adminToken,'PATCH',{permission:'view',expiresAt:adminExpiry})).status).toBe(200);
 expect(await auditCount()).toBe(2);
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 expect((await call(updatePath,f.adminToken,'PATCH',{permission:'edit',expiresAt:null})).status).toBe(404);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(f.orgId,f.recipientId).run();
 await env.DB.prepare('UPDATE users SET email_verified_at=NULL WHERE github_id=?1').bind(f.recipientId).run();
 expect((await call(updatePath,f.adminToken,'PATCH',{permission:'edit',expiresAt:null})).status).toBe(404);
 expect(await auditCount()).toBe(2);
});
test('file grant updates reject revoked, expired and Simple-mode grants',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 const updatePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(f.recipientId)+'?orgId='+encodeURIComponent(f.orgId);
 let created=await call(path,f.ownerToken,'POST',{recipientRef:await picked(),permission:'view',expiresInDays:7});expect(created.status).toBe(201);
 expect((await call(updatePath,f.ownerToken,'DELETE',{})).status).toBe(200);
 expect((await call(updatePath,f.ownerToken,'PATCH',{permission:'edit',expiresAt:null})).status).toBe(404);
 created=await call(path,f.ownerToken,'POST',{recipientRef:await picked(),permission:'view',expiresInDays:1});expect(created.status).toBe(201);
 await env.DB.prepare("UPDATE hx_external_resource_grants SET granted_at=?1,expires_at=?2 WHERE org_id=?3 AND resource_type='file' AND resource_id=?4 AND recipient_github_id=?5 AND revoked_at IS NULL").bind(new Date(Date.now()-2*86400000).toISOString(),new Date(Date.now()-86400000).toISOString(),f.orgId,f.fileId,f.recipientId).run();
 expect((await call(updatePath,f.ownerToken,'PATCH',{permission:'edit',expiresAt:null})).status).toBe(404);
 await env.DB.prepare("UPDATE hx_external_resource_grants SET expires_at=NULL WHERE org_id=?1 AND resource_type='file' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL").bind(f.orgId,f.fileId,f.recipientId).run();
 await setMode(env.DB,f.orgId,'simple',f.ownerId);
 expect((await call(updatePath,f.ownerToken,'PATCH',{permission:'edit',expiresAt:null})).status).toBe(404);
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
test('an unredeemed File invite can change its access without changing its one-time link lifetime',async()=>{
 const invitePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grant-invites?orgId='+encodeURIComponent(f.orgId);
 const created=await call(invitePath,f.ownerToken,'POST',{email:f.recipientId+'@example.test',permission:'view',expiresInDays:7,inviteExpiresInDays:7});
 expect(created.status).toBe(201);const invite=(await created.json()).invite;
 const itemPath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grant-invites/'+encodeURIComponent(invite.id)+'?orgId='+encodeURIComponent(f.orgId);
 const original=await env.DB.prepare('SELECT token_hash,expires_at FROM hx_external_file_invites_v2 WHERE org_id=?1 AND file_id=?2 AND id=?3').bind(f.orgId,f.fileId,invite.id).first();
 const accessExpiresAt=new Date(Date.now()+30*86400000).toISOString();
 const updated=await call(itemPath,f.adminToken,'PATCH',{permission:'edit',accessExpiresAt});
 expect(updated.status).toBe(200);expect(await updated.json()).toMatchObject({updated:true,inviteId:invite.id,permission:'edit',accessExpiresAt});
 const stored=await env.DB.prepare('SELECT permission,access_expires_at,token_hash,expires_at,redeemed_at FROM hx_external_file_invites_v2 WHERE org_id=?1 AND file_id=?2 AND id=?3').bind(f.orgId,f.fileId,invite.id).first();
 expect(stored).toMatchObject({permission:'edit',access_expires_at:accessExpiresAt,token_hash:original.token_hash,expires_at:original.expires_at,redeemed_at:null});
 const auditCount=async()=>Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE org_id=?1 AND action='workspace.file_external_invite_updated'").bind(f.orgId).first()).count);
 expect(await auditCount()).toBe(1);
 expect((await call(itemPath,f.memberToken,'PATCH',{permission:'view',accessExpiresAt:null})).status).toBe(403);
 expect((await call(itemPath,f.ownerToken,'PATCH',{permission:'view'})).status).toBe(400);
 expect(await auditCount()).toBe(1);
 await env.DB.prepare('UPDATE users SET email_verified_at=NULL WHERE github_id=?1').bind(f.recipientId).run();
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 expect((await call(itemPath,f.adminToken,'PATCH',{permission:'view',accessExpiresAt:null})).status).toBe(404);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(f.orgId,f.recipientId).run();
 await env.DB.prepare('UPDATE users SET email_verified_at=?1 WHERE github_id=?2').bind(new Date().toISOString(),f.recipientId).run();
 const redeemed=await call('/external/invites/redeem',f.recipientToken,'POST',{token:invite.token});
 expect(redeemed.status).toBe(200);
 expect((await call(itemPath,f.adminToken,'PATCH',{permission:'view',accessExpiresAt:null})).status).toBe(404);
 expect(await auditCount()).toBe(1);
});
test('File invite access edits reject revoked, expired-token and Simple-mode invitations',async()=>{
 const invitePath='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grant-invites?orgId='+encodeURIComponent(f.orgId);
 const create=async()=>{const response=await call(invitePath,f.ownerToken,'POST',{email:'outside@example.test',permission:'view',expiresInDays:7,inviteExpiresInDays:7});expect(response.status).toBe(201);return response.json().then(data=>data.invite)};
 const updatePath=(id)=>'/hx/files/'+encodeURIComponent(f.fileId)+'/external-grant-invites/'+encodeURIComponent(id)+'?orgId='+encodeURIComponent(f.orgId);
 let invite=await create();
 expect((await call(updatePath(invite.id),f.ownerToken,'DELETE',{})).status).toBe(200);
 expect((await call(updatePath(invite.id),f.ownerToken,'PATCH',{permission:'edit',accessExpiresAt:null})).status).toBe(404);
 invite=await create();
 await env.DB.prepare('UPDATE hx_external_file_invites_v2 SET created_at=?1,expires_at=?2 WHERE id=?3')
  .bind(new Date(Date.now()-2*86400000).toISOString(),new Date(Date.now()-86400000).toISOString(),invite.id).run();
 expect((await call(updatePath(invite.id),f.ownerToken,'PATCH',{permission:'edit',accessExpiresAt:null})).status).toBe(404);
 invite=await create();
 await setMode(env.DB,f.orgId,'simple',f.ownerId);
 expect((await call(updatePath(invite.id),f.ownerToken,'PATCH',{permission:'edit',accessExpiresAt:null})).status).toBe(404);
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
 let response=await call(audiencePath,f.ownerToken,'PUT',{version:0,type:'room',roomId:'b:private-room',permission:'edit'});
 expect(response.status).toBe(200);
 const filePath='/external/files/'+encodeURIComponent(f.orgId)+'/'+encodeURIComponent(f.fileId);
 expect((await call(filePath,f.recipientToken)).status).toBe(404);
 const recipient=await env.DB.prepare('SELECT login FROM users WHERE github_id=?1').bind(f.recipientId).first();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:private-room',?2,?3,?4)")
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
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:private-room',?2,?3,?4)")
  .bind(f.orgId,recipient.login,f.ownerId,new Date().toISOString()).run();
 const audience=await call(audiencePath,f.ownerToken,'PUT',{version:0,type:'room',roomId:'b:private-room',permission:'view'});
 expect(audience.status).toBe(200);
 expect((await call(filePath,f.recipientToken)).status).toBe(200);

 await env.DB.prepare("UPDATE businesses SET archived_at=?1 WHERE org_id=?2 AND slug='private-room'")
  .bind(new Date().toISOString(),f.orgId).run();
 expect((await call(filePath,f.recipientToken)).status).toBe(404);

 await env.DB.prepare("UPDATE businesses SET archived_at=NULL WHERE org_id=?1 AND slug='private-room'").bind(f.orgId).run();
 await env.DB.prepare("INSERT INTO hx_room_access(org_id,channel,version,deleted_at) VALUES(?1,'b:private-room',1,?2)")
  .bind(f.orgId,new Date().toISOString()).run();
 expect((await call(filePath,f.recipientToken)).status).toBe(404);
});
