import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import sql from '../workspace-files.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {createFileLedger} from '../src/harness/fileVersionLedger.js';
import {uploadFileVersion} from '../src/harness/fileUpload.js';
import {proposePublicFileShare,approvePublicFileShare,revokePublicFileShare,servePublicFileShare} from '../src/harness/fileShareApprovals.js';
import {handleFileShareRoutes} from '../src/harness/fileShareApprovals.js';

const orgId='share-org',fileId='public-report',ownerId='share-owner',otherId='share-other';
const upload=(expectedVersion=0,text='approved snapshot')=>uploadFileVersion(env,{orgId,fileId,userId:ownerId,expectedVersion,
 stream:new Blob([text]).stream(),size:new TextEncoder().encode(text).length,contentType:'text/plain'});
const propose=(overrides={})=>proposePublicFileShare(env,{orgId,fileId,version:1,userId:ownerId,login:'share-owner',
 requestKey:crypto.randomUUID().replaceAll('-',''),expiresIn:86400,allowDownload:false,...overrides});
const approve=(requestId,userId=ownerId,login='share-owner')=>approvePublicFileShare(env,{orgId,requestId,userId,login});
const publicGet=token=>servePublicFileShare(new Request('https://honmaru.test/hx/public-file-shares/'+token),env,token);

beforeEach(async()=>{
 await env.DB.exec(sql.replace(/\n/g,' '));
 await upsertUser(env.DB,{githubId:ownerId,login:'share-owner',name:'Owner'});
 await upsertUser(env.DB,{githubId:otherId,login:'share-other',name:'Other'});
 await upsertMembership(env.DB,orgId,ownerId,'member');
 await upsertMembership(env.DB,orgId,otherId,'member');
 await createFileLedger(env.DB,{orgId,fileId,scope:'workspace',path:'report.txt',createdBy:ownerId});
 await upload();
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

test('the review queue returns authorized file snapshot metadata but never the token',async()=>{
 const request=await propose(),published=await approve(request.requestId);
 const token=published.url.split('/').at(-1);
 const queueRequest=new Request('https://honmaru.test/hx/files/share-requests?orgId='+orgId);
 const response=await handleFileShareRoutes(queueRequest,env,new URL(queueRequest.url),{orgId,userId:ownerId,login:'share-owner'});
 const result=await response.json();
 expect(result.requests[0]).toMatchObject({fileId,filePath:'report.txt',scope:'workspace',version:1,contentType:'text/plain',size:17,status:'approved',shareId:published.shareId});
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
});

test('an approved old snapshot stops serving as soon as its file revision changes',async()=>{
 const request=await propose(),published=await approve(request.requestId),token=published.url.split('/').at(-1);
 expect((await publicGet(token)).status).toBe(200);
 expect((await upload(1,'changed')).saved).toBe(true);
 expect((await publicGet(token)).status).toBe(404);
});
