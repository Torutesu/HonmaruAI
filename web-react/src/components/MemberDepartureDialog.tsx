import React, {useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'
import './MemberDepartureDialog.css'

export interface DeparturePreview {
 version:string
 member:{ref:string;name:string;mine:boolean}
 agents:{id:string;name:string;owned:boolean;scope:string;version:number}[]
 skills?:{id:string;name:string;visibility:string;version:number}[]
 candidates:{ref:string;name:string}[]
}
export function MemberDepartureDialog({httpBase,orgId,sessionToken,member,onRemove,onClose}:{
 httpBase:string;orgId:string;sessionToken:string;member:{ref:string;name:string;mine:boolean}
 onRemove:(input:{transferTo?:string;previewVersion:string})=>Promise<void>;onClose:()=>void
}) {
 const t=useT(),pending=useRef(false)
 const [preview,setPreview]=useState<DeparturePreview|null>(null),[recipient,setRecipient]=useState('')
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
 useEffect(()=>{
  const abort=new AbortController();setPreview(null);setRecipient('');setError('')
  void fetch(`${httpBase}/members/departure?orgId=${encodeURIComponent(orgId)}&ref=${encodeURIComponent(member.ref)}`,{
   headers:{'x-session-token':sessionToken},signal:abort.signal,
  }).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.message||'Could not read your team.');return data})
   .then(data=>{if(!abort.signal.aborted)setPreview(data)})
   .catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:String(e))})
  return()=>abort.abort()
 },[httpBase,orgId,sessionToken,member.ref,revision])
 const hasResponsibilities=!!preview&&(preview.agents.length+(preview.skills?.length||0)>0)
 const submit=async()=>{
  if(pending.current||!preview||(hasResponsibilities&&!recipient))return
  pending.current=true;setBusy(true);setError('')
  try{await onRemove({previewVersion:preview.version,...(hasResponsibilities?{transferTo:recipient}:{})})}
  catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 return <Dialog className="member-departure" title={t(member.mine?'Leave workspace':'Remove member')} onClose={()=>{if(!pending.current)onClose()}}
  lede={t('{name} will lose access to this workspace. Historical messages stay visible.',{name:member.name})}
  footer={<>
   <button className="dlg-btn" disabled={busy} onClick={()=>setRevision(n=>n+1)}>{t('Reload')}</button>
   <button className="dlg-btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
   <button className="dlg-btn danger" disabled={busy||!preview||(hasResponsibilities&&!recipient)} onClick={()=>void submit()}>{t(busy?'Saving…':member.mine?'Leave':'Remove member')}</button>
  </>}>
  {!preview&&!error&&<p role="status">{t('Loading…')}</p>}
  {preview&&hasResponsibilities&&<>
   {preview.agents.length>0&&<>
   <details className="member-departure-resources" open><summary><Icon name="terminal" size={16}/>{t('Agents')}<span>{preview.agents.length}</span><Icon name="chevron-down" size={16}/></summary>
    <ul>{preview.agents.map(agent=><li key={agent.id}><span>{agent.name}</span><small>{t(agent.owned?'Owner':'Agent admin')}</small></li>)}</ul>
   </details></>}
   {!!preview.skills?.length&&<details className="member-departure-resources" open><summary><Icon name="book" size={16}/>{t('Custom skills')}<span>{preview.skills.length}</span><Icon name="chevron-down" size={16}/></summary>
    <ul>{preview.skills.map(skill=><li key={skill.id}><span>{skill.name}</span><small>{t('Owner')}</small></li>)}</ul>
   </details>}
   <label className="member-departure-recipient"><span className="dlg-label">{t('Transfer to')}</span>
    <select className="dlg-input" value={recipient} disabled={busy} onChange={e=>setRecipient(e.target.value)}><option value="">{t('Choose a member')}</option>{preview.candidates.map(person=><option key={person.ref} value={person.ref}>{person.name}</option>)}</select>
   </label>
   <p className="dlg-hint">{t('The successor receives the listed responsibilities and ownership where applicable. Original creators stay unchanged.')}</p>
   {!preview.candidates.length&&<p role="alert" className="dlg-error">{t('Add another workspace member before transferring these responsibilities.')}</p>}
  </>}
  {preview&&<p className="dlg-hint">{t('Computers connected by this member will be disconnected. Their queued or running jobs will be cancelled.')}</p>}
  {error&&<p className="dlg-error" role="alert">{t(error)}</p>}
 </Dialog>
}
