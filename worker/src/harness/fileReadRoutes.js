import {listWorkspaceFiles} from './fileList.js';
import {listFileVersions,FileVersionInputError} from './fileVersionLedger.js';
import {downloadFileVersion} from './fileDownload.js';

// Mounted behind existing member() authentication and file schema readiness.
// Identity is supplied by that caller, never by a query parameter or body.
export async function handleFileReads(request,env,url,{orgId,userId,headers={}}) {
 if(!/^\/hx\/files(?:\/|$)/.test(url.pathname))return null;
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'content-type':'application/json','cache-control':'private, no-store'}});
 if(request.method!=='GET')return json({message:'Method not allowed.'},405);
 try {
  const parts=url.pathname.split('/').filter(Boolean),params=url.searchParams;
  const integer=(name,fallback)=>{
   const value=params.get(name);if(value===null)return fallback;
   if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value)))throw new FileVersionInputError(`Invalid ${name}.`);
   return Number(value);
  };
  if(parts.length===2){
   const scope=params.get('scope');if(scope===null)throw new FileVersionInputError('File scope is required.');
   const deleted=params.get('includeDeleted');if(deleted!==null&&!['true','false'].includes(deleted))throw new FileVersionInputError('Invalid deleted filter.');
   let cursor=null;
   if(params.has('cursor')){try{cursor=JSON.parse(params.get('cursor'));}catch{throw new FileVersionInputError('Invalid cursor.');}if(!cursor||typeof cursor!=='object'||Array.isArray(cursor))throw new FileVersionInputError('Invalid cursor.');}
   return json(await listWorkspaceFiles(env.DB,{orgId,userId,scope:scope==='all'?null:scope,query:params.get('query')??'',directory:params.get('directory')??'',type:params.get('type'),createdBy:params.get('createdBy'),since:params.get('since'),until:params.get('until'),includeDeleted:deleted==='true',cursor,limit:integer('limit',50)}));
  }
  let fileId;try{fileId=decodeURIComponent(parts[2]);}catch{throw new FileVersionInputError('Invalid file identifier.');}
  if(parts.length===4&&parts[3]==='versions')return json({versions:await listFileVersions(env.DB,{orgId,userId,fileId,before:integer('before',null),limit:integer('limit',50)})});
  if(parts.length===6&&parts[3]==='versions'&&parts[5]==='content'){
   if(!/^[1-9]\d*$/.test(parts[4])||!Number.isSafeInteger(Number(parts[4])))throw new FileVersionInputError('Invalid version.');
   const response=await downloadFileVersion(env,{orgId,userId,fileId,version:Number(parts[4])});
   if(!response)return json({message:'File content is unavailable.'},404);
   for(const [key,value] of Object.entries(headers))response.headers.set(key,value);
   return response;
  }
  return json({message:'Not found.'},404);
 }catch(error){
  if(error instanceof FileVersionInputError)return json({message:error.message},400);
  throw error;
 }
}
