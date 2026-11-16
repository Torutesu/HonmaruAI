import {allowed} from '../permissions.js';
import {getMode} from './mode.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {FileVersionInputError,readFileVersionContent,workspaceFilePath} from './fileVersionLedger.js';
import {downloadFileVersion} from './fileDownload.js';
import {enqueueDocumentJob,readDocumentJob,cancelDocumentJob} from './documentJobs.js';

const id={type:'string',minLength:1,maxLength:200};
export const DOCUMENT_EXPORT_TOOLS=[
 {name:'create_document_export',title:'Export a workspace document',description:'Convert one exact accessible Markdown or HTML file version to PDF or DOCX on an eligible connected local node. Requires Harness build permission and write scope. Choose either a versioned Workspace destination or a temporary download. Conversion uses the pinned no-network local runtime; source content is limited to 2 MiB.',inputSchema:{type:'object',properties:{fileId:id,version:{type:'integer',minimum:1},format:{type:'string',enum:['pdf','docx']},gatewayId:id,requestId:{type:'string',minLength:1,maxLength:80},destination:{type:'string',maxLength:1024},temporary:{type:'boolean'}},required:['fileId','version','format','gatewayId','requestId'],additionalProperties:false}},
 {name:'get_document_export',title:'Read a document export status',description:'Read metadata for a conversion requested by this token owner. A temporary download link is short-lived and contains no workspace file.',inputSchema:{type:'object',properties:{jobId:id},required:['jobId'],additionalProperties:false}},
 {name:'cancel_document_export',title:'Cancel a document export',description:'Cancel a queued or running document conversion requested by this token owner.',inputSchema:{type:'object',properties:{jobId:id},required:['jobId'],additionalProperties:false}},
];
const out=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const err=(message)=>({isError:true,content:[{type:'text',text:message}]});
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>{const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');};

async function ready(db){const row=await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('hx_document_jobs','hx_document_nodes','hx_document_export_artifacts','hx_document_export_links')").first();return row?.n===4;}
async function allowedBuild(db,agent){return await getMode(db,agent.orgId)==='harness'&&await allowed(db,agent.orgId,String(agent.githubId),'harness.build');}
async function resolveDestination(db,orgId,userId,destination){
 if(typeof destination!=='string'||destination.length>1024||/\\|[\u0000-\u001f\u007f]/.test(destination)||!destination.startsWith('/workspace/'))return null;
 const parts=destination.slice('/workspace/'.length).split('/');
 if(parts[0]==='shared'&&parts.length>1){const path=workspaceFilePath(parts.slice(1).join('/'));return{scope:'workspace',path};}
 if(parts[0]!=='rooms'||parts.length<3)return null;
 const room=parts[1],path=workspaceFilePath(parts.slice(2).join('/'));
 let scope=null;
 if(/^(?:b|g):[A-Za-z0-9_-]{1,200}$/.test(room))scope=room;
 else {
  const row=await db.prepare(`SELECT room.scope FROM (
    SELECT 'b:'||b.slug AS scope FROM businesses b WHERE b.org_id=?1 AND b.archived_at IS NULL AND (b.id=?2 OR b.slug=?2)
    UNION ALL SELECT c.channel AS scope FROM conversation_members c JOIN users u ON u.login=c.login
      WHERE c.org_id=?1 AND u.github_id=?3 AND c.channel='g:'||?2
   ) room LIMIT 1`).bind(orgId,room,String(userId)).first();
  scope=row?.scope||null;
 }
 if(!scope)return null;
 return{scope,path};
}
async function eligibleNode(db,orgId,gatewayId,at=Date.now()){
 return Boolean(await db.prepare(`SELECT 1 FROM hx_document_nodes n JOIN hx_gateways g ON g.id=n.gateway_id AND g.org_id=n.org_id
   JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.created_by
   WHERE n.org_id=?1 AND n.gateway_id=?2 AND n.last_seen_at>?3 AND g.revoked_at IS NULL
    AND lower(trim(m.role)) IN ('owner','admin')`).bind(orgId,gatewayId,at-90000).first());
}
async function createExport(env,agent,args){
 const db=env.DB,orgId=agent.orgId,userId=String(agent.githubId);
 if(!await ready(db))return err('Document conversion is not ready.');
 if(!await allowedBuild(db,agent))return err('Document conversion is not allowed.');
 if(typeof args.fileId!=='string'||!args.fileId||!Number.isSafeInteger(args.version)||args.version<1||!['pdf','docx'].includes(args.format)||typeof args.gatewayId!=='string'||!args.gatewayId||typeof args.requestId!=='string'||!/^[-A-Za-z0-9_]{1,80}$/.test(args.requestId)||typeof args.temporary!=='boolean'||(args.temporary&&args.destination!==undefined)||(!args.temporary&&typeof args.destination!=='string'))return err('Choose a source version, output format, eligible local node, request ID, and exactly one delivery mode.');
 const file=await db.prepare(`SELECT f.id,f.scope,f.path FROM hx_workspace_files f WHERE f.org_id=?1 AND f.id=?2 AND ${fileScopeAuthority('f.org_id','f.scope','?3')}`).bind(orgId,args.fileId,userId).first();
 if(!file)return err('No accessible source file matches that ID.');
 let destination=args.temporary?{scope:file.scope,path:`.honmaru-temporary/${args.requestId}.${args.format}`} : await resolveDestination(db,orgId,userId,args.destination);
 if(!destination)return err('The Workspace destination is unavailable or invalid.');
 if(!destination.path.toLowerCase().endsWith(`.${args.format}`))return err('The destination extension must match the output format.');
 const source=await readFileVersionContent(db,{orgId,fileId:args.fileId,userId,version:args.version});
 if(!source)return err('The requested source version is unavailable or purged.');
 if(source.size>2*1024*1024)return err('Document sources are limited to 2 MiB.');
 const mime=source.contentType.split(';')[0].trim().toLowerCase();
 const inputFormat=mime==='text/markdown'?'markdown':mime==='text/html'?'html':null;
 if(!inputFormat)return err('Only Markdown and HTML files can be converted.');
 const response=await downloadFileVersion(env,{orgId,fileId:args.fileId,userId,version:args.version});
 if(!response)return err('The requested source version is unavailable or purged.');
 const bytes=new Uint8Array(await response.arrayBuffer());
 if(bytes.length!==source.size||bytes.length>2*1024*1024)return err('The source version size could not be verified.');
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return err('The source file is not valid UTF-8 text.');}
 if(!await eligibleNode(db,orgId,args.gatewayId))return err('Choose an eligible, recently connected local document node.');
 const queued=await enqueueDocumentJob(db,orgId,userId,{gatewayId:args.gatewayId,requestId:args.requestId,scope:destination.scope,path:destination.path,text,inputFormat,format:args.format},{delivery:args.temporary?'temporary':'workspace'});
 return queued.error?err(queued.error):out({job:queued.job,sourceFileId:file.id,sourceVersion:args.version,delivery:args.temporary?'temporary':'workspace'});
}
async function readExport(env,agent,args,request){
 const db=env.DB,orgId=agent.orgId,userId=String(agent.githubId);
 if(!await allowedBuild(db,agent))return err('Document conversion is not allowed.');
 const result=await readDocumentJob(db,orgId,userId,args.jobId);
 if(result.error)return err(result.error);
 const job=result.job,payload=await db.prepare('SELECT payload FROM hx_document_jobs WHERE org_id=?1 AND id=?2 AND created_by=?3').bind(orgId,args.jobId,userId).first();
 if(job.status!=='succeeded'||JSON.parse(payload?.payload||'{}').delivery!=='temporary')return out({job,delivery:JSON.parse(payload?.payload||'{}').delivery==='temporary'?'temporary':'workspace'});
 const artifact=await db.prepare(`SELECT a.content_hash,a.content_type,a.size,a.expires_at FROM hx_document_export_artifacts a JOIN hx_document_jobs d ON d.org_id=a.org_id AND d.id=a.job_id WHERE a.org_id=?1 AND a.job_id=?2 AND d.created_by=?3 AND ${fileScopeAuthority('d.org_id','d.scope','?3')}`).bind(orgId,args.jobId,userId).first();
 if(!artifact||artifact.expires_at<=Date.now())return err('The temporary document export has expired.');
 const raw=token(),expiresAt=artifact.expires_at;
 await db.prepare(`INSERT INTO hx_document_export_links(org_id,token_hash,job_id,created_at,expires_at)
  SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM hx_document_export_artifacts a JOIN hx_document_jobs d ON d.org_id=a.org_id AND d.id=a.job_id WHERE a.org_id=?1 AND a.job_id=?3 AND a.expires_at>?4 AND d.created_by=?6 AND ${fileScopeAuthority('d.org_id','d.scope','?6')})`)
  .bind(orgId,await hash(raw),args.jobId,Date.now(),expiresAt,userId).run();
 const link=new URL(`/hx/document-exports/${raw}`,request?.url||'https://invalid.local/').toString();
 return out({job,delivery:'temporary',artifact:{downloadUrl:link,sha256:artifact.content_hash,contentType:artifact.content_type,size:artifact.size,expiresAt:new Date(expiresAt).toISOString()}});
}
async function cancelExport(env,agent,args){
 if(!await allowedBuild(env.DB,agent))return err('Document conversion is not allowed.');
 const result=await cancelDocumentJob(env.DB,agent.orgId,String(agent.githubId),args.jobId);
 return result.error?err(result.error):out({job:result.job});
}
export async function callDocumentExportTool(env,agent,name,args={},request=null){
 if(!DOCUMENT_EXPORT_TOOLS.some(tool=>tool.name===name))return null;
 if(!args||typeof args!=='object'||Array.isArray(args))return err('Invalid document export arguments.');
 try{
  if(name==='create_document_export')return await createExport(env,agent,args);
  if(name==='get_document_export'){
   if(typeof args.jobId!=='string'||!args.jobId)return err('A job ID is required.');
   return await readExport(env,agent,args,request);
  }
  if(typeof args.jobId!=='string'||!args.jobId)return err('A job ID is required.');
  return await cancelExport(env,agent,args);
 }catch(error){if(error instanceof FileVersionInputError)return err(error.message);throw error;}
}
export async function serveTemporaryDocumentExport(request,env,url){
 if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed.',{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
 const raw=url.pathname.split('/').at(-1)||'';
 if(!/^[A-Za-z0-9_-]{40,60}$/.test(raw))return new Response('Not found.',{status:404,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
 const tokenHash=await hash(raw),now=Date.now();
 const row=await env.DB.prepare(`SELECT a.org_id,a.job_id,a.object_key,a.content_hash,a.content_type,a.size,a.expires_at
  FROM hx_document_export_links l JOIN hx_document_export_artifacts a ON a.org_id=l.org_id AND a.job_id=l.job_id
  WHERE l.token_hash=?1 AND l.expires_at>?2 AND a.expires_at>?2`).bind(tokenHash,now).first();
 const gone=()=>new Response('Not found.',{status:404,headers:{'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
 if(!row)return gone();
 const object=await env.MEDIA.get(row.object_key);if(!object||object.size!==row.size||row.size>25*1024*1024)return gone();
 const bytes=new Uint8Array(await object.arrayBuffer());
 if(bytes.length!==row.size||await hashBytes(bytes)!==row.content_hash)return gone();
 if(row.expires_at<=Date.now())return gone();
 return new Response(request.method==='HEAD'?null:bytes,{status:200,headers:{'content-type':row.content_type,'content-length':String(row.size),'content-disposition':'attachment; filename="document-export"','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});
}
async function hashBytes(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
