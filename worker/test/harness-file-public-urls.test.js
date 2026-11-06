import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import worker from '../src/index.js';
import {createSession,upsertMembership,upsertUser} from '../src/db.js';
import {setMode} from '../src/harness/mode.js';
import {createFileLedger,appendFileVersion} from '../src/harness/fileVersionLedger.js';

const orgId='personal:file-public-urls';
const DATA_KEY=btoa('x'.repeat(32));
let ownerToken,memberToken,guestToken,secureEnv;
const call=(path,method='GET',body,session=ownerToken,targetEnv=secureEnv)=>worker.fetch(new Request(`https://example.test${path}${path.includes('?')?'&':'?'}orgId=${encodeURIComponent(orgId)}`,{
 method,headers:{'content-type':'application/json',...(session?{'x-session-token':session}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})
}),targetEnv);
const publicRead=(token,init={},targetEnv=secureEnv)=>worker.fetch(new Request(`https://example.test/workspace-file-public-urls/${token}`,init),targetEnv);
const expectNoStore=response=>{
 for(const name of ['cache-control','cdn-cache-control','cloudflare-cdn-cache-control'])expect(response.headers.get(name)).toBe('no-store');
};

async function makeFile({path='media.png',contentType='image/png',bytes='image-one',id=`file-${crypto.randomUUID()}`}={}){
 const now=new Date().toISOString(),objectKey=`org/${encodeURIComponent(orgId)}/workspace-files/${id}/v1`;
 expect((await createFileLedger(env.DB,{orgId,fileId:id,scope:'workspace',path,createdBy:'url-owner',at:now})).created).toBe(true);
 await env.MEDIA.put(objectKey,bytes,{httpMetadata:{contentType}});
 expect(await appendFileVersion(env.DB,{orgId,fileId:id,expectedVersion:0,createdBy:'url-owner',objectKey,contentHash:'a'.repeat(64),contentType,size:new TextEncoder().encode(bytes).length,at:now})).toMatchObject({saved:true,version:1});
 return {id,objectKey,bytes};
}

async function addVersion(file,{version,bytes,contentType='image/png'}){
 const now=new Date(Date.now()+version).toISOString(),objectKey=`org/${encodeURIComponent(orgId)}/workspace-files/${file.id}/v${version}`;
 await env.MEDIA.put(objectKey,bytes,{httpMetadata:{contentType}});
 expect(await appendFileVersion(env.DB,{orgId,fileId:file.id,expectedVersion:version-1,createdBy:'url-owner',objectKey,contentHash:String(version).repeat(64),contentType,size:new TextEncoder().encode(bytes).length,at:now})).toMatchObject({saved:true,version});
 return {objectKey,bytes};
}

beforeEach(async()=>{
 secureEnv={...env,DATA_KEY,FILE_SIGNING_KEY:btoa('f'.repeat(32))};
 for(const [id,login,role] of [['url-owner','url-owner','owner'],['url-member','url-member','member'],['url-guest','url-guest','guest']]){
  await upsertUser(env.DB,{githubId:id,login,name:login});await upsertMembership(env.DB,orgId,id,role);
 }
 ownerToken=await createSession(env.DB,'url-owner','test');memberToken=await createSession(env.DB,'url-member','test');guestToken=await createSession(env.DB,'url-guest','test');
 await setMode(env.DB,orgId,'harness','url-owner');
});

test('media URLs reuse a current-version link, publish later versions, prevent caching, and rotate on file-wide revoke',async()=>{
 const file=await makeFile({bytes:'image-version-1'});
 const noKey=await call(`/hx/files/${file.id}/public-url`,'POST',{},ownerToken,{...secureEnv,DATA_KEY:undefined});
 expect(noKey.status).toBe(503);
 expect((await env.DB.prepare('SELECT count(*) AS n FROM hx_workspace_file_public_urls WHERE org_id=?1 AND file_id=?2').bind(orgId,file.id).first()).n).toBe(0);
 const created=await call(`/hx/files/${file.id}/public-url`,'POST',{});expect(created.status).toBe(201);
 const first=await created.json();expect(first).toMatchObject({version:1,contentType:'image/png',reused:false});
 const same=await call(`/hx/files/${file.id}/public-url`,'POST',{});expect(same.status).toBe(200);expect(await same.json()).toMatchObject({url:first.url,reused:true});
 const token1=new URL(first.url).pathname.split('/').at(-1);
 const response=await publicRead(token1);expect(response.status).toBe(200);
 expectNoStore(response);
 expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(file.bytes);
 const head=await publicRead(token1,{method:'HEAD'});expect(head.status).toBe(200);expectNoStore(head);expect(await head.text()).toBe('');
 const methodNotAllowed=await publicRead(token1,{method:'POST'});expect(methodNotAllowed.status).toBe(405);expectNoStore(methodNotAllowed);
 const invalidRange=await publicRead(token1,{headers:{range:'bytes=999-'}});expect(invalidRange.status).toBe(416);expectNoStore(invalidRange);
 expect((await publicRead(token1,{}, {...secureEnv,FILE_SIGNING_KEY:btoa('z'.repeat(32))})).status).toBe(200);
 expect((await publicRead(token1,{}, {...secureEnv,DATA_KEY:btoa('y'.repeat(32))})).status).toBe(404);

 const second=await addVersion(file,{version:2,bytes:'image-version-2'});
 const created2=await call(`/hx/files/${file.id}/public-url`,'POST',{});expect(created2.status).toBe(201);
 const secondResult=await created2.json(),token2=new URL(secondResult.url).pathname.split('/').at(-1);
 expect(secondResult.version).toBe(2);expect(secondResult.url).not.toBe(first.url);expect(await publicRead(token1).then(x=>x.status)).toBe(200);
 expect(new TextDecoder().decode(await (await publicRead(token2)).arrayBuffer())).toBe(second.bytes);

 const revoked=await call(`/hx/files/${file.id}/public-url`,'DELETE',{});expect(revoked.status).toBe(200);expect(await revoked.json()).toMatchObject({revoked:true,count:2});
 for(const token of [token1,token2]){const gone=await publicRead(token);expect(gone.status).toBe(404);expectNoStore(gone);}
 const replacement=await call(`/hx/files/${file.id}/public-url`,'POST',{});expect(replacement.status).toBe(201);
 const third=await replacement.json();expect(third.version).toBe(2);expect(third.url).not.toBe(secondResult.url);
 expect(await publicRead(token2).then(x=>x.status)).toBe(404);
 expect(await publicRead(new URL(third.url).pathname.split('/').at(-1)).then(x=>x.status)).toBe(200);
});

test('guest creation, non-manager revoke, and non-media publication are rejected',async()=>{
 const file=await makeFile({bytes:'private image'});
 const guest=await call(`/hx/files/${file.id}/public-url`,'POST',{},guestToken);expect(guest.status).toBe(403);
 expect((await env.DB.prepare('SELECT count(*) AS n FROM hx_workspace_file_public_urls WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
 const created=await call(`/hx/files/${file.id}/public-url`,'POST',{});expect(created.status).toBe(201);
 const memberRevoke=await call(`/hx/files/${file.id}/public-url`,'DELETE',{},memberToken);expect(memberRevoke.status).toBe(404);
 expect(await publicRead(new URL((await created.json()).url).pathname.split('/').at(-1)).then(x=>x.status)).toBe(200);

 const text=await makeFile({path:'docs/notes.txt',contentType:'text/plain',bytes:'not public media'});
 const rejected=await call(`/hx/files/${text.id}/public-url`,'POST',{});expect(rejected.status).toBe(415);
 expect((await env.DB.prepare('SELECT count(*) AS n FROM hx_workspace_file_public_urls WHERE org_id=?1 AND file_id=?2').bind(orgId,text.id).first()).n).toBe(0);
});

test('uncommon valid image, video, audio, and font types can be published',async()=>{
 for(const contentType of ['image/vnd.adobe.photoshop','video/x-matroska','audio/x-opus+ogg','font/variable-font','application/x-font-woff2']){
  const file=await makeFile({path:`media-${crypto.randomUUID()}`,contentType,bytes:'allowed media'});
  const created=await call(`/hx/files/${file.id}/public-url`,'POST',{});
  expect(created.status).toBe(201);
  const token=new URL((await created.json()).url).pathname.split('/').at(-1);
  const response=await publicRead(token);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(contentType);
 }
});

test('an R2 miss is no-store, a purged version loses its URL, and soft-deleting a file revokes every remaining URL',async()=>{
 const missing=await makeFile({id:'file-r2-missing',bytes:'will disappear'});
 const missingUrl=await call(`/hx/files/${missing.id}/public-url`,'POST',{});const missingToken=new URL((await missingUrl.json()).url).pathname.split('/').at(-1);
 await env.MEDIA.delete(missing.objectKey);
 const miss=await publicRead(missingToken);expect(miss.status).toBe(404);expectNoStore(miss);

 const file=await makeFile({id:'file-purge-rotation',path:'purge.png',bytes:'historical'});
 const first=await call(`/hx/files/${file.id}/public-url`,'POST',{});const token1=new URL((await first.json()).url).pathname.split('/').at(-1);
 await addVersion(file,{version:2,bytes:'current'});
 const second=await call(`/hx/files/${file.id}/public-url`,'POST',{});const token2=new URL((await second.json()).url).pathname.split('/').at(-1);
 const purged=await call(`/hx/files/${file.id}/purge`,'POST',{version:1,reason:'Remove old public version'});expect(purged.status).toBe(200);
 expect((await env.DB.prepare('SELECT count(*) AS n FROM hx_workspace_file_public_urls WHERE org_id=?1 AND file_id=?2').bind(orgId,file.id).first()).n).toBe(1);
 expect((await publicRead(token1)).status).toBe(404);expect((await publicRead(token2)).status).toBe(200);
 const deleted=await call(`/hx/files/${file.id}`,'DELETE',{expectedVersion:2});expect(deleted.status).toBe(200);expect(await deleted.json()).toMatchObject({saved:true,version:3});
 expect((await env.DB.prepare('SELECT count(*) AS n FROM hx_workspace_file_public_urls WHERE org_id=?1 AND file_id=?2').bind(orgId,file.id).first()).n).toBe(0);
 expect((await publicRead(token2)).status).toBe(404);
});
