import React,{useEffect,useState} from 'react'
import {publicMediaType} from '../../../packages/core/src/publicMediaType'
import {useT} from '../utils/i18n'
import type {WorkspaceFileApi,WorkspaceFile,FileVersion,FilePublicUrlState} from '../utils/workspaceFiles'

export function FilePublicUrlControls({api,file,current,enabled}:{api:WorkspaceFileApi;file:WorkspaceFile;current:FileVersion;enabled:boolean}){
 const t=useT(),[state,setState]=useState<FilePublicUrlState|null>(null),[url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0)
 const contentType=publicMediaType(current.contentType)
 const supported=enabled&&current.kind==='content'&&!current.purged&&contentType!==null
 useEffect(()=>{
  if(!supported)return
  const controller=new AbortController();let live=true;setState(null);setError('');setUrl('')
  api.filePublicUrl(file.id,controller.signal).then(value=>{if(live){setState(value);setUrl(value.url||'')}}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:t('Could not load the permanent media URL.'))})
  return()=>{live=false;controller.abort()}
 },[api,file.id,current.version,contentType,supported,revision,t])
 if(!supported)return null
 const run=async(action:()=>Promise<unknown>,refresh=true)=>{setBusy(true);setError('');try{await action();if(refresh)setRevision(value=>value+1)}catch(reason){setError(reason instanceof Error?reason.message:t('Media URL operation failed.'))}finally{setBusy(false)}}
 const create=()=>void run(async()=>{const result=await api.createFilePublicUrl(file.id);setUrl(result.url);setState(value=>value?{...value,url:result.url,version:result.version}:value)},false)
 const revoke=()=>{if(!window.confirm(t('Revoke every permanent media URL for this file?')))return;void run(async()=>{await api.revokeFilePublicUrls(file.id);setUrl('')})}
 return <section className="hx-file-share-controls hx-file-public-url-controls" aria-label={t('Permanent media URL')}>
  <h3>{t('Permanent media URL')}</h3>
  <p>{t('Anyone with this URL can access the current or previously published media version. Revoked links can remain in shared caches for up to 24 hours.')}</p>
  {state?.url&&<div className="hx-file-share-issued" role="status"><span>{t('Active URL')} · v{state.version}</span><input aria-label={t('Permanent media URL value')} readOnly value={url||state.url} onFocus={event=>event.currentTarget.select()}/><button type="button" onClick={()=>{void navigator.clipboard?.writeText(url||state.url!)}}>{t('Copy')}</button></div>}
  {!state&& !error&&<p role="status">{t('Loading permanent media URL…')}</p>}
  {state?.canCreate&&<button type="button" className="pill-btn" disabled={busy||current.kind!=='content'||current.purged} onClick={create}>{busy?t('Working…'):state.url?t('Get current URL'):t('Create permanent URL')}</button>}
  {state?.canRevoke&&state.url&&<button type="button" className="hx-file-public-url-revoke" disabled={busy} onClick={revoke}>{t('Revoke all URLs for this file')}</button>}
  {error&&<p role="alert">{error}</p>}
 </section>
}
