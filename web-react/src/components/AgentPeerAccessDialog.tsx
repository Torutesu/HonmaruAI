import React,{useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import type {AgentPeerRoleState} from '../utils/harness'
import './AgentAccessDialog.css'

type Role='admin'|'member'|'none'
export function AgentPeerAccessDialog({load,save,onClose}:{load:()=>Promise<AgentPeerRoleState>;save:(memberAgentId:string,role:Role,version:number)=>Promise<unknown>;onClose:()=>void}) {
 const t=useT(),pending=useRef(false),generation=useRef(0)
 const [data,setData]=useState<AgentPeerRoleState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[needsReload,setNeedsReload]=useState(false)
 const [memberAgentId,setMemberAgentId]=useState(''),[role,setRole]=useState<Role>('member')
 const refresh=async()=>{const id=++generation.current;const next=await load();if(id===generation.current){setData(next);setMemberAgentId('');setRole('member');setNeedsReload(false)}}
 useEffect(()=>{let alive=true;void refresh().catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e))});return()=>{alive=false;generation.current++}},[load])
 const reload=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await refresh()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{pending.current=false;setBusy(false)}}
 const current=data?.members.find(member=>member.agentId===memberAgentId)
 const changed=!!memberAgentId&&(current?current.role!==role:role!=='none')
 const submit=async()=>{if(pending.current||needsReload||!data?.canManage||data.scope!=='team'||!changed)return
  pending.current=true;setBusy(true);setError('')
  try{await save(memberAgentId,role,data.version);try{window.dispatchEvent(new CustomEvent('honmaru:agent-access-changed',{detail:{agentId:memberAgentId}}))}catch{/* no window */}await refresh()}
  catch(e){const message=e instanceof Error?e.message:String(e);if((typeof e==='object'&&e!==null&&'status'in e&&(e as {status?:unknown}).status===409)||message.includes('Agent access changed'))setNeedsReload(true);setError(message)}
  finally{pending.current=false;setBusy(false)}
 }
 const allowed=!!data?.managed&&!!data.canManage&&data.scope==='team'
 return <Dialog title={t('Agent roles')} className="hx-agent-access" onClose={()=>{if(!pending.current)onClose()}} footer={<>
  <button className="dlg-btn" disabled={busy} onClick={()=>void reload()}>{t('Reload')}</button>
  <button className="dlg-btn" disabled={busy} onClick={onClose}>{t('Close')}</button>
  {allowed&&<button className="dlg-btn primary" disabled={busy||needsReload||!changed} onClick={()=>void submit()}>{t(busy?'Saving…':'Save')}</button>}
 </>}>
  {!data&&!error&&<p role="status">{t('Loading…')}</p>}
  {data&&<><p className="dlg-hint">{t('Assign managed team Agents to this Agent. Agent Admins can change a peer role; members can view assignments.')}</p>
   {(!data.managed||data.scope!=='team')&&<p className="dlg-hint">{t('Peer roles are available for managed team Agents only.')}</p>}
   <ul className="hx-agent-member-list" aria-label={t('Assigned agents')}>{data.members.map(member=><li key={member.agentId}><Icon name={member.role==='admin'?'shield':'you'} size={18}/><span><strong>{member.name}</strong><small>{t(member.role==='admin'?'Agent admin':'Agent member')}</small></span></li>)}</ul>
   {data.members.length===0&&<p className="dlg-hint">{t('No Agents are assigned yet.')}</p>}
   {allowed&&<div className="hx-agent-member-form">
    <label><span className="dlg-label">{t('Managed Agent')}</span><select className="dlg-input" value={memberAgentId} disabled={busy||needsReload} onChange={event=>{const value=event.target.value;setMemberAgentId(value);setRole(data.members.find(member=>member.agentId===value)?.role||'member')}}><option value="">{t('Choose an Agent')}</option>{data.candidates.filter(candidate=>candidate.id!==memberAgentId).map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
    <label><span className="dlg-label">{t('Agent role')}</span><select className="dlg-input" value={role} disabled={busy||needsReload||!memberAgentId} onChange={event=>setRole(event.target.value as Role)}><option value="member">{t('Agent member')}</option><option value="admin">{t('Agent admin')}</option>{current&&<option value="none">{t('Remove assigned role')}</option>}</select></label>
   </div>}
  </>}
  {error&&<p className="dlg-error" role="alert">{needsReload?t('Agent access changed. Reload before saving.'):t(error)}</p>}
 </Dialog>
}
