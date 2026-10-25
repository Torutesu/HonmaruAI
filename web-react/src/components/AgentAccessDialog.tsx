import React, {useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import type {AgentRoleState} from '../utils/harness'
import './AgentAccessDialog.css'

type Role='admin'|'member'|'none'
export function AgentAccessDialog({agentId,load,save,transfer,onClose}:{agentId?:string;load:()=>Promise<AgentRoleState>;save:(ref:string,role:Role,version:number)=>Promise<unknown>;transfer?:(ref:string,version:number)=>Promise<unknown>;onClose:(scope?:'team'|'personal')=>void}) {
 const t=useT(),pending=useRef(false),generation=useRef(0)
 const [data,setData]=useState<AgentRoleState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [needsReload,setNeedsReload]=useState(false)
 const [transferTo,setTransferTo]=useState('')
 const [ref,setRef]=useState(''),[role,setRole]=useState<Role>('member')
 const refresh=async()=>{const id=++generation.current;const next=await load();if(id===generation.current){setData(next);setRef('');setRole('member');setTransferTo('');setNeedsReload(false)}}
 useEffect(()=>{let alive=true;void refresh().catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e))});return()=>{alive=false;generation.current++}},[load])
 useEffect(()=>{
  if(typeof window==='undefined')return
  const onChanged=(event:Event)=>{
   const changed=(event as CustomEvent<{agentId?:string}>).detail?.agentId
   if(!agentId||changed!==agentId||pending.current)return
   void refresh().catch(e=>setError(e instanceof Error?e.message:String(e)))
  }
  window.addEventListener('honmaru:agent-access-changed',onChanged)
  return()=>window.removeEventListener('honmaru:agent-access-changed',onChanged)
 },[agentId,load])
 const reload=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await refresh()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{pending.current=false;setBusy(false)}}
 const current=data?.members.find(m=>m.ref===ref)
 const allowed=data?.canManage||data?.canAddMembers
 const changed=ref&&!current?.owner&&(current?current.role!==role:role!=='none')
 const canTransfer=!!transfer&&data?.scope==='team'&&data.members.some(m=>m.mine&&m.owner)
 const handOver=async()=>{
  if(pending.current||needsReload||!canTransfer||!transferTo||!data||!transfer)return
  pending.current=true;setBusy(true);setError('');let saved=false
  try{await transfer(transferTo,data.version);saved=true;await refresh()}
  catch(e){if(saved)setNeedsReload(true);setError(saved?'Saved, but the member list could not refresh. Reload before editing again.':e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 const submit=async()=>{
  if(pending.current||needsReload||!data||!allowed||!changed)return
  pending.current=true;setBusy(true);setError('');let saved=false
  try{await save(ref,role,data.version);saved=true;if(current?.mine&&role==='none'){onClose(data.scope);return}if(data.scope==='personal')setData({...data,scope:'team'});await refresh()}
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
   <p className="dlg-hint">{t('Members can add or remove ordinary members. Admins can also change roles and edit the agent.')}</p>
   <ul className="hx-agent-member-list">{data.members.map(m=><li key={m.ref}><Icon name={m.role==='admin'?'shield':'you'} size={18}/><span><strong>{m.name}</strong><small>{t(m.owner?'Owner':m.role==='admin'?'Agent admin':'Agent member')}</small></span>{allowed&&!m.owner&&(data.canManage||m.role==='member')&&<button className="dlg-btn" disabled={busy} aria-label={m.mine?t('Remove myself'):t('Edit role for {name}',{name:m.name})} onClick={()=>{setRef(m.ref);setRole(m.mine?'none':m.role)}}>{t(m.mine?'Remove myself':'Edit')}</button>}</li>)}</ul>
   {data.scope==='personal'&&<p className="dlg-hint">{t('Assigning a role shares this personal agent only with its owner and assigned members.')}</p>}
   {allowed&&<div className="hx-agent-member-form">
    <label><span className="dlg-label">{t('Person')}</span><select className="dlg-input" value={ref} disabled={busy} onChange={e=>{const value=e.target.value;setRef(value);setRole(data.members.find(m=>m.ref===value)?.role||'member')}}><option value="">{t('Choose a member')}</option>{data.candidates.filter(p=>!data.members.some(m=>m.ref===p.ref&&(m.owner||(!data.canManage&&m.role==='admin')))).map(p=><option key={p.ref} value={p.ref}>{p.name}</option>)}</select></label>
    <label><span className="dlg-label">{t('Agent role')}</span><select className="dlg-input" value={role} disabled={busy||!ref} onChange={e=>setRole(e.target.value as Role)}><option value="member">{t('Agent member')}</option>{data.canManage&&<option value="admin">{t('Agent admin')}</option>}{current&&<option value="none">{t('Remove assigned role')}</option>}</select></label>
    <p className="dlg-hint">{t('Removing an assigned role does not remove access granted to everyone or through the agent’s existing people list.')}</p>
   </div>}
   {canTransfer&&<div className="hx-agent-transfer">
    <label><span className="dlg-label">{t('Transfer ownership')}</span><select className="dlg-input" aria-label={t('New owner')} value={transferTo} disabled={busy||needsReload} onChange={e=>setTransferTo(e.target.value)}><option value="">{t('Choose an agent admin')}</option>{data.members.filter(m=>m.role==='admin'&&!m.owner).map(m=><option key={m.ref} value={m.ref}>{m.name}</option>)}</select></label>
    <p className="dlg-hint">{t('The new owner must already be an agent admin. You remain an admin; the original creator stays unchanged.')}</p>
    <button className="dlg-btn" disabled={busy||needsReload||!transferTo} onClick={()=>void handOver()}>{t('Transfer ownership')}</button>
   </div>}
  </>}
  {error&&<p className="dlg-error" role="alert">{t(error)}</p>}
 </Dialog>
}
