import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import sql from '../document-jobs.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {setMode} from '../src/harness/mode.js';
import {enqueueDocumentJob,readDocumentJob,cancelDocumentJob} from '../src/harness/documentJobs.js';
const org='document-test',actor='document-author';
const input={gatewayId:'document-node',requestId:'stable',scope:'workspace',path:'report.pdf',text:'# 日本語',inputFormat:'markdown',format:'pdf'};
const enqueue=(extra={})=>enqueueDocumentJob(env.DB,org,actor,{...input,...extra});
beforeEach(async()=>{
 await env.DB.exec(sql.replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 for(const id of [actor,'other']){await upsertUser(env.DB,{githubId:id,login:id,name:id});await upsertMembership(env.DB,org,id,'admin');}
 await setMode(env.DB,org,'harness',actor);
 await env.DB.prepare('INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6)').bind(input.gatewayId,org,'Node','hash',actor,Date.now()).run();
});
test('idempotent private document queue and cancellation',async()=>{
 const first=await enqueue();expect(first.job.status).toBe('queued');expect(await enqueue()).toEqual(first);
 expect((await enqueue({text:'changed'})).status).toBe(409);
 expect((await readDocumentJob(env.DB,org,'other',first.job.id)).status).toBe(404);
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_gateway_jobs').first()).n).toBe(0);
 expect(JSON.stringify(first)).not.toContain(input.text);
 expect((await cancelDocumentJob(env.DB,org,actor,first.job.id)).job.status).toBe('cancelled');
 expect((await enqueue()).job.status).toBe('cancelled');
});
test('scope, node, extension and Simple mode admission checks',async()=>{
 expect((await enqueue({scope:'b:missing'})).status).toBe(409);
 expect((await enqueue({path:'report.docx'})).status).toBe(400);
 await env.DB.prepare('UPDATE hx_gateways SET revoked_at=1 WHERE id=?1').bind(input.gatewayId).run();
 expect((await enqueue()).status).toBe(409);
 await setMode(env.DB,org,'simple',actor);expect((await enqueue()).status).toBe(403);
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_document_jobs').first()).n).toBe(0);
});
test('revoked membership blocks read and replay',async()=>{
 const first=await enqueue();expect(first.job).toBeTruthy();
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(org,actor).run();
 expect((await readDocumentJob(env.DB,org,actor,first.job.id)).error).toBeTruthy();expect((await enqueue()).error).toBeTruthy();
});
test('concurrent retries cannot create duplicate documents and queue has a hard limit',async()=>{
 const results=await Promise.all([enqueue(),enqueue()]);
 expect(results.some(r=>r.job)).toBe(true);
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_document_jobs').first()).n).toBe(1);
 for(let i=1;i<25;i++)expect((await enqueue({requestId:'request-'+i})).job).toBeTruthy();
 expect((await enqueue({requestId:'overflow'})).status).toBe(409);
 expect((await enqueue()).job).toBeTruthy();
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_document_jobs').first()).n).toBe(25);
});

test('document capability, exclusive leases, expiry and cancellation are enforced',async()=>{
 const {claimDocumentJob,heartbeatDocumentJob,authorizeDocumentLease}=await import('../src/harness/documentLeases.js');
 const job=(await enqueue()).job;
 expect(await claimDocumentJob(env.DB,input.gatewayId)).toEqual({job:null});
 const at=Date.now(),options={capabilities:['document-conversion-v1'],at};
 const claims=await Promise.all([claimDocumentJob(env.DB,input.gatewayId,options),claimDocumentJob(env.DB,input.gatewayId,options)]);
 expect(claims.filter(c=>c.job)).toHaveLength(1);
 const claimed=claims.find(c=>c.job).job;expect(claimed.id).toBe(job.id);expect(claimed.payload.text).toBe(input.text);
 const identity={gatewayId:input.gatewayId,jobId:job.id,lease:claimed.lease};
 expect(await authorizeDocumentLease(env.DB,{...identity,lease:'wrong'},at)).toBeNull();
 expect(await heartbeatDocumentJob(env.DB,identity,at+80000)).toEqual({renewed:true});
 expect(await authorizeDocumentLease(env.DB,identity,at+90001)).toBeTruthy();
 expect(await heartbeatDocumentJob(env.DB,identity,at+240000)).toEqual({renewed:false});
 await cancelDocumentJob(env.DB,org,actor,job.id);
 expect(await authorizeDocumentLease(env.DB,identity,at+80001)).toBeNull();
});
test('revocation expires jobs and never returns document payload',async()=>{
 const {claimDocumentJob,expireDocumentJobs,authorizeDocumentLease}=await import('../src/harness/documentLeases.js');
 const job=(await enqueue()).job;
 const claimed=(await claimDocumentJob(env.DB,input.gatewayId,{capabilities:['document-conversion-v1']})).job;
 await env.DB.prepare('UPDATE hx_gateways SET revoked_at=1 WHERE id=?1').bind(input.gatewayId).run();
 expect(await authorizeDocumentLease(env.DB,{gatewayId:input.gatewayId,jobId:job.id,lease:claimed.lease})).toBeNull();
 await expireDocumentJobs(env.DB);
 expect((await readDocumentJob(env.DB,org,actor,job.id)).job.status).toBe('failed');
 expect(await claimDocumentJob(env.DB,input.gatewayId,{capabilities:['document-conversion-v1']})).toEqual({job:null});
});
test('silent expired jobs fail instead of being executed twice and failures release the node',async()=>{
 const {claimDocumentJob,expireDocumentJobs,failDocumentJob}=await import('../src/harness/documentLeases.js');
 const first=(await enqueue()).job,at=Date.now();
 const options={capabilities:['document-conversion-v1'],at};
 await claimDocumentJob(env.DB,input.gatewayId,options);
 await expireDocumentJobs(env.DB,at+90000);
 expect((await readDocumentJob(env.DB,org,actor,first.id)).job.status).toBe('failed');
 expect(await claimDocumentJob(env.DB,input.gatewayId,{...options,at:at+90001})).toEqual({job:null});
 await enqueue({requestId:'second'});
 const next=(await claimDocumentJob(env.DB,input.gatewayId,options)).job;
 expect(await failDocumentJob(env.DB,{gatewayId:input.gatewayId,jobId:next.id,lease:'wrong'},at)).toEqual({failed:false});
 expect(await failDocumentJob(env.DB,{gatewayId:input.gatewayId,jobId:next.id,lease:next.lease},at)).toEqual({failed:true});
 expect((await readDocumentJob(env.DB,org,actor,next.id)).job.status).toBe('failed');
});
async function artifactSetup(){
 const {default:files}=await import('../workspace-files.sql?raw');await env.DB.exec(files.replace(/\n/g,' '));
 const {claimDocumentJob}=await import('../src/harness/documentLeases.js');
 const {publishDocumentArtifact}=await import('../src/harness/documentArtifacts.js');
 await enqueue();const job=(await claimDocumentJob(env.DB,input.gatewayId,{capabilities:['document-conversion-v1']})).job;
 return {job,publishDocumentArtifact,identity:{gatewayId:input.gatewayId,jobId:job.id,lease:job.lease},bytes:new TextEncoder().encode('%PDF-synthetic-test')};
}
test('document bytes, immutable file version and successful job commit together',async()=>{
 const {identity,bytes,publishDocumentArtifact,job}=await artifactSetup();
 const result=await publishDocumentArtifact(env,identity,{bytes});expect(result.saved).toBe(true);
 expect(await publishDocumentArtifact(env,identity,{bytes})).toEqual(result);
 expect(await publishDocumentArtifact(env,{...identity,lease:'wrong'},{bytes})).toEqual({saved:false});
 expect(await publishDocumentArtifact(env,identity,{bytes:new TextEncoder().encode('%PDF-different-result')})).toEqual({saved:false});
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_workspace_file_versions').first()).n).toBe(1);
 const done=(await readDocumentJob(env.DB,org,actor,job.id)).job;expect(done.status).toBe('succeeded');expect(done.fileId).toBe(result.fileId);
 const version=await env.DB.prepare('SELECT * FROM hx_workspace_file_versions WHERE file_id=?1').bind(result.fileId).first();
 expect((await env.DB.prepare('SELECT source FROM hx_workspace_file_origins WHERE file_id=?1').bind(result.fileId).first()).source).toBe('human');
 expect(version.content_type).toBe('application/pdf');expect(version.version).toBe(1);
 expect(new Uint8Array(await (await env.MEDIA.get(version.object_key)).arrayBuffer())).toEqual(bytes);
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_workspace_file_uploads').first()).n).toBe(0);
});
test('cancellation during object upload prevents file publication and cleans object',async()=>{
 const {identity,bytes,publishDocumentArtifact,job}=await artifactSetup();
 const media={put:async(...args)=>{const r=await env.MEDIA.put(...args);await cancelDocumentJob(env.DB,org,actor,job.id);return r;},head:(...a)=>env.MEDIA.head(...a),delete:(...a)=>env.MEDIA.delete(...a)};
 expect(await publishDocumentArtifact({...env,MEDIA:media},identity,{bytes})).toEqual({saved:false});
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_workspace_file_versions').first()).n).toBe(0);
 expect((await env.MEDIA.list()).objects).toHaveLength(0);
});
test('artifact cannot overwrite an existing path and invalid format is rejected before upload',async()=>{
 const {identity,bytes,publishDocumentArtifact}=await artifactSetup();
 await expect(publishDocumentArtifact(env,identity,{bytes:new TextEncoder().encode('wrong format')})).rejects.toThrow('format');
 const {createFileLedger}=await import('../src/harness/fileVersionLedger.js');
 await createFileLedger(env.DB,{orgId:org,fileId:'existing',scope:input.scope,path:input.path,createdBy:actor});
 expect(await publishDocumentArtifact(env,identity,{bytes})).toEqual({saved:false});
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_workspace_file_versions').first()).n).toBe(0);
 expect((await env.MEDIA.list()).objects).toHaveLength(0);
});
test('lost commit response preserves the published artifact and retry acknowledges the same version',async()=>{
 const {identity,bytes,publishDocumentArtifact}=await artifactSetup();
 const db={prepare:(...a)=>env.DB.prepare(...a),batch:async statements=>{await env.DB.batch(statements);throw Error('response lost');}};
 const first=await publishDocumentArtifact({...env,DB:db},identity,{bytes});expect(first.saved).toBe(true);
 expect(await publishDocumentArtifact(env,identity,{bytes})).toEqual(first);
 expect((await env.MEDIA.list()).objects).toHaveLength(1);
});
test('JSON escaping cannot bypass the stored document input bound',async()=>{
 expect((await enqueue({text:'\u0000'.repeat(400000)})).status).toBe(413);
 expect((await enqueue({text:'x'.repeat(2000000)})).status).toBe(413);
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_document_jobs').first()).n).toBe(0);
});
test('HTTP document flow authenticates owner and node, then serves an idempotent binary receipt',async()=>{
 const {default:files}=await import('../workspace-files.sql?raw');await env.DB.exec(files.replace(/\n/g,' '));
 const {createSession}=await import('../src/db.js');const session=await createSession(env.DB,actor,'test');
 const {default:worker}=await import('../src/index.js');
 const token='hgw_'+crypto.randomUUID()+crypto.randomUUID();
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
 await env.DB.prepare('UPDATE hx_gateways SET token_hash=?1 WHERE id=?2').bind(hash,input.gatewayId).run();
 const call=(path,body,headers={},method='POST')=>worker.fetch(new Request('https://example.com'+path,{method,headers,...(method==='GET'?{}:{body})}),env,{waitUntil(){}});
 const admitted=await call('/hx/documents?orgId='+org,JSON.stringify(input),{'x-session-token':session,'content-type':'application/json'});expect(admitted.status).toBe(200);
 expect((await (await call('/hx/documents/nodes?orgId='+org,null,{'x-session-token':session},'GET')).json()).nodes).toEqual([]);
 const job=(await admitted.json()).job;
 const {enqueueExecution}=await import('../src/harness/executions.js');
 expect((await enqueueExecution(env.DB,org,actor,{gatewayId:input.gatewayId,requestId:'ordinary',code:'return 1'})).job).toBeTruthy();
 expect((await call('/gateways/documents/claim','{}',{'content-type':'application/json'})).status).toBe(401);
 const claimed=await call('/gateways/documents/claim',JSON.stringify({capabilities:['document-conversion-v1']}),{authorization:'Bearer '+token,'content-type':'application/json'});
 expect(claimed.status).toBe(200);const lease=(await claimed.json()).job.lease;
 expect((await (await call('/hx/documents/nodes?orgId='+org,null,{'x-session-token':session},'GET')).json()).nodes.map(n=>n.id)).toEqual([input.gatewayId]);
 expect((await (await call('/gateways/claim','{}',{authorization:'Bearer '+token,'content-type':'application/json'})).json()).job).toBeNull();
 const path='/gateways/documents/jobs/'+job.id+'/artifact',headers={authorization:'Bearer '+token,'content-type':'application/octet-stream','x-honmaru-lease':lease};
 const first=await call(path,'%PDF-http-synthetic',headers);expect(first.status).toBe(200);const saved=await first.json();expect(saved.saved).toBe(true);
 expect((await (await call('/gateways/claim','{}',{authorization:'Bearer '+token,'content-type':'application/json'})).json()).job).toBeTruthy();
 expect(await (await call(path,'%PDF-http-synthetic',headers)).json()).toEqual(saved);
 expect((await call(path,'%PDF-different',headers)).status).toBe(409);
 const status=await call('/hx/documents/'+job.id+'?orgId='+org,null,{'x-session-token':session},'GET');expect((await status.json()).job.status).toBe('succeeded');
 const events=(await env.DB.prepare("SELECT action FROM audit_events WHERE org_id=?1 AND action LIKE 'document.%'").bind(org).all()).results;
 expect(events.map(e=>e.action)).toEqual(expect.arrayContaining(['document.conversion_requested','document.artifact_received']));
});
test('account erasure removes queued document source and invalidates active leases',async()=>{
 const {claimDocumentJob,authorizeDocumentLease}=await import('../src/harness/documentLeases.js');
 const {exportAccount,deleteAccount}=await import('../src/account.js');
 await enqueue();const job=(await claimDocumentJob(env.DB,input.gatewayId,{capabilities:['document-conversion-v1']})).job;
 const exported=await exportAccount(env.DB,actor,actor);expect(exported.documentJobs).toHaveLength(1);expect(exported.documentJobs[0].payload).toContain('日本語');expect(JSON.stringify(exported.documentJobs)).not.toContain(job.lease);
 await deleteAccount(env.DB,actor,actor);
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_document_jobs').first()).n).toBe(0);
 expect(await authorizeDocumentLease(env.DB,{gatewayId:input.gatewayId,jobId:job.id,lease:job.lease})).toBeNull();
});
test('document retention prunes receipts but preserves published file versions',async()=>{
 const {identity,bytes,publishDocumentArtifact}=await artifactSetup();const saved=await publishDocumentArtifact(env,identity,{bytes});
 const {maintainDocumentJobs,DOCUMENT_JOB_RETENTION_MS}=await import('../src/harness/documentMaintenance.js');
 expect(await maintainDocumentJobs(env.DB,Date.now()+DOCUMENT_JOB_RETENTION_MS+1000)).toEqual({removed:1});
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_workspace_file_versions WHERE file_id=?1').bind(saved.fileId).first()).n).toBe(1);
 expect((await env.MEDIA.list()).objects).toHaveLength(1);
});
test('workspace purge removes document sources and prevents delivery after purge starts',async()=>{
 const {job,identity,bytes,publishDocumentArtifact}=await artifactSetup();
 const {purgeWorkspace}=await import('../src/workspaceDeletion.js');
 await env.DB.prepare("INSERT INTO workspace_tombstones(org_id,deleted_at) VALUES(?1,?2)").bind(org,new Date().toISOString()).run();
 expect(await publishDocumentArtifact(env,identity,{bytes})).toEqual({saved:false});
 expect(await purgeWorkspace(env,org,{budget:1000})).toBe(true);
 expect(await env.DB.prepare('SELECT 1 FROM hx_document_jobs WHERE id=?1').bind(job.id).first()).toBeNull();
});
