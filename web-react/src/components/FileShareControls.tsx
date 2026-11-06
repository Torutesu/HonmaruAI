import React,{useEffect,useState} from 'react'
import {useT} from '../utils/i18n'
import type {WorkspaceFileApi,WorkspaceFile,FileVersion,WorkspaceFileShare} from '../utils/workspaceFiles'

function shareUrl(token:string){
 const base=`${location.origin}${location.pathname}${location.search}`
 return `${base}#/file-share/${encodeURIComponent(token)}`
}

export function FileShareControls({api,file,current,enabled}:{api:WorkspaceFileApi;file:WorkspaceFile;current:FileVersion;enabled:boolean}){
 const t=useT(),[shares,setShares]=useState<WorkspaceFileShare[]|null>(null),[canManage,setCanManage]=useState(false)
 const [expiresIn,setExpiresIn]=useState<'24h'|'7d'|'30d'|'never'>('never'),[allowDownload,setAllowDownload]=useState(true),[reusable,setReusable]=useState(true)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[url,setUrl]=useState(''),[revision,setRevision]=useState(0)
 useEffect(()=>{if(!enabled)return;const controller=new AbortController();let live=true;setShares(null);api.fileShares(file.id,controller.signal).then(result=>{if(live){setShares(result.shares);setCanManage(result.canManage)}}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:t('Could not load public links.'))});return()=>{live=false;controller.abort()}},[api,file.id,enabled,revision,t])
 if(!enabled)return null
 const act=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');setUrl('');try{await action();setRevision(value=>value+1)}catch(reason){setError(reason instanceof Error?reason.message:t('Public link operation failed.'))}finally{setBusy(false)}}
 const create=()=>act(async()=>{const result=await api.createFileShare(file.id,{version:current.version,assets:[],expiresIn,allowDownload,reusable,requestKey:`share_${crypto.randomUUID().replaceAll('-','')}`});setUrl(shareUrl(result.token))})
 const copy=async(shareId:string)=>act(async()=>{const result=await api.copyFileShare(file.id,shareId);setUrl(shareUrl(result.token))})
 const update=(shareId:string)=>act(async()=>{await api.updateFileShare(file.id,shareId,{version:current.version,assets:[]})})
 const revoke=(shareId:string)=>{if(!window.confirm(t('Stop future access for this public link?')))return;void act(()=>api.changeFileShare(file.id,shareId,'revoke'))}
 return <section className="hx-file-share-controls" aria-label={t('Public sharing')}>
  <h3>{t('Public sharing')}</h3>
  <p>{t('A link publishes the selected immutable file version. Anyone with the link can open it until it expires or you revoke it.')}</p>
  <div className="hx-file-share-options">
   <label>{t('Link expiry')}<select aria-label={t('Link expiry')} value={expiresIn} disabled={busy} onChange={event=>setExpiresIn(event.target.value as typeof expiresIn)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="never">Never</option></select></label>
   <label><input type="checkbox" checked={allowDownload} disabled={busy} onChange={event=>setAllowDownload(event.target.checked)}/>{t('Allow download')}</label>
   <label><input type="checkbox" checked={reusable} disabled={busy} onChange={event=>setReusable(event.target.checked)}/>{t('Reuse link when updating')}</label>
   <button type="button" className="pill-btn" disabled={busy||current.kind!=='content'||current.purged} onClick={()=>void create()}>{busy?t('Working…'):t('Create public link')}</button>
  </div>
  {url&&<div className="hx-file-share-issued" role="status"><span>{t('Link created')}</span><input aria-label={t('Created public link')} readOnly value={url} onFocus={event=>event.currentTarget.select()}/><button type="button" onClick={()=>{void navigator.clipboard?.writeText(url)}}>{t('Copy')}</button></div>}
  {error&&<p role="alert">{error}</p>}
  {shares===null&&!error?<p role="status">{t('Loading public links…')}</p>:shares?.length===0?<p>{t('No public links for this file.')}</p>:<ul className="hx-file-share-list">{shares?.map(share=><li key={share.id}>
   <span><b>{t(share.status==='active'&&share.expiresAt&&Date.parse(share.expiresAt)<=Date.now()?'Expired':share.status)}</b><small>{share.expiresAt?`${t('Expires')} ${new Date(share.expiresAt).toLocaleString()}`:t('Never expires')} · {share.allowDownload?t('Downloads allowed'):t('View only')} · v{share.currentRevision}</small></span>
   {share.status==='active'&&<div className="hx-file-share-actions">{canManage&&<button type="button" disabled={busy} onClick={()=>void copy(share.id)}>{t('Copy link')}</button>}{canManage&&share.reusable&&<button type="button" disabled={busy||current.version===share.files[0]?.version} onClick={()=>void update(share.id)}>{t('Publish current version')}</button>}{canManage&&<button type="button" disabled={busy} onClick={()=>revoke(share.id)}>{t('Revoke')}</button>}</div>}
  </li>)}</ul>}
 </section>
}
