import {readWorkspaceFileView,saveWorkspaceFileView} from '../utils/workspaceFileView'
import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import {WorkspaceFileError} from '../utils/workspaceFiles'
import type {WorkspaceFileApi,WorkspaceFile,FileVersion,FileCursor} from '../utils/workspaceFiles'
import './WorkspaceFilesPanel.css'
import {WorkspaceFilePreview} from './WorkspaceFilePreview'
import {workspaceFilePreviewKind} from '../utils/workspaceFilePreview'
import {WorkspaceFileUpload} from './WorkspaceFileUpload'

export function RoomFilesPanel({api,channel,preferenceKey,onClose,onAttachments}:{api:WorkspaceFileApi;channel:string;preferenceKey?:string;onClose:()=>void;onAttachments:()=>void}){
 const t=useT(),[scope,setScope]=useState<string|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0)
 useEffect(()=>{let live=true;const controller=new AbortController();setScope(null);setError('')
  api.resolveScope(channel,controller.signal).then(result=>{if(live)setScope(result.scope)}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,channel,revision])
 if(scope)return <WorkspaceFilesPanel key={`${scope}:${preferenceKey}`} api={api} scope={scope} preferenceKey={preferenceKey} onClose={onClose} onAttachments={onAttachments}/>
 return <aside className="hx-room-resource slk-pane hx-files-panel" aria-label={t('Files')}><header><strong>{t('Files')}</strong><button onClick={onClose} aria-label={t('Close resources')}><Icon name="x" size={16}/></button></header><div className="hx-files-state" role={error?'alert':'status'}>{error||t('Loading…')}{error&&<button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button>}</div><footer><button onClick={onAttachments}>{t('Message attachments')}</button></footer></aside>
}

export function WorkspaceFilesPanel({api,scope,preferenceKey,onClose,onAttachments}:{api:WorkspaceFileApi;scope:string;preferenceKey?:string;onClose:()=>void;onAttachments:()=>void}){
 const [saved]=useState(()=>readWorkspaceFileView(preferenceKey))
 const t=useT(),[query,setQuery]=useState(saved.search),[search,setSearch]=useState(saved.search),[revision,setRevision]=useState(0)
 const [files,setFiles]=useState<WorkspaceFile[]|null>(null),[cursor,setCursor]=useState<FileCursor|null>(null),[next,setNext]=useState<FileCursor|null>(null)
 const [includeDeleted,setIncludeDeleted]=useState(saved.includeDeleted)
 const [folderMode,setFolderMode]=useState(saved.folderMode),[directory,setDirectory]=useState(saved.directory)
 const [folders,setFolders]=useState<{name:string;path:string}[]>([]),[folderCursor,setFolderCursor]=useState<string|undefined>(),[folderNext,setFolderNext]=useState<string|null>(null)
 const [error,setError]=useState(''),[selected,setSelected]=useState<WorkspaceFile|null>(null)
 useEffect(()=>{const controller=new AbortController();let live=true;setFiles(null);setError('')
  Promise.all([
   api.list({scope,includeDeleted,query:search,order:folderMode?'path':'recent',...(folderMode?{directory,directOnly:!search}:{}),...(cursor?{cursor}:{})},controller.signal),
   folderMode&&!search?api.folders(scope,directory,includeDeleted,folderCursor,controller.signal):Promise.resolve({folders:[],next:null})
  ]).then(([result,tree])=>{if(live){setFiles(result.files);setNext(result.next);setFolders(tree.folders);setFolderNext(tree.next)}}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,scope,search,cursor,revision,includeDeleted,folderMode,directory,folderCursor])
 useEffect(()=>{setSelected(null);setCursor(null);setFolderCursor(undefined)},[api,scope])
 useEffect(()=>saveWorkspaceFileView(preferenceKey,{folderMode,directory,search,includeDeleted}),[preferenceKey,folderMode,directory,search,includeDeleted])
 const openDirectory=(path:string)=>{setDirectory(path);setCursor(null);setFolderCursor(undefined);setQuery('');setSearch('')}
 return <aside className="hx-room-resource slk-pane hx-files-panel" aria-label={t('Files')}>
  <header><strong>{t('Files')}</strong><button type="button" onClick={onClose} aria-label={t('Close resources')}><Icon name="x" size={16}/></button></header>
  <div className="hx-files-toolbar">
   {!selected&&<div className="hx-files-view" role="group" aria-label={t('File view')}><button type="button" title={t('Recent')} aria-label={t('Recent')} aria-pressed={!folderMode} onClick={()=>{setFolderMode(false);setCursor(null);setFolderCursor(undefined)}}><Icon name="list" size={16}/></button><button type="button" title={t('Folders')} aria-label={t('Folders')} aria-pressed={folderMode} onClick={()=>{setFolderMode(true);setCursor(null);setFolderCursor(undefined)}}><Icon name="folder" size={16}/></button></div>}
   <WorkspaceFileUpload key={scope} api={api} scope={scope} directory={folderMode?directory:''} onSaved={()=>setRevision(value=>value+1)}/>
  </div>
  {selected?<WorkspaceFileHistory key={`${scope}:${selected.id}`} api={api} file={selected} onBack={()=>setSelected(null)} onChanged={()=>setRevision(value=>value+1)}/>:<>
   {folderMode&&<nav className="hx-files-breadcrumbs" aria-label={t('Folder path')}><button onClick={()=>openDirectory('')}>{t('Files')}</button>{directory.split('/').filter(Boolean).map((name,index,parts)=><React.Fragment key={index}><Icon name="chevron-right" size={12}/><button aria-current={index===parts.length-1?'location':undefined} onClick={()=>openDirectory(parts.slice(0,index+1).join('/')+'/')}>{name}</button></React.Fragment>)}</nav>}
   <label className="hx-files-deleted"><input type="checkbox" checked={includeDeleted} onChange={event=>{setCursor(null);setFolderCursor(undefined);setIncludeDeleted(event.target.checked)}}/>{t('Include deleted files')}</label>
   <form className="hx-files-search" onSubmit={event=>{event.preventDefault();setCursor(null);setFolderCursor(undefined);setSearch(query)}}><Icon name="search" size={15}/><input maxLength={1024} aria-label={t('Search files')} placeholder={t('Search files')} value={query} onChange={event=>setQuery(event.target.value)}/><button type="submit" aria-label={t('Search')}><Icon name="chevron-right" size={15}/></button></form>
   {error?<div className="hx-files-state" role="alert"><p>{error}</p><button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button></div>:files===null?<p className="hx-files-state" role="status">{t('Loading…')}</p>:files.length===0&&folders.length===0?<div className="hx-files-state"><Icon name="file" size={36}/><p>{search?t('No matching files'):t('No files in this room yet')}</p></div>:<div className="hx-files-rows">{folders.map(folder=><button type="button" className="hx-file-folder" key={folder.path} onClick={()=>openDirectory(folder.path)}><Icon name="folder" size={19}/><span>{folder.name}</span><Icon name="chevron-right" size={14}/></button>)}{files.map(file=><button type="button" className="hx-file-row" key={file.id} onClick={()=>setSelected(file)}><Icon name={file.contentType?.startsWith('image/')?'image':'file'} size={19}/><span><b>{file.path.split('/').at(-1)}</b><small>{file.path.includes('/')?`${file.path.slice(0,file.path.lastIndexOf('/'))} · `:''}{file.size??0} B · v{file.version}{file.deleted?` · ${t('Deleted')}`:''}</small></span><Icon name="chevron-right" size={14}/></button>)}</div>}
   {folderMode&&!search&&<div className="hx-files-pagination">{folderCursor&&<button onClick={()=>setFolderCursor(undefined)}>{t('First folders')}</button>}{folderNext&&files!==null&&!error&&<button onClick={()=>setFolderCursor(folderNext)}>{t('More folders')}</button>}</div>}
   <div className="hx-files-pagination">{cursor&&<button onClick={()=>setCursor(null)}>{t('Back to first page')}</button>}{next&&files!==null&&!error&&<button onClick={()=>setCursor(next)}>{t('Next')}</button>}</div>
  </>}
  <footer><button type="button" onClick={onAttachments}><Icon name="paperclip" size={14}/>{t('Message attachments')}</button></footer>
 </aside>
}
function WorkspaceFileHistory({api,file,onBack,onChanged}:{api:WorkspaceFileApi;file:WorkspaceFile;onBack:()=>void;onChanged:()=>void}){
 const replacement=useRef<HTMLInputElement>(null)
 const [preview,setPreview]=useState<FileVersion|null>(null)
 const [before,setBefore]=useState<number|undefined>(undefined)
 const t=useT(),[versions,setVersions]=useState<FileVersion[]|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false)
 useEffect(()=>{let live=true;const controller=new AbortController();setVersions(null);setError('')
  api.versions(file.id,before,controller.signal).then(result=>{if(live)setVersions(result.versions)}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,file.id,revision,before])
 const active=useRef<AbortController|null>(null)
 useEffect(()=>{const controller=new AbortController();active.current=controller;return()=>{controller.abort();active.current=null}},[api,file.id])
 const download=async(version:number)=>{const controller=active.current;if(!controller)return;setBusy(true);setError('');try{const blob=await api.download(file.id,version,controller.signal);if(controller.signal.aborted)return;const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.path.split('/').at(-1)||'file';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error))}finally{if(!controller.signal.aborted)setBusy(false)}}
 const restoring=useRef(false)
 const restore=async(version:FileVersion)=>{
  const controller=active.current;if(!controller||restoring.current)return
  restoring.current=true;setBusy(true);setError('')
  try{await api.restore(file.id,version.version,version.currentVersion)
   if(!controller.signal.aborted){setBefore(undefined);setRevision(value=>value+1);onChanged()}
  }catch(error){if(!controller.signal.aborted)setError(error instanceof WorkspaceFileError&&error.status===409?t('The file changed. Refresh its history before restoring.'):error instanceof Error?error.message:String(error))}
  finally{restoring.current=false;if(!controller.signal.aborted)setBusy(false)}
 }
 const remove=async(version:FileVersion)=>{
  const controller=active.current;if(!controller||restoring.current)return
  restoring.current=true;setBusy(true);setError('')
  try{await api.remove(file.id,version.currentVersion)
   if(!controller.signal.aborted){setBefore(undefined);setRevision(value=>value+1);onChanged()}
  }catch(error){if(!controller.signal.aborted)setError(error instanceof WorkspaceFileError&&error.status===409?t('The file changed. Refresh its history before deleting.'):error instanceof Error?error.message:String(error))}
  finally{restoring.current=false;if(!controller.signal.aborted)setBusy(false)}
 }
 const replace=async(content:File,version:FileVersion)=>{
  const controller=active.current;if(!controller||restoring.current)return
  if(content.size>25*1024*1024){setError(t('Files must be 25 MB or smaller.'));return}
  restoring.current=true;setBusy(true);setError('')
  try{await api.upload(file.id,version.currentVersion,content,controller.signal)
   if(!controller.signal.aborted){setBefore(undefined);setRevision(value=>value+1);onChanged()}
  }catch(error){if(!controller.signal.aborted)setError(error instanceof WorkspaceFileError&&error.status===409?t('The file changed. Refresh its history before uploading a new version.'):error instanceof Error?error.message:String(error))}
  finally{restoring.current=false;if(!controller.signal.aborted)setBusy(false)}
 }
 const current=versions?.find(version=>version.isCurrent)
 return <div className="hx-file-history">{preview&&<WorkspaceFilePreview key={`${file.id}:${preview.version}`} api={api} file={file} version={preview} onClose={()=>setPreview(null)}/>}<button className="hx-files-back" onClick={onBack}><Icon name="chevron-left" size={15}/>{t('Files')}</button><h2>{file.path.split('/').at(-1)}</h2><p className="hx-file-path">{file.path}</p>{current?.kind==='content'&&<><input ref={replacement} hidden type="file" aria-label={t('Choose a new file version')} onChange={event=>{const content=event.target.files?.[0];event.target.value='';if(content)void replace(content,current)}}/><button className="hx-files-replace" disabled={busy} onClick={()=>replacement.current?.click()}><Icon name="upload" size={14}/>{t('Upload new version')}</button></>}{current?.kind==='content'&&<button className="hx-files-remove" disabled={busy} onClick={()=>void remove(current)}><Icon name="trash" size={14}/>{t('Move to deleted files')}</button>}<h3>{t('Version history')}</h3>
  {error&&<div role="alert"><p>{error}</p><button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button></div>}
  {!versions&&!error?<p role="status">{t('Loading…')}</p>:versions?.map(version=><div className="hx-file-version" key={version.version}><span><b>v{version.version}{version.isCurrent?` · ${t('Current version')}`:''}</b><small>{new Date(version.createdAt).toLocaleString()}</small>{version.kind==='deleted'&&<small>{t('Deleted')}</small>}{version.purged&&<small>{t('Permanently deleted')}</small>}</span>{version.kind==='content'&&!version.purged&&<div className="hx-file-version-actions">{workspaceFilePreviewKind(version.contentType||'',file.path)&&<button onClick={()=>setPreview(version)} aria-label={`${t('Preview')} v${version.version}`}>{t('Preview')}</button>}{!version.isCurrent&&<button disabled={busy} onClick={()=>void restore(version)} aria-label={`${t('Restore')} v${version.version}`}>{t('Restore')}</button>}<button disabled={busy} onClick={()=>void download(version.version)} aria-label={`${t('Download')} v${version.version}`}><Icon name="download" size={16}/></button></div>}</div>)}
  <div className="hx-files-pagination">{before!==undefined&&<button onClick={()=>setBefore(undefined)}>{t('Latest versions')}</button>}{versions?.length===50&&versions[versions.length-1].version>1&&<button onClick={()=>setBefore(versions[versions.length-1].version)}>{t('Older versions')}</button>}</div>
 </div>
}
