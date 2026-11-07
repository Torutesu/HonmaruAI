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
 let response=await call(path,f.ownerToken,'POST',{email:f.recipientId+'@example.test',expiresInDays:7});
 expect(response.status).toBe(201);const created=await response.json();expect(created.grant).toMatchObject({recipientGithubId:f.recipientId,permission:'view'});expect(created.redemptionPath).toContain('/external/files/');
 const guestPath=created.redemptionPath;
 response=await call(guestPath,f.recipientToken);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({permission:'view',file:{id:f.fileId,path:'handoff.txt'}});
 response=await call(path,f.ownerToken);expect((await response.json()).grants[0]).toMatchObject({recipientLogin:f.recipientId,permission:'view',revokedAt:null});
 response=await call('/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(f.recipientId)+'?orgId='+encodeURIComponent(f.orgId),f.ownerToken,'DELETE',{});
 expect(response.status).toBe(200);expect((await response.json()).revoked).toBe(true);
 expect((await call(guestPath,f.recipientToken)).status).toBe(404);
});
test('only file owner/Admin can manage grants; emails must resolve to a verified nonmember',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 expect((await call(path,f.recipientToken,'POST',{email:f.ownerId+'@example.test',expiresInDays:7})).status).toBe(403);
 expect((await call(path,f.ownerToken,'POST',{email:'missing@example.test',expiresInDays:7})).status).toBe(404);
 await upsertMembership(env.DB,f.orgId,f.recipientId,'member');
 expect((await call(path,f.ownerToken,'POST',{email:f.recipientId+'@example.test',expiresInDays:7})).status).toBe(409);
});
test('revocation preserves history and applies expiry boundaries',async()=>{
 const path='/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants?orgId='+encodeURIComponent(f.orgId);
 const created=await call(path,f.ownerToken,'POST',{email:f.recipientId+'@example.test',expiresInDays:1});expect(created.status).toBe(201);
 await call('/hx/files/'+encodeURIComponent(f.fileId)+'/external-grants/'+encodeURIComponent(f.recipientId)+'?orgId='+encodeURIComponent(f.orgId),f.ownerToken,'DELETE',{});
 const result=await call(path,f.ownerToken);expect((await result.json()).grants[0].revokedAt).toBeTruthy();
});