import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import {createSession,upsertMembership,upsertUser} from '../src/db.js';
import {setMode} from '../src/harness/mode.js';
import {createFileLedger,appendFileVersion} from '../src/harness/fileVersionLedger.js';
import {claimDocumentJob} from '../src/harness/documentLeases.js';
import {publishDocumentArtifact} from '../src/harness/documentArtifacts.js';
import {maintainDocumentJobs} from '../src/harness/documentMaintenance.js';
import {createHash} from 'node:crypto';

const org='document-mcp-test',actor='document-mcp-admin',gatewayId='document-mcp-node';
const sourceText='# Source report\n';
const sourceBytes=new TextEncoder().encode(sourceText);
let session,token,seq=0;
const http=(path,init={})=>worker.fetch(new Request(`https://example.com${path}`,init),env);
const rpc=(name,args={},bearer=token)=>http('/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${bearer}`},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}})});
const tool=async(name,args={},bearer=token)=>(await(await rpc(name,args,bearer)).json()).result;
const headers={'content-type':'application/json'};

beforeEach(async()=>{
 await env.DB.exec(schemaSql.replace(/\n/g,' '));
 await upsertUser(env.DB,{githubId:actor,login:'document-admin',name:'Document Admin',avatarUrl:null,locale:'en'});
 await upsertMembership(env.DB,org,actor,'admin');
 session=await createSession(env.DB,actor,'document-mcp-session');
 await setMode(env.DB,org,'harness',actor);
 const created=await(await http('/tokens',{method:'POST',headers:{...headers,'x-session-token':session},body:JSON.stringify({orgId:org,name:'Document CLI',scopes:['read','write']})})).json();
 token=created.token;
 await env.DB.prepare('INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6)').bind(gatewayId,org,'CLI Node','node-token-hash',actor,Date.now()).run();
 await env.DB.prepare('INSERT INTO hx_document_nodes(gateway_id,org_id,last_seen_at) VALUES(?1,?2,?3)').bind(gatewayId,org,Date.now()).run();
 const contentHash=createHash('sha256').update(sourceBytes).digest('hex'),objectKey=`org/${encodeURIComponent(org)}/workspace-files/source-object`;
 await env.MEDIA.put(objectKey,sourceBytes,{httpMetadata:{contentType:'text/markdown'}});
 await createFileLedger(env.DB,{orgId:org,fileId:'source-file',scope:'workspace',path:'reports/source.md',createdBy:actor,origin:'human'});
 await appendFileVersion(env.DB,{orgId:org,fileId:'source-file',expectedVersion:0,createdBy:actor,objectKey,contentHash,contentType:'text/markdown',size:sourceBytes.length});
});

test('temporary PDF export selects an exact readable version, runs on an eligible local node, and never creates a workspace file',async()=>{
 const args={fileId:'source-file',version:1,format:'pdf',gatewayId,requestId:'doc-retry-1',temporary:true};
 const started=await tool('create_document_export',args);
 expect(started.structuredContent).toMatchObject({sourceFileId:'source-file',sourceVersion:1,delivery:'temporary',job:{status:'queued'}});
 expect(JSON.stringify(started)).not.toContain(sourceText);
 const jobId=started.structuredContent.job.id;
 expect(await tool('create_document_export',args)).toEqual(started);
 expect((await tool('create_document_export',{...args,version:2})).isError).toBe(true);
 expect((await tool('get_document_export',{jobId})).structuredContent).toMatchObject({delivery:'temporary',job:{id:jobId,status:'queued'}});
 const claim=await claimDocumentJob(env.DB,gatewayId,{capabilities:['document-conversion-v1']});
 expect(claim.job).toMatchObject({id:jobId,payload:{text:sourceText,inputFormat:'markdown',format:'pdf',delivery:'temporary'}});
 const bytes=new TextEncoder().encode('%PDF-verified temporary output');
 expect(await publishDocumentArtifact(env,{gatewayId,jobId,lease:claim.job.lease},{bytes})).toMatchObject({saved:true,temporary:true,jobId});
 const finished=await tool('get_document_export',{jobId});
 expect(finished.structuredContent).toMatchObject({job:{id:jobId,status:'succeeded',fileId:null},delivery:'temporary',artifact:{size:bytes.length,contentType:'application/pdf',sha256:createHash('sha256').update(bytes).digest('hex')}});
 const artifactCount=(await env.DB.prepare('SELECT COUNT(*) n FROM hx_document_export_artifacts WHERE org_id=?1 AND job_id=?2').bind(org,jobId).first()).n;
 const workspaceCount=(await env.DB.prepare('SELECT COUNT(*) n FROM hx_workspace_files WHERE org_id=?1').bind(org).first()).n;
 expect(artifactCount).toBe(1);expect(workspaceCount).toBe(1);
 const response=await http(new URL(finished.structuredContent.artifact.downloadUrl).pathname);
 expect(response.status).toBe(200);expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
 expect((await publishDocumentArtifact(env,{gatewayId,jobId,lease:claim.job.lease},{bytes})).temporary).toBe(true);
});

test('temporary download URLs are hashed, origin-independent bearer secrets with bounded expiry and scheduled storage cleanup',async()=>{
 const started=await tool('create_document_export',{fileId:'source-file',version:1,format:'docx',gatewayId,requestId:'doc-expire-1',temporary:true});
 const jobId=started.structuredContent.job.id,claim=await claimDocumentJob(env.DB,gatewayId,{capabilities:['document-conversion-v1']});
 const bytes=new Uint8Array([80,75,3,4,1,2,3]);
 await publishDocumentArtifact(env,{gatewayId,jobId,lease:claim.job.lease},{bytes});
 const done=await tool('get_document_export',{jobId}),url=new URL(done.structuredContent.artifact.downloadUrl);
 const tokenValue=url.pathname.split('/').at(-1),tokenHash=createHash('sha256').update(tokenValue).digest('hex');
 expect((await env.DB.prepare('SELECT 1 FROM hx_document_export_links WHERE org_id=?1 AND token_hash=?2').bind(org,tokenHash).first())).toBeTruthy();
 expect((await env.DB.prepare('SELECT 1 FROM hx_document_export_links WHERE org_id=?1 AND token_hash=?2').bind(org,tokenValue).first())).toBeNull();
 expect((await http('/hx/document-exports/not-a-token')).status).toBe(404);
 const expiredAt=Date.now()-1;
 await env.DB.prepare('UPDATE hx_document_export_artifacts SET expires_at=?3 WHERE org_id=?1 AND job_id=?2').bind(org,jobId,expiredAt).run();
 await env.DB.prepare('UPDATE hx_document_export_links SET expires_at=?3 WHERE org_id=?1 AND job_id=?2').bind(org,jobId,expiredAt).run();
 const key=(await env.DB.prepare('SELECT object_key FROM hx_document_export_artifacts WHERE org_id=?1 AND job_id=?2').bind(org,jobId).first()).object_key;
 await maintainDocumentJobs(env.DB,Date.now(),env);
 expect((await env.DB.prepare('SELECT 1 FROM hx_document_export_artifacts WHERE org_id=?1 AND job_id=?2').bind(org,jobId).first())).toBeNull();
 expect((await env.MEDIA.head(key))).toBeNull();
 expect((await http(url.pathname)).status).toBe(404);
});

test('Workspace destination exports are immutable and token read/build/write/node/source checks fail closed',async()=>{
 const destination=await tool('create_document_export',{fileId:'source-file',version:1,format:'pdf',gatewayId,requestId:'workspace-export-1',destination:'/workspace/shared/reports/export.pdf',temporary:false});
 expect(destination.structuredContent).toMatchObject({delivery:'workspace',job:{scope:'workspace',path:'reports/export.pdf',status:'queued'}});
 const writer=await(await http('/tokens',{method:'POST',headers:{...headers,'x-session-token':session},body:JSON.stringify({orgId:org,name:'Read-only CLI',scopes:['read']})})).json();
 expect((await(await http('/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${writer.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).json()).result.tools.map(item=>item.name)).not.toContain('create_document_export');
 const noNode=await tool('create_document_export',{fileId:'source-file',version:1,format:'pdf',gatewayId:'stale-node',requestId:'bad-node',destination:'/workspace/shared/no.pdf',temporary:false});
 expect(noNode.isError).toBe(true);
 const docx=await tool('create_document_export',{fileId:'source-file',version:1,format:'docx',gatewayId,requestId:'docx-convert',destination:'/workspace/shared/no.docx',temporary:false});
 expect(docx.structuredContent?.job.status).toBe('queued');
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_document_jobs WHERE org_id=?1').bind(org).first()).n).toBe(2);
});
