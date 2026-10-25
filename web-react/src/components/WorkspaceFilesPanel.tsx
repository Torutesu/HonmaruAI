import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import {WorkspaceFileError} from '../utils/workspaceFiles'
import type {WorkspaceFileApi,WorkspaceFile,FileVersion,FileCursor} from '../utils/workspaceFiles'
import './WorkspaceFilesPanel.css'
import {WorkspaceFileUpload} from './WorkspaceFileUpload'

export function RoomFilesPanel({api,channel,onClose,onAttachments}:{api:WorkspaceFileApi;channel:string;onClose:()=>void;onAttachments:()=>void}){
 const t=useT(),[scope,setScope]=useState<string|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0)
 useEffect(()=>{let live=true;const controller=new AbortController();setScope(null);setError('')
  api.resolveScope(channel,controller.signal).then(result=>{if(live)setScope(result.scope)}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,channel,revision])
 if(scope)return <WorkspaceFilesPanel key={scope} api={api} scope={scope} onClose={onClose} onAttachments={onAttachments}/>
 return <aside className="hx-room-resource slk-pane hx-files-panel" aria-label={t('Files')}><header><strong>{t('Files')}</strong><button onClick={onClose} aria-label={t('Close resources')}><Icon name="x" size={16}/></button></header><div className="hx-files-state" role={error?'alert':'status'}>{error||t('Loading…')}{error&&<button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button>}</div><footer><button onClick={onAttachments}>{t('Message attachments')}</button></footer></aside>
}

export function WorkspaceFilesPanel({api,scope,onClose,onAttachments}:{api:WorkspaceFileApi;scope:string;onClose:()=>void;onAttachments:()=>void}){
 const t=useT(),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[revision,setRevision]=useState(0)
 const [files,setFiles]=useState<WorkspaceFile[]|null>(null),[cursor,setCursor]=useState<FileCursor|null>(null),[next,setNext]=useState<FileCursor|null>(null)
 const [includeDeleted,setIncludeDeleted]=useState(false)
 const [error,setError]=useState(''),[selected,setSelected]=useState<WorkspaceFile|null>(null)
 useEffect(()=>{const controller=new AbortController();let live=true;setFiles(null);setError('')
  api.list({scope,includeDeleted,query:search,...(cursor?{cursor}:{})},controller.signal).then(result=>{if(live){setFiles(result.files);setNext(result.next)}}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,scope,search,cursor,revision,includeDeleted])
 useEffect(()=>{setSelected(null);setCursor(null)},[api,scope])
 return <aside className="hx-room-resource slk-pane hx-files-panel" aria-label={t('Files')}>
  <header><strong>{t('Files')}</strong><button type="button" onClick={onClose} aria-label={t('Close resources')}><Icon name="x" size={16}/></button></header>
  {selected?<WorkspaceFileHistory key={`${scope}:${selected.id}`} api={api} file={selected} onBack={()=>setSelected(null)} onChanged={()=>setRevision(value=>value+1)}/>:<>
   <label className="hx-files-deleted"><input type="checkbox" checked={includeDeleted} onChange={event=>{setCursor(null);setIncludeDeleted(event.target.checked)}}/>{t('Include deleted files')}</label>
   <WorkspaceFileUpload key={scope} api={api} scope={scope} onSaved={()=>setRevision(value=>value+1)}/>
   <form className="hx-files-search" onSubmit={event=>{event.preventDefault();setCursor(null);setSearch(query)}}><Icon name="search" size={15}/><input aria-label={t('Search files')} placeholder={t('Search files')} value={query} onChange={event=>setQuery(event.target.value)}/><button type="submit" aria-label={t('Search')}><Icon name="chevron-right" size={15}/></button></form>
   {error?<div className="hx-files-state" role="alert"><p>{error}</p><button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button></div>:files===null?<p className="hx-files-state" role="status">{t('Loading…')}</p>:files.length===0?<div className="hx-files-state"><Icon name="folder" size={24}/><p>{search?t('No matching files'):t('No files in this room yet')}</p></div>:<div className="hx-files-rows">{files.map(file=><button type="button" className="hx-file-row" key={file.id} onClick={()=>setSelected(file)}><Icon name={file.contentType?.startsWith('image/')?'image':'file'} size={19}/><span><b>{file.path.split('/').at(-1)}</b><small>{file.path.includes('/')?`${file.path.slice(0,file.path.lastIndexOf('/'))} · `:''}{file.size??0} B · v{file.version}{file.deleted?` · ${t('Deleted')}`:''}</small></span><Icon name="chevron-right" size={14}/></button>)}</div>}
   <div className="hx-files-pagination">{cursor&&<button onClick={()=>setCursor(null)}>{t('Back to first page')}</button>}{next&&files!==null&&!error&&<button onClick={()=>setCursor(next)}>{t('Next')}</button>}</div>
  </>}
  <footer><button type="button" onClick={onAttachments}><Icon name="paperclip" size={14}/>{t('Message attachments')}</button></footer>
 </aside>
}
function WorkspaceFileHistory({api,file,onBack,onChanged}:{api:WorkspaceFileApi;file:WorkspaceFile;onBack:()=>void;onChanged:()=>void}){
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
 const current=versions?.find(version=>version.isCurrent)
 return <div className="hx-file-history"><button className="hx-files-back" onClick={onBack}><Icon name="chevron-left" size={15}/>{t('Files')}</button><h2>{file.path.split('/').at(-1)}</h2><p className="hx-file-path">{file.path}</p>{current?.kind==='content'&&<button className="hx-files-remove" disabled={busy} onClick={()=>void remove(current)}><Icon name="trash" size={14}/>{t('Move to deleted files')}</button>}<h3>{t('Version history')}</h3>
  {error&&<div role="alert"><p>{error}</p><button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button></div>}
  {!versions&&!error?<p role="status">{t('Loading…')}</p>:versions?.map(version=><div className="hx-file-version" key={version.version}><span><b>v{version.version}{version.isCurrent?` · ${t('Current')}`:''}</b><small>{new Date(version.createdAt).toLocaleString()}</small>{version.kind==='deleted'&&<small>{t('Deleted')}</small>}{version.purged&&<small>{t('Permanently deleted')}</small>}</span>{version.kind==='content'&&!version.purged&&<div className="hx-file-version-actions">{!version.isCurrent&&<button disabled={busy} onClick={()=>void restore(version)} aria-label={`${t('Restore')} v${version.version}`}>{t('Restore')}</button>}<button disabled={busy} onClick={()=>void download(version.version)} aria-label={`${t('Download')} v${version.version}`}><Icon name="download" size={16}/></button></div>}</div>)}
  <div className="hx-files-pagination">{before!==undefined&&<button onClick={()=>setBefore(undefined)}>{t('Latest versions')}</button>}{versions?.length===50&&versions[versions.length-1].version>1&&<button onClick={()=>setBefore(versions[versions.length-1].version)}>{t('Older versions')}</button>}</div>
 </div>
}
