import React, {useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import type {AgentRoleState} from '../utils/harness'
import './AgentAccessDialog.css'

type Role='admin'|'member'|'none'
export function AgentAccessDialog({load,save,onClose}:{load:()=>Promise<AgentRoleState>;save:(ref:string,role:Role,version:number)=>Promise<unknown>;onClose:(scope?:'team'|'personal')=>void}) {
 const t=useT(),pending=useRef(false),generation=useRef(0)
 const [data,setData]=useState<AgentRoleState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [needsReload,setNeedsReload]=useState(false)
 const [ref,setRef]=useState(''),[role,setRole]=useState<Role>('member')
 const refresh=async()=>{const id=++generation.current;const next=await load();if(id===generation.current){setData(next);setRef('');setRole('member');setNeedsReload(false)}}
 useEffect(()=>{let alive=true;void refresh().catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e))});return()=>{alive=false;generation.current++}},[load])
 const reload=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await refresh()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{pending.current=false;setBusy(false)}}
 const current=data?.members.find(m=>m.ref===ref)
 const allowed=data?.canManage
 const changed=ref&&!current?.owner&&(current?current.role!==role:role!=='none')
 const submit=async()=>{
  if(pending.current||needsReload||!data||!allowed||!changed)return
  pending.current=true;setBusy(true);setError('');let saved=false
  try{await save(ref,role,data.version);saved=true;await refresh()}
  catch(e){if(saved)setNeedsReload(true);setError(saved?'Saved, but the member list could not refresh. Reload before editing again.':e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 return <Dialog title={t('Agent access')} className="hx-agent-access" onClose={()=>{if(!pending.current)onClose(data?.scope)}} footer={<>
  <button className="dlg-btn" disabled={busy} onClick={()=>void reload()}>{t('Reload')}</button>
  <button className="dlg-btn" disabled={busy} onClick={()=>onClose(data?.scope)}>{t('Close')}</button>
  {allowed&&<button className="dlg-btn primary" disabled={busy||needsReload||!changed} onClick={()=>void submit()}>{t(busy?'Saving…':data?.scope==='personal'?'Share and save':'Save')}</button>}
 </>}>
  {!data&&!error&&<p role="status">{t('Loading…')}</p>}
  {data&&<>
   <p className="dlg-hint">{t('Assigned roles add to the agent’s existing access setting. Admins can edit the agent and manage assigned roles.')}</p>
   <ul className="hx-agent-member-list">{data.members.map(m=><li key={m.ref}><Icon name={m.role==='admin'?'shield':'you'} size={18}/><span><strong>{m.name}</strong><small>{t(m.owner?'Maker':m.role==='admin'?'Agent admin':'Agent member')}</small></span>{allowed&&!m.owner&&<button className="dlg-btn" disabled={busy} aria-label={t('Edit role for {name}',{name:m.name})} onClick={()=>{setRef(m.ref);setRole(m.role)}}>{t('Edit')}</button>}</li>)}</ul>
   {data.scope==='personal'&&<p className="dlg-hint">{t('Assigning a role shares this personal agent only with its maker and assigned members.')}</p>}
   {allowed&&<div className="hx-agent-member-form">
    <label><span className="dlg-label">{t('Person')}</span><select className="dlg-input" value={ref} disabled={busy} onChange={e=>{const value=e.target.value;setRef(value);setRole(data.members.find(m=>m.ref===value)?.role||'member')}}><option value="">{t('Choose a member')}</option>{data.candidates.filter(p=>!data.members.some(m=>m.ref===p.ref&&m.owner)).map(p=><option key={p.ref} value={p.ref}>{p.name}</option>)}</select></label>
    <label><span className="dlg-label">{t('Agent role')}</span><select className="dlg-input" value={role} disabled={busy||!ref} onChange={e=>setRole(e.target.value as Role)}><option value="member">{t('Agent member')}</option><option value="admin">{t('Agent admin')}</option>{current&&<option value="none">{t('Remove assigned role')}</option>}</select></label>
    <p className="dlg-hint">{t('Removing an assigned role does not remove access granted to everyone or through the agent’s existing people list.')}</p>
   </div>}
  </>}
  {error&&<p className="dlg-error" role="alert">{t(error)}</p>}
 </Dialog>
}
