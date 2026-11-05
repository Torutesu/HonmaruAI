import {DocumentCreate} from './DocumentCreate'
import {FileConversationButton} from './FileConversationButton'
import {subscribeWorkspaceFileRefresh} from '../utils/workspaceFileRefresh'
import {readWorkspaceFileView,saveWorkspaceFileView} from '../utils/workspaceFileView'
import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import {WorkspaceFileError} from '../utils/workspaceFiles'
import type {WorkspaceFileApi,WorkspaceFile,FileVersion,FileCursor,FileOrigin,FileSearch,PublicFileShareRequest,ExternalFileGrant,ExternalFileInvite} from '../utils/workspaceFiles'
import './WorkspaceFilesPanel.css'
import {WorkspaceFilePreview} from './WorkspaceFilePreview'
import {workspaceFilePreviewKind} from '../utils/workspaceFilePreview'
import {WorkspaceFileUpload} from './WorkspaceFileUpload'
import {FilePublicUrlControls} from './FilePublicUrlControls'

export function RoomFilesPanel({api,channel,targetFileId,inlinePreview=false,preferenceKey,allOriginsInFolders=false,enablePublicMediaUrls=false,onClose,onAttachments}:{api:WorkspaceFileApi;channel:string;targetFileId?:string;inlinePreview?:boolean;preferenceKey?:string;allOriginsInFolders?:boolean;enablePublicMediaUrls?:boolean;onClose:()=>void;onAttachments:()=>void}){
 const t=useT(),[scope,setScope]=useState<string|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0)
 useEffect(()=>{let live=true;const controller=new AbortController();setScope(null);setError('')
  api.resolveScope(channel,controller.signal).then(result=>{if(live)setScope(result.scope)}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,channel,revision])
 if(scope)return <WorkspaceFilesPanel key={`${scope}:${preferenceKey}`} api={api} scope={scope} targetFileId={targetFileId} inlinePreview={inlinePreview} preferenceKey={preferenceKey} allOriginsInFolders={allOriginsInFolders} enablePublicMediaUrls={enablePublicMediaUrls} onClose={onClose} onAttachments={onAttachments}/>
 return <aside className="hx-room-resource slk-pane hx-files-panel" aria-label={t('Files')}><header><strong>{t('Files')}</strong><button onClick={onClose} aria-label={t('Close resources')}><Icon name="x" size={16}/></button></header><div className="hx-files-state" role={error?'alert':'status'}>{error||t('Loading…')}{error&&<button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button>}</div><footer><button onClick={onAttachments}>{t('Message attachments')}</button></footer></aside>
}

export function WorkspaceFilesPanel({api,scope,targetFileId,inlinePreview=false,preferenceKey,allOriginsInFolders=false,enablePublicMediaUrls=false,onClose,onAttachments}:{api:WorkspaceFileApi;scope:string;targetFileId?:string;inlinePreview?:boolean;preferenceKey?:string;allOriginsInFolders?:boolean;enablePublicMediaUrls?:boolean;onClose:()=>void;onAttachments:()=>void}){
 const [saved]=useState(()=>readWorkspaceFileView(preferenceKey))
 const [showShares,setShowShares]=useState(false)
 const t=useT(),[query,setQuery]=useState(saved.search),[search,setSearch]=useState(saved.search),[revision,setRevision]=useState(0)
 const [files,setFiles]=useState<WorkspaceFile[]|null>(null),[cursor,setCursor]=useState<FileCursor|null>(null),[next,setNext]=useState<FileCursor|null>(null)
 const [includeDeleted,setIncludeDeleted]=useState(saved.includeDeleted)
 const [type,setType]=useState<FileSearch['type']>(saved.type)
 const [origin,setOrigin]=useState<'all'|FileOrigin>(saved.origin??'all')
 const [folderMode,setFolderMode]=useState(saved.folderMode),[directory,setDirectory]=useState(saved.directory)
 const effectiveOrigin=folderMode&&allOriginsInFolders?'all':origin
 const [folders,setFolders]=useState<{name:string;path:string}[]>([]),[folderCursor,setFolderCursor]=useState<string|undefined>(),[folderNext,setFolderNext]=useState<string|null>(null)
 const [error,setError]=useState(''),[selected,setSelected]=useState<WorkspaceFile|null>(null)
 const previousFolderPolicy=useRef(allOriginsInFolders)
 const policyChanged=previousFolderPolicy.current!==allOriginsInFolders
 const visibleCursor=policyChanged?null:cursor,visibleFolderCursor=policyChanged?undefined:folderCursor
 useEffect(()=>{if(previousFolderPolicy.current!==allOriginsInFolders){previousFolderPolicy.current=allOriginsInFolders;setCursor(null);setFolderCursor(undefined)}},[allOriginsInFolders])
 useEffect(()=>{const controller=new AbortController();let live=true;setFiles(null);setError('')
  Promise.all([
   api.list({scope,...(type?{type}:{}),...(effectiveOrigin!=='all'?{origin:effectiveOrigin}:{}),includeDeleted,query:search,order:folderMode?'path':'recent',...(folderMode?{directory,directOnly:!search}:{}),...(visibleCursor?{cursor:visibleCursor}:{})},controller.signal),
   folderMode&&!search?api.folders(scope,directory,includeDeleted,visibleFolderCursor,controller.signal,effectiveOrigin==='all'?undefined:effectiveOrigin):Promise.resolve({folders:[],next:null})
  ]).then(([result,tree])=>{if(live){setFiles(result.files);setNext(result.next);setFolders(tree.folders);setFolderNext(tree.next)}}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,scope,search,visibleCursor,revision,includeDeleted,folderMode,directory,visibleFolderCursor,effectiveOrigin,type])
 useEffect(()=>{setSelected(null);setCursor(null);setFolderCursor(undefined)},[api,scope])
 useEffect(()=>saveWorkspaceFileView(preferenceKey,{folderMode,directory,search,includeDeleted,origin,type}),[preferenceKey,folderMode,directory,search,includeDeleted,origin,type])
 useEffect(()=>subscribeWorkspaceFileRefresh(()=>setRevision(value=>value+1)),[api,scope])
 const [targetState,setTargetState]=useState<'loading'|'unavailable'|'error'|''>(''),[targetAttempt,setTargetAttempt]=useState(0)
 useEffect(()=>{
  let live=true;const controller=new AbortController();setSelected(null);setTargetState(targetFileId?'loading':'')
  if(targetFileId)void api.get(targetFileId,controller.signal).then(({file})=>{
   if(!live)return
   if(file.id!==targetFileId||file.scope!==scope){setTargetState('unavailable');return}
   setSelected(file);setTargetState('')
  }).catch(error=>{if(live)setTargetState(error instanceof WorkspaceFileError&&[403,404].includes(error.status)?'unavailable':'error')})
  return()=>{live=false;controller.abort()}
 },[api,scope,targetFileId,targetAttempt])
 const openDirectory=(path:string)=>{setDirectory(path);setCursor(null);setFolderCursor(undefined);setQuery('');setSearch('')}
 return <aside className="hx-room-resource slk-pane hx-files-panel" aria-label={t('Files')}>
  <header><strong>{t('Files')}</strong><button type="button" onClick={onClose} aria-label={t('Close resources')}><Icon name="x" size={16}/></button></header>
  {targetState&&<div className="hx-files-state" role={targetState==='loading'?'status':'alert'}><p>{t(targetState==='loading'?'Opening linked file…':targetState==='unavailable'?'This file is unavailable or you no longer have access.':'Could not open this file. Try again.')}</p>{targetState!=='loading'&&<button onClick={()=>setTargetAttempt(value=>value+1)}>{t('Try again')}</button>}</div>}
  <div className="hx-files-toolbar">
   {!selected&&(!folderMode||!allOriginsInFolders)&&<div className="hx-files-origin" role="group" aria-label={t('File source')}>
    {(['agent','human'] as const).map(source=><button type="button" key={source} aria-label={t(source==='agent'?'Created by agents':'Uploaded by users')} title={t(source==='agent'?'Created by agents':'Uploaded by users')} aria-pressed={origin===source} onClick={()=>{setOrigin(source);setCursor(null);setFolderCursor(undefined)}}>{t(source==='agent'?'Agents':'Users')}</button>)}
    <label className={`hx-files-origin-more${origin==='all'||origin==='unknown'?' selected':''}`} title={t(origin==='all'?'All files':origin==='unknown'?'Unknown file source':'File source')}><Icon name="more" size={14}/><select aria-label={t('File source')} value={origin} onChange={event=>{setOrigin(event.target.value as 'all'|FileOrigin);setCursor(null);setFolderCursor(undefined)}}><option value="all">{t('All files')}</option><option value="agent">{t('Created by agents')}</option><option value="human">{t('Uploaded by users')}</option><option value="unknown">{t('Unknown file source')}</option></select></label>
   </div>}

   {!selected&&<div className="hx-files-view" role="group" aria-label={t('File view')}><button type="button" title={t('Recent')} aria-label={t('Recent')} aria-pressed={!folderMode} onClick={()=>{setFolderMode(false);setCursor(null);setFolderCursor(undefined)}}><Icon name="list" size={16}/></button><button type="button" title={t('Folders')} aria-label={t('Folders')} aria-pressed={folderMode} onClick={()=>{setFolderMode(true);setCursor(null);setFolderCursor(undefined)}}><Icon name="folder" size={16}/></button></div>}
   <DocumentCreate key={`document:${scope}`} api={api} scope={scope} receiptKey={preferenceKey?`${preferenceKey}:${scope}`:undefined} directory={folderMode?directory:''} onOpen={id=>{setRevision(v=>v+1);void api.get(id).then(r=>setSelected(r.file)).catch(e=>setError(e.message))}}/>
   <WorkspaceFileUpload key={scope} api={api} scope={scope} directory={folderMode?directory:''} onSaved={()=>setRevision(value=>value+1)}/>
   {api.shareRequests&&<button type="button" className="hx-files-share-open" onClick={()=>setShowShares(true)}><Icon name="share" size={15}/>{t('Public link approvals')}</button>}
  </div>
  {showShares?<WorkspaceFileShareQueue api={api} onClose={()=>setShowShares(false)}/>:selected?<WorkspaceFileHistory key={`${scope}:${selected.id}`} api={api} file={selected} inlinePreview={inlinePreview} refreshRevision={revision} onBack={()=>setSelected(null)} onChanged={()=>setRevision(value=>value+1)}/>:<>
   {folderMode&&<nav className="hx-files-breadcrumbs" aria-label={t('Folder path')}><button onClick={()=>openDirectory('')}>{t('All files')}</button>{directory.split('/').filter(Boolean).map((name,index,parts)=><React.Fragment key={index}><Icon name="chevron-right" size={12}/><button aria-current={index===parts.length-1?'location':undefined} onClick={()=>openDirectory(parts.slice(0,index+1).join('/')+'/')}>{name}</button></React.Fragment>)}</nav>}
   <label className="hx-files-deleted"><input type="checkbox" checked={includeDeleted} onChange={event=>{setCursor(null);setFolderCursor(undefined);setIncludeDeleted(event.target.checked)}}/>{t('Include deleted files')}</label>
   <form className="hx-files-search" onSubmit={event=>{event.preventDefault();setCursor(null);setFolderCursor(undefined);setSearch(query)}}><Icon name="search" size={15}/><input maxLength={1024} aria-label={t('Search files')} placeholder={t('Search files')} value={query} onChange={event=>setQuery(event.target.value)}/><button type="submit" aria-label={t('Search')}><Icon name="chevron-right" size={15}/></button></form>
   <label className="hx-files-type">{t('File type')}<select aria-label={t('File type')} value={type??''} onChange={event=>{setType((event.target.value||undefined) as FileSearch['type']);setCursor(null);setFolderCursor(undefined)}}>{[['','All types'],['image','Images'],['video','Videos'],['media','Images and videos'],['pdf','PDF'],['doc','Documents'],['html','HTML']].map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select></label>
   {error?<div className="hx-files-state" role="alert"><p>{error}</p><button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button></div>:files===null?<p className="hx-files-state" role="status">{t('Loading…')}</p>:files.length===0&&folders.length===0?<div className="hx-files-state"><Icon name={folderMode?"folder":"file"} size={36}/><p>{search||type?t('No matching files'):folderMode&&effectiveOrigin==='all'?t('This folder is empty'):t(origin==='agent'?'No agent-created files in this room':origin==='human'?'No user-uploaded files in this room':origin==='unknown'?'No files with unknown source in this room':'No files in this room yet')}</p></div>:<div className="hx-files-rows">{folders.map(folder=><button type="button" className="hx-file-folder" key={folder.path} onClick={()=>openDirectory(folder.path)}><Icon name="folder" size={19}/><span>{folder.name}</span><Icon name="chevron-right" size={14}/></button>)}{files.map(file=><button type="button" className="hx-file-row" key={file.id} onClick={()=>setSelected(file)}><Icon name={file.contentType?.startsWith('image/')?'image':'file'} size={19}/><span><b>{file.path.split('/').at(-1)}</b><small>{file.path.includes('/')?`${file.path.slice(0,file.path.lastIndexOf('/'))} · `:''}{file.size??0} B · v{file.version}{file.deleted?` · ${t('Deleted')}`:''}</small></span><Icon name="chevron-right" size={14}/></button>)}</div>}
   {folderMode&&!search&&<div className="hx-files-pagination">{folderCursor&&<button onClick={()=>setFolderCursor(undefined)}>{t('First folders')}</button>}{folderNext&&files!==null&&!error&&<button onClick={()=>setFolderCursor(folderNext)}>{t('More folders')}</button>}</div>}
   <div className="hx-files-pagination">{cursor&&<button onClick={()=>setCursor(null)}>{t('Back to first page')}</button>}{next&&files!==null&&!error&&<button onClick={()=>setCursor(next)}>{t('Next')}</button>}</div>
  </>}
  <footer><button type="button" onClick={onAttachments}><Icon name="paperclip" size={14}/>{t('Message attachments')}</button></footer>
 </aside>
}
function WorkspaceFileHistory({api,file,inlinePreview,refreshRevision,onBack,onChanged}:{api:WorkspaceFileApi;file:WorkspaceFile;inlinePreview:boolean;refreshRevision:number;onBack:()=>void;onChanged:()=>void}){
 const replacement=useRef<HTMLInputElement>(null)
 const [preview,setPreview]=useState<FileVersion|null>(null)
 const [before,setBefore]=useState<number|undefined>(undefined)
 const t=useT(),[versions,setVersions]=useState<FileVersion[]|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false)
 useEffect(()=>{let live=true;const controller=new AbortController();setVersions(null);setError('')
  api.versions(file.id,before,controller.signal).then(result=>{if(live)setVersions(result.versions)}).catch(error=>{if(live)setError(String(error.message||error))})
  return()=>{live=false;controller.abort()}
 },[api,file.id,revision,before,refreshRevision])
 const active=useRef<AbortController|null>(null)
 useEffect(()=>{const controller=new AbortController();active.current=controller;return()=>{controller.abort();active.current=null}},[api,file.id])
 const download=async(version:number)=>{const controller=active.current;if(!controller)return;setBusy(true);setError('');try{const blob=await api.download(file.id,version,controller.signal);if(controller.signal.aborted)return;const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.path.split('/').at(-1)||'file';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error))}finally{if(!controller.signal.aborted)setBusy(false)}}
 const restoring=useRef(false)
 const restore=async(version:FileVersion)=>{
  const controller=active.current;if(!controller||restoring.current)return
  restoring.current=true;setBusy(true);setError('')
  try{await api.restore(file.id,version.version,version.currentVersion)
   if(!controller.signal.aborted){setBefore(undefined);onChanged()}
  }catch(error){if(!controller.signal.aborted)setError(error instanceof WorkspaceFileError&&error.status===409?t('The file changed. Refresh its history before restoring.'):error instanceof Error?error.message:String(error))}
  finally{restoring.current=false;if(!controller.signal.aborted)setBusy(false)}
 }
 const remove=async(version:FileVersion)=>{
  const controller=active.current;if(!controller||restoring.current)return
  restoring.current=true;setBusy(true);setError('')
  try{await api.remove(file.id,version.currentVersion)
   if(!controller.signal.aborted){setBefore(undefined);onChanged()}
  }catch(error){if(!controller.signal.aborted)setError(error instanceof WorkspaceFileError&&error.status===409?t('The file changed. Refresh its history before deleting.'):error instanceof Error?error.message:String(error))}
  finally{restoring.current=false;if(!controller.signal.aborted)setBusy(false)}
 }
 const replace=async(content:File,version:FileVersion)=>{
  const controller=active.current;if(!controller||restoring.current)return
  if(content.size>25*1024*1024){setError(t('Files must be 25 MB or smaller.'));return}
  restoring.current=true;setBusy(true);setError('')
  try{await api.upload(file.id,version.currentVersion,content,controller.signal)
   if(!controller.signal.aborted){setBefore(undefined);onChanged()}
  }catch(error){if(!controller.signal.aborted)setError(error instanceof WorkspaceFileError&&error.status===409?t('The file changed. Refresh its history before uploading a new version.'):error instanceof Error?error.message:String(error))}
  finally{restoring.current=false;if(!controller.signal.aborted)setBusy(false)}
 }
 const current=versions?.find(version=>version.isCurrent)
 const [external,setExternal]=useState<{canManage:boolean;grants:ExternalFileGrant[];invites:ExternalFileInvite[]}|null>(null)
 const [externalEmail,setExternalEmail]=useState(''),[externalPermission,setExternalPermission]=useState<'view'|'edit'>('view'),[externalExpiry,setExternalExpiry]=useState(7),[inviteEmail,setInviteEmail]=useState(''),[invitePermission,setInvitePermission]=useState<'view'|'edit'>('view'),[inviteExpiry,setInviteExpiry]=useState(7),[inviteAccessExpiry,setInviteAccessExpiry]=useState(7),[inviteUrl,setInviteUrl]=useState(''),[externalBusy,setExternalBusy]=useState(false),[externalMessage,setExternalMessage]=useState(''),[redemptionUrl,setRedemptionUrl]=useState('')
 useEffect(()=>{if(!api.externalGrants){setExternal(null);return}let live=true;const controller=new AbortController();Promise.all([api.externalGrants(file.id,controller.signal),api.externalInvites?.(file.id,controller.signal)??Promise.resolve({canManage:false,invites:[]})]).then(([grants,invites])=>{if(live)setExternal({canManage:grants.canManage||invites.canManage,grants:grants.grants,invites:invites.invites})}).catch(()=>{if(live)setExternal({canManage:false,grants:[],invites:[]})});return()=>{live=false;controller.abort()}},[api,file.id,refreshRevision,revision])
 const createExternalGrant=async(event:React.FormEvent)=>{event.preventDefault();if(!api.grantExternal||externalBusy)return;setExternalBusy(true);setExternalMessage('');try{const result=await api.grantExternal(file.id,externalEmail,externalPermission,externalExpiry);setExternalEmail('');setRedemptionUrl(api.externalLink?.(file.id)||result.redemptionPath);setExternalMessage(t('Access granted. No email was sent. Share the sign-in link with the recipient.'));const grants=await api.externalGrants?.(file.id);if(grants)setExternal(current=>({...current,...grants,invites:current?.invites||[]}))}catch(error){setExternalMessage(error instanceof Error?error.message:t('Could not share this file.'))}finally{setExternalBusy(false)}}
 const createExternalInvite=async(event:React.FormEvent)=>{event.preventDefault();if(!api.inviteExternal||externalBusy)return;setExternalBusy(true);setExternalMessage('');setInviteUrl('');try{const result=await api.inviteExternal(file.id,inviteEmail,invitePermission,inviteAccessExpiry,inviteExpiry);setInviteEmail('');setInviteUrl(result.invite.inviteUrl);const delivery=result.invite.emailDelivery?.status;setExternalMessage(t(delivery==='sent'?'Invitation email sent. You can also share the link.':delivery==='failed'?'Email could not be delivered. Share the link manually.':'Invitation link created. Share it with the recipient; email delivery is not configured.'));const [grants,invites]=await Promise.all([api.externalGrants?.(file.id),api.externalInvites?.(file.id)]);if(grants&&invites)setExternal({...grants,invites:invites.invites})}catch(error){setExternalMessage(error instanceof Error?error.message:t('Could not create the invitation.'))}finally{setExternalBusy(false)}}
 const revokeExternalInvite=async(inviteId:string)=>{if(!api.revokeExternalInvite||externalBusy)return;setExternalBusy(true);setExternalMessage('');try{await api.revokeExternalInvite(file.id,inviteId);const [grants,invites]=await Promise.all([api.externalGrants?.(file.id),api.externalInvites?.(file.id)]);if(grants&&invites)setExternal({...grants,invites:invites.invites})}catch(error){setExternalMessage(error instanceof Error?error.message:t('Could not revoke access.'))}finally{setExternalBusy(false)}}
 const revokeExternalGrant=async(recipientId:string)=>{if(!api.revokeExternal||externalBusy)return;setExternalBusy(true);setExternalMessage('');try{await api.revokeExternal(file.id,recipientId);setRedemptionUrl('');const grants=await api.externalGrants?.(file.id);if(grants)setExternal(current=>({...current,...grants,invites:current?.invites||[]}))}catch(error){setExternalMessage(error instanceof Error?error.message:t('Could not revoke access.'))}finally{setExternalBusy(false)}}
 const [shareExpiry,setShareExpiry]=useState(604800),[shareDownload,setShareDownload]=useState(false),[shareBusy,setShareBusy]=useState(false),[shareMessage,setShareMessage]=useState('')
 const requestShare=async()=>{
  if(!current||!api.requestPublicShare||shareBusy)return
  setShareBusy(true);setShareMessage('')
  try{await api.requestPublicShare(file.id,current.version,shareExpiry,shareDownload);setShareMessage(t('Approval request submitted. Review it under Public link approvals.'));onChanged()}
  catch(error){setShareMessage(error instanceof Error?error.message:t('Could not request approval.'))}
  finally{setShareBusy(false)}
 }
 return <div className="hx-file-history">{preview&&<WorkspaceFilePreview key={`${file.id}:${preview.version}`} api={api} file={file} version={preview} inline={inlinePreview} onClose={()=>setPreview(null)}/>}<button className="hx-files-back" onClick={onBack}><Icon name="chevron-left" size={15}/>{t('Files')}</button><h2>{file.path.split('/').at(-1)}</h2><p className="hx-file-path">{file.path}</p>{current?.kind==='content'&&file.scope!=='workspace'&&<FileConversationButton fileId={file.id}/>}{current?.kind==='content'&&<><input ref={replacement} hidden type="file" aria-label={t('Choose a new file version')} onChange={event=>{const content=event.target.files?.[0];event.target.value='';if(content)void replace(content,current)}}/><button className="hx-files-replace" disabled={busy} onClick={()=>replacement.current?.click()}><Icon name="upload" size={14}/>{t('Upload new version')}</button></>}{current?.kind==='content'&&<button className="hx-files-remove" disabled={busy} onClick={()=>void remove(current)}><Icon name="trash" size={14}/>{t('Move to deleted files')}</button>}<h3>{t('Version history')}</h3>
  {current?.kind==='content'&&!file.deleted&&api.requestPublicShare&&<section className="hx-file-share-request" aria-label={t('Public link approvals')}><p>{t('Only the current version is shared. Any file change invalidates its public link.')}</p><label>{t('Link expires')}<select value={shareExpiry} onChange={event=>setShareExpiry(Number(event.target.value))}><option value={86400}>{t('1 day')}</option><option value={604800}>{t('7 days')}</option><option value={2592000}>{t('30 days')}</option></select></label><label className="hx-file-share-download"><input type="checkbox" checked={shareDownload} onChange={event=>setShareDownload(event.target.checked)}/>{t('Allow downloads')}</label><button type="button" disabled={shareBusy} onClick={()=>void requestShare()}>{shareBusy?t('Submitting…'):t('Request approval')}</button>{shareMessage&&<p role="status">{shareMessage}</p>}</section>}
  {current?.kind==='content'&&!file.deleted&&external?.canManage&&api.grantExternal&&<section className="hx-file-external-grants" aria-label={t('External collaborators')}>
   <h3>{t('Share with an external collaborator')}</h3><p>{t('Only an existing Honmaru account with a verified email can open this file. No invitation email is sent. Choose view or edit access; it expires or can be revoked.')}</p>
   <form onSubmit={event=>void createExternalGrant(event)}><label>{t('Verified email')}<input type="email" required maxLength={254} value={externalEmail} onChange={event=>setExternalEmail(event.target.value)} autoComplete="off"/></label><label>{t('Permission')}<select value={externalPermission} onChange={event=>setExternalPermission(event.target.value as 'view'|'edit')}><option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option></select></label><label>{t('Access expires')}<select value={externalExpiry} onChange={event=>setExternalExpiry(Number(event.target.value))}><option value={1}>{t('1 day')}</option><option value={7}>{t('7 days')}</option><option value={30}>{t('30 days')}</option><option value={90}>{t('90 days')}</option><option value={0}>{t('Never')}</option></select></label><button type="submit" disabled={externalBusy||!externalEmail.trim()}>{externalBusy?t('Sharing…'):externalPermission==='edit'?t('Grant edit access'):t('Grant view access')}</button></form>
   {redemptionUrl&&<div className="hx-file-external-link"><p>{t('Share this sign-in link with the recipient:')}</p><a href={redemptionUrl}>{redemptionUrl}</a><button type="button" onClick={()=>void navigator.clipboard?.writeText(redemptionUrl)}>{t('Copy link')}</button></div>}
   {api.inviteExternal&&<div className="hx-file-external-invites"><h4>{t('Invite an email address')}</h4><p>{t('Anyone can receive this link, but only the verified invited email can redeem it. An email is sent when delivery is configured.')}</p><form onSubmit={event=>void createExternalInvite(event)}><label>{t('Invited email')}<input type="email" required maxLength={254} value={inviteEmail} onChange={event=>setInviteEmail(event.target.value)} autoComplete="off"/></label><label>{t('Permission')}<select value={invitePermission} onChange={event=>setInvitePermission(event.target.value as 'view'|'edit')}><option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option></select></label><label>{t('Invitation expires')}<select value={inviteExpiry} onChange={event=>setInviteExpiry(Number(event.target.value))}><option value={1}>{t('1 day')}</option><option value={7}>{t('7 days')}</option><option value={30}>{t('30 days')}</option></select></label><label>{t('Access expires')}<select value={inviteAccessExpiry} onChange={event=>setInviteAccessExpiry(Number(event.target.value))}><option value={1}>{t('1 day')}</option><option value={7}>{t('7 days')}</option><option value={30}>{t('30 days')}</option><option value={90}>{t('90 days')}</option><option value={0}>{t('Never')}</option></select></label><button type="submit" disabled={externalBusy||!inviteEmail.trim()}>{externalBusy?t('Creating…'):t('Create invitation link')}</button></form>{inviteUrl&&<div className="hx-file-external-link"><p>{t('Share this invitation link:')}</p><a href={inviteUrl}>{inviteUrl}</a><button type="button" onClick={()=>void navigator.clipboard?.writeText(inviteUrl)}>{t('Copy link')}</button></div>}{external.invites.length>0&&<div className="hx-file-external-list"><strong>{t('File invitations')}</strong>{external.invites.map(invite=><div key={invite.id}><span>{invite.invitedEmail} · {invite.redeemedAt?t('Redeemed'):new Date(invite.expiresAt).toLocaleString()}{invite.revokedAt?' · '+t('Revoked'):''}</span>{!invite.revokedAt&&<button type="button" disabled={externalBusy} onClick={()=>void revokeExternalInvite(invite.id)}>{t('Revoke')}</button>}</div>)}</div>}</div>}
   {external.grants.length>0&&<div className="hx-file-external-list"><strong>{t('External access')}</strong>{external.grants.map(grant=><div key={grant.id}><span>{grant.recipientLogin} · {grant.recipientEmail} · {grant.permission}{grant.expiresAt?` · ${t('Expires')} ${new Date(grant.expiresAt).toLocaleString()}`:` · ${t('No expiry')}`}{grant.revokedAt?` · ${t('Revoked')}`:''}</span>{!grant.revokedAt&&<button type="button" disabled={externalBusy} onClick={()=>void revokeExternalGrant(grant.recipientGithubId)}>{t('Revoke')}</button>}</div>)}</div>}
   {externalMessage&&<p role="status">{externalMessage}</p>}
  </section>}
  {error&&<div role="alert"><p>{error}</p><button onClick={()=>setRevision(value=>value+1)}>{t('Retry')}</button></div>}
  {current&&enablePublicMediaUrls&&<FilePublicUrlControls api={api} file={file} current={current} enabled/>}
  {!versions&&!error?<p role="status">{t('Loading…')}</p>:versions?.map(version=><div className="hx-file-version" key={version.version}><span><b>v{version.version}{version.isCurrent?` · ${t('Current version')}`:''}</b><small>{new Date(version.createdAt).toLocaleString()}</small>{version.kind==='deleted'&&<small>{t('Deleted')}</small>}{version.purged&&<small>{t('Permanently deleted')}</small>}</span>{version.kind==='content'&&!version.purged&&<div className="hx-file-version-actions">{workspaceFilePreviewKind(version.contentType||'',file.path)&&<button onClick={()=>setPreview(version)} aria-label={`${t('Preview')} v${version.version}`}>{t('Preview')}</button>}{!version.isCurrent&&<button disabled={busy} onClick={()=>void restore(version)} aria-label={`${t('Restore')} v${version.version}`}>{t('Restore')}</button>}<button disabled={busy} onClick={()=>void download(version.version)} aria-label={`${t('Download')} v${version.version}`}><Icon name="download" size={16}/></button></div>}</div>)}
  <div className="hx-files-pagination">{before!==undefined&&<button onClick={()=>setBefore(undefined)}>{t('Latest versions')}</button>}{versions?.length===50&&versions[versions.length-1].version>1&&<button onClick={()=>setBefore(versions[versions.length-1].version)}>{t('Older versions')}</button>}</div>
 </div>
}

function WorkspaceFileShareQueue({api,onClose}:{api:WorkspaceFileApi;onClose:()=>void}){
 const t=useT(),[requests,setRequests]=useState<PublicFileShareRequest[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[revealed,setRevealed]=useState<Record<string,string>>({})
 const refresh=async()=>{if(!api.shareRequests)return;try{const result=await api.shareRequests();setRequests(result.requests);setError('')}catch(error){setError(error instanceof Error?error.message:String(error))}}
 useEffect(()=>{void refresh()},[api])
 const approve=async(request:PublicFileShareRequest)=>{
  setBusy(request.id);setError('')
  if(!api.approvePublicShare){setError(t('Approval action is unavailable.'));setBusy('');return}
  try{const result=await api.approvePublicShare(request.id);setRevealed(value=>({...value,[result.shareId]:new URL(result.url,typeof window==='undefined'?'https://localhost':window.location.origin).toString()}));await refresh()}
  catch(error){setError(error instanceof Error?error.message:String(error))}
  finally{setBusy('')}
 }
 const decline=async(request:PublicFileShareRequest)=>{
  setBusy(request.id);setError('')
  if(!api.declinePublicShare){setError(t('Decline action is unavailable.'));setBusy('');return}
  try{await api.declinePublicShare(request.id);setRevealed(value=>{const next={...value};if(request.shareId)delete next[request.shareId];return next});await refresh()}
  catch(error){setError(error instanceof Error?error.message:String(error))}
  finally{setBusy('')}
 }
 const revoke=async(shareId:string)=>{
  setBusy(shareId);setError('')
  if(!api.revokePublicShare){setError(t('Revoke action is unavailable.'));setBusy('');return}
  try{await api.revokePublicShare(shareId);setRevealed(value=>{const next={...value};delete next[shareId];return next});await refresh()}
  catch(error){setError(error instanceof Error?error.message:String(error))}
  finally{setBusy('')}
 }
 const expired=(value:string)=>Date.parse(value)<=Date.now()
 return <section className="hx-file-share-queue" aria-label={t('Public link approvals')}>
  <header><button type="button" onClick={onClose}><Icon name="chevron-left" size={15}/>{t('Files')}</button><strong>{t('Public link approvals')}</strong></header>
  {error&&<p className="hx-file-share-error" role="alert">{error}</p>}
  {requests===null&&!error?<p className="hx-files-state" role="status">{t('Loading…')}</p>:requests?.length===0?<p className="hx-files-state">{t('No public link requests.')}</p>:requests?.map(request=>{
   const isExpired=expired(request.expiresAt),changed=request.currentVersion!==request.version,active=request.status==='approved'&&!request.revokedAt&&!isExpired&&!changed
   const revealedUrl=request.shareId?revealed[request.shareId]:undefined
   return <article className="hx-file-share-item" key={request.id}>
    <div className="hx-file-share-title"><Icon name="file" size={16}/><div><strong>{request.filePath}</strong><small>{request.scope} · v{request.version} · {t('Requested by')} {request.requesterLogin}</small></div></div>
    <dl><div><dt>{t('Content snapshot')}</dt><dd><code>{request.contentHash.slice(0,12)}…</code> · {request.size.toLocaleString()} B · {request.contentType}</dd></div><div><dt>{t('Expiry')}</dt><dd>{new Date(request.expiresAt).toLocaleString()}</dd></div><div><dt>{t('Access')}</dt><dd>{request.allowDownload?t('Download allowed'):t('View only')}</dd></div></dl>
    {request.status==='pending'&&!isExpired&&!changed?<button type="button" disabled={Boolean(busy)} onClick={()=>void approve(request)}>{busy===request.id?t('Approving…'):t('Approve and create link')}</button>:null}
    {request.status==='pending'&&!isExpired&&!changed?<button type="button" disabled={Boolean(busy)} onClick={()=>void decline(request)}>{busy===request.id?t('Declining…'):t('Decline request')}</button>:null}
    {active&&<div className="hx-file-share-active"><p>{t('Public snapshot link is active. Revoke it to stop access.')}</p>{revealedUrl?<><a href={revealedUrl} target="_blank" rel="noreferrer">{t('Open public link')}</a><button type="button" onClick={()=>{if(typeof navigator!=='undefined')void navigator.clipboard?.writeText(revealedUrl)}}>{t('Copy link')}</button></>:<p>{t('The link is shown only immediately after approval. It cannot be recovered here.')}</p>}<button type="button" className="hx-file-share-revoke" disabled={Boolean(busy)} onClick={()=>request.shareId&&void revoke(request.shareId)}>{busy===request.shareId?t('Revoking…'):t('Revoke link')}</button></div>}
    {!active&&request.status==='approved'&&changed&&!request.revokedAt&&<p className="hx-file-share-state">{t('File changed. A new approval request is required.')}</p>}
    {!active&&request.status==='approved'&&(!changed||request.revokedAt)&&<p className="hx-file-share-state">{request.revokedAt?t('Revoked'):t('Expired')}</p>}
    {request.status==='pending'&&isExpired&&<p className="hx-file-share-state">{t('Expired')}</p>}
    {request.status==='pending'&&!isExpired&&changed&&<p className="hx-file-share-state">{t('File changed. A new approval request is required.')}</p>}
    {request.status==='stale'&&<p className="hx-file-share-state">{t('File changed. A new approval request is required.')}</p>}
    {request.status==='declined'&&<p className="hx-file-share-state">{t('Declined')}</p>}
   </article>
  })}
 </section>
}
