export type DocumentJob={id:string;status:'queued'|'running'|'succeeded'|'failed'|'cancelled';fileId:string|null;version:number|null;path:string}
export type FileOrigin='human'|'agent'|'unknown'
export type WorkspaceFile = {id:string;scope:string;path:string;origin?:FileOrigin;createdBy:string;createdAt:string;updatedAt:string;version:number;deleted:boolean;contentType:string|null;size:number|null}
export type FileCursor = {path:string;id:string;updatedAt?:string}
export type FileVersion = {version:number;kind:'content'|'deleted';contentType:string|null;size:number|null;createdBy:string;createdAt:string;restoredFrom:number|null;currentVersion:number;isCurrent:boolean;purged:boolean}
export type FileSearch = {scope:string;origin?:FileOrigin;query?:string;directory?:string;type?:'image'|'video'|'media'|'pdf'|'doc'|'html';createdBy?:string;since?:string;until?:string;includeDeleted?:boolean;directOnly?:boolean;order?:'path'|'recent';cursor?:FileCursor;limit?:number}
export type WorkspaceFileShare={id:string;status:'pending'|'active'|'revoked'|'stopped'|'expired';reusable:boolean;currentRevision:number;createdBy:string;createdAt:string;updatedAt:string;expiresAt:string|null;allowDownload:boolean;files:Array<{fileId:string;version:number;name:string;contentType:string;size:number}>}
export type FilePublicUrlState={url:string|null;version:number;contentType:string|null;canCreate:boolean;canRevoke:boolean}
export type FilePublicUrlResult={url:string;version:number;contentType:string;reused:boolean}
export class WorkspaceFileError extends Error {
 constructor(message:string,readonly status:number){super(message);this.name='WorkspaceFileError'}
}
export function workspaceFileApi(base:string,orgId:string,sessionToken:string){
 const path=(id:string)=>`/hx/files/${encodeURIComponent(id)}`
 const url=(route:string,query:Record<string,string>={})=>`${base.replace(/\/$/,'')}${route}?${new URLSearchParams({...query,orgId})}`
 async function response(route:string,method:string,body?:BodyInit,query?:Record<string,string>,contentType='application/json',signal?:AbortSignal){
  const result=await fetch(url(route,query),{method,headers:{'x-session-token':sessionToken,...(body===undefined?{}:{'content-type':contentType})},body,signal})
  if(!result.ok){const error=await result.json().catch(()=>null);throw new WorkspaceFileError(typeof error?.message==='string'?error.message:`File request failed (${result.status}).`,result.status)}
  return result
 }
 async function json<T>(route:string,method:string,body?:Record<string,unknown>,query?:Record<string,string>,signal?:AbortSignal):Promise<T>{
  return (await response(route,method,body===undefined?undefined:JSON.stringify(body),query,'application/json',signal)).json()
 }
 return {
  documentJobs:(scope:string,signal?:AbortSignal)=>json<{jobs:DocumentJob[]}>('/hx/documents','GET',undefined,{scope},signal),
  documentNodes:(signal?:AbortSignal)=>json<{nodes:{id:string;name:string}[]}>('/hx/documents/nodes','GET',undefined,undefined,signal),
  createDocument:(input:{scope:string;path:string;text:string;inputFormat:'markdown'|'html';format:'pdf'|'docx';gatewayId:string;requestId:string},signal?:AbortSignal)=>json<{job:DocumentJob}>('/hx/documents','POST',input,undefined,signal),
  documentJob:(id:string,signal?:AbortSignal)=>json<{job:DocumentJob}>(`/hx/documents/${encodeURIComponent(id)}`,'GET',undefined,undefined,signal),
  cancelDocument:(id:string,signal?:AbortSignal)=>json<{job:DocumentJob}>(`/hx/documents/${encodeURIComponent(id)}/cancel`,'POST',{},undefined,signal),
  get:(id:string,signal?:AbortSignal)=>json<{file:WorkspaceFile}>(path(id),'GET',undefined,undefined,signal),
  resolveScope:(channel:string,signal?:AbortSignal)=>json<{scope:string}>('/hx/files/scope','GET',undefined,{channel},signal),
  list:(search:FileSearch,signal?:AbortSignal)=>{
   const query:Record<string,string>={scope:search.scope}
   for(const key of ['origin','query','directory','type','createdBy','since','until','includeDeleted','directOnly','order','limit'] as const)if(search[key]!==undefined)query[key]=String(search[key])
   if(search.cursor)query.cursor=JSON.stringify(search.cursor)
   return json<{files:WorkspaceFile[];next:FileCursor|null}>('/hx/files','GET',undefined,query,signal)
  },
  folders:(scope:string,directory:string,includeDeleted:boolean,cursor?:string,signal?:AbortSignal,origin?:FileOrigin)=>json<{folders:{name:string;path:string}[];next:string|null}>('/hx/files/folders','GET',undefined,{scope,directory,includeDeleted:String(includeDeleted),...(origin?{origin}:{}),...(cursor?{cursor}:{})},signal),
  create:(scope:string,filePath:string,requestId?:string)=>json<{id:string;version:number}>('/hx/files','POST',{scope,path:filePath,...(requestId?{requestId}:{})}),
  upload:async(id:string,expectedVersion:number,file:Blob,signal?:AbortSignal)=>{
   const result=await response(`${path(id)}/content`,'PUT',file,{expectedVersion:String(expectedVersion),size:String(file.size)},file.type||'application/octet-stream',signal)
   return result.json() as Promise<{saved:true;version:number}>
  },
  versions:(id:string,before?:number,signal?:AbortSignal)=>json<{versions:FileVersion[]}>(`${path(id)}/versions`,'GET',undefined,before===undefined?{}:{before:String(before)},signal),
  download:async(id:string,version:number,signal?:AbortSignal)=>(await response(`${path(id)}/versions/${version}/content`,'GET',undefined,undefined,'application/json',signal)).blob(),
  remove:(id:string,expectedVersion:number)=>json<{saved:true;version:number}>(path(id),'DELETE',{expectedVersion}),
  restore:(id:string,version:number,expectedVersion:number)=>json<{saved:true;version:number}>(`${path(id)}/restore`,'POST',{version,expectedVersion}),
  purge:(id:string,reason:string,selection:{version:number}|{expectedVersion:number})=>json<{purged?:boolean;purgedCount?:number}>(`${path(id)}/purge`,'POST',{reason,...selection}),
  filePublicUrl:(id:string,signal?:AbortSignal)=>json<FilePublicUrlState>(`${path(id)}/public-url`,'GET',undefined,undefined,signal),
  createFilePublicUrl:(id:string)=>json<FilePublicUrlResult>(`${path(id)}/public-url`,'POST',{}),
  revokeFilePublicUrls:(id:string)=>json<{revoked:true;count:number}>(`${path(id)}/public-url`,'DELETE',{}),
  fileShares:(id:string,signal?:AbortSignal)=>json<{shares:WorkspaceFileShare[];canManage:boolean}>(`${path(id)}/shares`,'GET',undefined,undefined,signal),
  createFileShare:(id:string,input:{version:number;assets:Array<{fileId:string;version:number}>;expiresIn:'24h'|'7d'|'30d'|'never';allowDownload:boolean;reusable:boolean;requestKey:string})=>json<{share:WorkspaceFileShare;token:string}>(`${path(id)}/shares`,'POST',input),
  copyFileShare:(id:string,shareId:string)=>json<{token:string}>(`${path(id)}/shares/${encodeURIComponent(shareId)}/copy`,'POST',{}),
  updateFileShare:(id:string,shareId:string,input:{version:number;assets:Array<{fileId:string;version:number}>})=>json<{share:WorkspaceFileShare;token:string}>(`${path(id)}/shares/${encodeURIComponent(shareId)}/update`,'POST',input),
  changeFileShare:(id:string,shareId:string,action:'revoke'|'stop')=>json<{revoked:true;status:'revoked'|'stopped'}>(`${path(id)}/shares/${encodeURIComponent(shareId)}/${action}`,'POST',{}),
 }
}
export type WorkspaceFileApi = ReturnType<typeof workspaceFileApi>
