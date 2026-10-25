export type WorkspaceFileView={folderMode:boolean;directory:string;search:string;includeDeleted:boolean}
const defaults=():WorkspaceFileView=>({folderMode:false,directory:'',search:'',includeDeleted:false})
export const workspaceFileViewKey=(host:string,org:string,user:string,channel:string)=>`honmaru:file-view:${JSON.stringify([host,org,user,channel])}`
const text=(value:unknown):value is string=>typeof value==='string'&&value.length<=1024&&!/[\u0000-\u001f\u007f]/.test(value)
export function readWorkspaceFileView(key?:string):WorkspaceFileView {
 if(!key)return defaults()
 try{
  const raw=sessionStorage.getItem(key);if(!raw||raw.length>8192)return defaults()
  const value=JSON.parse(raw)
  if(!value||value.version!==1||typeof value.folderMode!=='boolean'||typeof value.includeDeleted!=='boolean'||!text(value.search)||!text(value.directory))return defaults()
  if(value.directory&&(!value.directory.endsWith('/')||value.directory.startsWith('/')||value.directory.includes('\\')||value.directory.slice(0,-1).split('/').some((part:string)=>!part||part==='.'||part==='..')))return defaults()
  return {folderMode:value.folderMode,directory:value.directory,search:value.search,includeDeleted:value.includeDeleted}
 }catch{return defaults()}
}
export function saveWorkspaceFileView(key:string|undefined,value:WorkspaceFileView){
 if(!key)return
 // Per-tab navigation state. No credentials, file bodies, or pagination tokens.
 try{sessionStorage.setItem(key,JSON.stringify({version:1,...value}))}catch{/* Storage is optional. */}
}
