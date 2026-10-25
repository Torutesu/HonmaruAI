export type FileOrigin='human'|'agent'|'unknown'
export type WorkspaceFile = {id:string;scope:string;path:string;origin?:FileOrigin;createdBy:string;createdAt:string;updatedAt:string;version:number;deleted:boolean;contentType:string|null;size:number|null}
export type FileCursor = {path:string;id:string;updatedAt?:string}
export type FileVersion = {version:number;kind:'content'|'deleted';contentType:string|null;size:number|null;createdBy:string;createdAt:string;restoredFrom:number|null;currentVersion:number;isCurrent:boolean;purged:boolean}
export type FileSearch = {scope:string;origin?:FileOrigin;query?:string;directory?:string;type?:'image'|'video'|'media'|'pdf'|'doc'|'html';createdBy?:string;since?:string;until?:string;includeDeleted?:boolean;directOnly?:boolean;order?:'path'|'recent';cursor?:FileCursor;limit?:number}
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
 }
}
export type WorkspaceFileApi = ReturnType<typeof workspaceFileApi>
