export type DocumentJob={id:string;status:'queued'|'running'|'succeeded'|'failed'|'cancelled';fileId:string|null;version:number|null;path:string}
export type FileOrigin='human'|'agent'|'unknown'
export type WorkspaceFile = {id:string;scope:string;path:string;origin?:FileOrigin;createdBy:string;createdAt:string;updatedAt:string;version:number;deleted:boolean;contentType:string|null;size:number|null}
export type FileCursor = {path:string;id:string;updatedAt?:string}
export type FileVersion = {version:number;kind:'content'|'deleted';contentType:string|null;size:number|null;createdBy:string;createdAt:string;restoredFrom:number|null;currentVersion:number;isCurrent:boolean;purged:boolean}
export type ExternalFilePermission='view'|'edit'
export type FileAudienceRoom={id:string;name:string}
export type FileAudience={type:'workspace'|'room';roomId?:string;permission:ExternalFilePermission;expiresAt:string|null;version:number}
export type FileAudienceState={audience:FileAudience|null;version:number;rooms:FileAudienceRoom[]}
export type FileAudienceInput={version:number;type:'workspace'|'room'|null;roomId?:string;permission?:ExternalFilePermission;expiresAt?:string|null}
export type ExternalFileInvite={id:string;invitedEmail:string;permission:ExternalFilePermission;accessExpiresAt:string|null;createdAt:string;expiresAt:string;redeemedAt:string|null;revokedAt:string|null;emailDelivery?:{status:'sent'|'failed'|'not_configured'}}
export type ExternalFileGrant={id:string;recipientGithubId:string;recipientLogin:string;recipientEmail:string;permission:ExternalFilePermission;grantedAt:string;expiresAt:string|null;revokedAt:string|null;revokedBy:string|null}
export type PublicFileShareRequest={id:string;fileId:string;filePath:string;scope:string;version:number;currentVersion:number;contentHash:string;contentType:string;size:number;expiresAt:string;allowDownload:boolean;status:'pending'|'approved'|'declined'|'stale'|'cancelled';createdAt:string;requesterLogin:string;decisionAt:string|null;shareId:string|null;revokedAt:string|null;revokedBy:string|null}
export type FilePublicUrlState={url:string|null;version:number;contentType:string|null;canCreate:boolean;canRevoke:boolean}
export type FilePublicUrlResult={url:string;version:number;contentType:string;reused:boolean}
export type FileSearch = {scope:string;origin?:FileOrigin;query?:string;directory?:string;type?:'image'|'video'|'media'|'pdf'|'doc'|'html';createdBy?:string;since?:string;until?:string;includeDeleted?:boolean;directOnly?:boolean;order?:'path'|'recent';cursor?:FileCursor;limit?:number}
export class WorkspaceFileError extends Error {
 constructor(message:string,readonly status:number){super(message);this.name='WorkspaceFileError'}
}
export function workspaceFileApi(base:string,orgId:string,sessionToken:string){
 const path=(id:string)=>`/hx/files/${encodeURIComponent(id)}`
 const url=(route:string,query:Record<string,string>={})=>`${base.replace(/\/$/,'')}${route}?${new URLSearchParams({...query,orgId})}`
 async function response(route:string,method:string,body?:BodyInit,query?:Record<string,string>,contentType='application/json',signal?:AbortSignal){
  const result=await fetch(url(route,query),{method,headers:{'x-session-token':sessionToken,...(body===undefined?{}:{'content-type':contentType})},body,signal})
  if(!result.ok){const error=await result.json().catch(()=>null);throw new WorkspaceFileError(typeof error?.message==='string'?error.message:typeof error?.error==='string'?error.error:`File request failed (${result.status}).`,result.status)}
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
  shareRequests:(fileId?:string,signal?:AbortSignal)=>json<{requests:PublicFileShareRequest[]}>('/hx/files/share-requests','GET',undefined,fileId?{fileId}:{},signal),
  requestPublicShare:(id:string,version:number,expiresIn:number,allowDownload:boolean)=>json<{requestId:string;status:string;fileId:string;version:number;contentHash:string;expiresAt:string;allowDownload:boolean}>(
   `${path(id)}/share-requests`,'POST',{version,requestKey:crypto.randomUUID().replaceAll('-',''),expiresIn,allowDownload}),
  declinePublicShare:(requestId:string)=>json<{requestId:string;status:'declined';decisionAt:string}>('/hx/files/share-requests/decline','POST',{requestId}),
  approvePublicShare:async(requestId:string)=>{
   const result=await json<{shareId:string;url:string;expiresAt:string;allowDownload:boolean}>('/hx/files/share-requests/approve','POST',{requestId})
   const fallback=typeof window==='undefined'?'https://localhost':window.location.origin
   return {...result,url:new URL(result.url,new URL(base||fallback,fallback).origin).toString()}
  },
  revokePublicShare:(shareId:string)=>json<{shareId:string;revokedAt:string}>(`/hx/files/shares/${encodeURIComponent(shareId)}/revoke`,'POST',{}),
  externalInvites:(id:string,signal?:AbortSignal)=>json<{canManage:boolean;invites:ExternalFileInvite[]}>(`${path(id)}/external-grant-invites`,'GET',undefined,undefined,signal),
  externalAudience:(id:string,signal?:AbortSignal)=>json<FileAudienceState>(`${path(id)}/external-audience`,'GET',undefined,undefined,signal),
  updateExternalAudience:(id:string,input:FileAudienceInput)=>json<FileAudienceState>(`${path(id)}/external-audience`,'PUT',input),
  inviteExternal:(id:string,email:string,permission:ExternalFilePermission,expiresInDays:number,inviteExpiresInDays:number)=>json<{invite:ExternalFileInvite&{token:string;inviteUrl:string}}>(`${path(id)}/external-grant-invites`,'POST',{email,permission,expiresInDays,inviteExpiresInDays}),
  revokeExternalInvite:(id:string,inviteId:string)=>json<{revoked:boolean;inviteId:string}>(`${path(id)}/external-grant-invites/${encodeURIComponent(inviteId)}`,'DELETE',{}),
  externalGrants:(id:string,signal?:AbortSignal)=>json<{canManage:boolean;grants:ExternalFileGrant[]}>(`${path(id)}/external-grants`,'GET',undefined,undefined,signal),
  grantExternal:(id:string,recipient:string|{githubId:string},permission:ExternalFilePermission,expiresInDays:number)=>json<{grant:ExternalFileGrant;redemptionPath:string}>(`${path(id)}/external-grants`,'POST',{...(typeof recipient==='string'?{email:recipient}:{recipientGithubId:recipient.githubId}),permission,expiresInDays}),
  updateExternalGrant:(id:string,recipientGithubId:string,permission:ExternalFilePermission,expiresAt:string|null)=>json<{updated:boolean;recipientGithubId:string;permission:ExternalFilePermission;expiresAt:string|null}>(`${path(id)}/external-grants/${encodeURIComponent(recipientGithubId)}`,'PATCH',{permission,expiresAt}),
  searchExternalCollaborators:(id:string,query:string,signal?:AbortSignal)=>json<{people:{githubId:string;login:string;name:string|null}[]}>('/external/collaborators/search','GET',undefined,{resourceType:'file',resourceId:id,q:query},signal),
  revokeExternal:(id:string,recipientGithubId:string)=>json<{revoked:boolean;recipientGithubId:string}>(`${path(id)}/external-grants/${encodeURIComponent(recipientGithubId)}`,'DELETE',{}),
  externalLink:(id:string)=>`${typeof window==='undefined'?'':window.location.origin}/#/external-file/${encodeURIComponent(orgId)}/${encodeURIComponent(id)}`,
  versions:(id:string,before?:number,signal?:AbortSignal)=>json<{versions:FileVersion[]}>(`${path(id)}/versions`,'GET',undefined,before===undefined?{}:{before:String(before)},signal),
  download:async(id:string,version:number,signal?:AbortSignal)=>(await response(`${path(id)}/versions/${version}/content`,'GET',undefined,undefined,'application/json',signal)).blob(),
  remove:(id:string,expectedVersion:number)=>json<{saved:true;version:number}>(path(id),'DELETE',{expectedVersion}),
  restore:(id:string,version:number,expectedVersion:number)=>json<{saved:true;version:number}>(`${path(id)}/restore`,'POST',{version,expectedVersion}),
  purge:(id:string,reason:string,selection:{version:number}|{expectedVersion:number})=>json<{purged?:boolean;purgedCount?:number}>(`${path(id)}/purge`,'POST',{reason,...selection}),
  filePublicUrl:(id:string,signal?:AbortSignal)=>json<FilePublicUrlState>(`${path(id)}/public-url`,'GET',undefined,undefined,signal),
  createFilePublicUrl:(id:string)=>json<FilePublicUrlResult>(`${path(id)}/public-url`,'POST',{}),
  revokeFilePublicUrls:(id:string)=>json<{revoked:true;count:number}>(`${path(id)}/public-url`,'DELETE',{}),
 }
}
type WorkspaceFileApiBase=ReturnType<typeof workspaceFileApi>
type ShareApiMethods='shareRequests'|'requestPublicShare'|'approvePublicShare'|'declinePublicShare'|'revokePublicShare'|'externalGrants'|'grantExternal'|'updateExternalGrant'|'revokeExternal'|'externalLink'|'externalInvites'|'inviteExternal'|'revokeExternalInvite'|'filePublicUrl'|'createFilePublicUrl'|'revokeFilePublicUrls'|'externalAudience'|'updateExternalAudience'
export type WorkspaceFileApi = Omit<WorkspaceFileApiBase,ShareApiMethods> & Partial<Pick<WorkspaceFileApiBase,ShareApiMethods>>
