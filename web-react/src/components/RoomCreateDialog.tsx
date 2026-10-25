import React,{useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import {RoomColorPicker} from './RoomColorPicker'
import './RoomCreateDialog.css'

import {ROOM_COLORS} from '../utils/roomColors'
export {ROOM_COLORS} from '../utils/roomColors'
export interface RoomPerson {id:string;kind:'person'|'agent';name:string;avatarUrl?:string;selected?:boolean;requestOnly?:boolean;accessRequestStatus?:'none'|'pending';missingAccessMembers?:Array<{ref:string;name:string}>;canGrantAccess?:boolean}
export interface RoomCreateInput {requestId:string;name:string;private:boolean;guidelines:string;color:keyof typeof ROOM_COLORS;memberRefs:string[];agentIds:string[];grantAccessAgentIds:string[]}
export function RoomCreateDialog({people,onCreate,onClose,onRequestAgentAccess}:{people:RoomPerson[];onCreate:(input:RoomCreateInput)=>Promise<void>;onClose:()=>void;onRequestAgentAccess?:(agent:RoomPerson)=>Promise<void>}) {
 const t=useT(),[step,setStep]=useState(0),[privateRoom,setPrivate]=useState(false),[name,setName]=useState(''),[guidelines,setGuidelines]=useState('')
 const [color,setColor]=useState<keyof typeof ROOM_COLORS>('teal'),[query,setQuery]=useState('')
 const key=(p:RoomPerson)=>`${p.kind}:${p.id}`
 const [selected,setSelected]=useState(()=>new Set(people.filter(p=>p.selected&&!p.requestOnly).map(key)))
 const [grantAccessAgentIds,setGrantAccessAgentIds]=useState<string[]>([])
 const [busy,setBusy]=useState(false),[requesting,setRequesting]=useState<string|null>(null),[error,setError]=useState(''),pending=useRef(false),request=useRef<{signature:string;id:string}|null>(null)
 const nameField=useRef<HTMLInputElement>(null),searchField=useRef<HTMLInputElement>(null),selectAllField=useRef<HTMLInputElement>(null)
 useEffect(()=>{if(step===1)nameField.current?.focus();if(step===2)searchField.current?.focus()},[step])
 const visible=people.filter(p=>p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 const selectable=visible.filter(p=>!p.requestOnly)
 const chosen=people.filter(p=>!p.requestOnly&&selected.has(key(p))),allVisible=selectable.length>0&&selectable.every(p=>selected.has(key(p)))
 const selectedPeopleRefs=new Set(chosen.filter(p=>p.kind==='person').map(p=>p.id))
 const someVisible=selectable.some(p=>selected.has(key(p)))
 useEffect(()=>{if(selectAllField.current)selectAllField.current.indeterminate=someVisible&&!allVisible},[someVisible,allVisible,step])
 const toggle=(person:RoomPerson)=>{const id=key(person);setSelected(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next});if(selected.has(id)&&person.kind==='agent')setGrantAccessAgentIds(previous=>previous.filter(agentId=>agentId!==person.id))}
 const requestAccess=async(agent:RoomPerson)=>{
  if(!onRequestAgentAccess||requesting)return
  setRequesting(agent.id);setError('')
  try{await onRequestAgentAccess(agent)}catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setRequesting(null)}
 }
 const submit=async()=>{
  if(pending.current||!name.trim())return
  pending.current=true;setBusy(true);setError('')
  const draft={name:name.trim(),private:privateRoom,guidelines,color,memberRefs:chosen.filter(p=>p.kind==='person').map(p=>p.id).sort(),agentIds:chosen.filter(p=>p.kind==='agent').map(p=>p.id).sort(),grantAccessAgentIds:chosen.filter(p=>p.kind==='agent'&&p.canGrantAccess&&grantAccessAgentIds.includes(p.id)&&p.missingAccessMembers?.some(member=>selectedPeopleRefs.has(member.ref))).map(p=>p.id).sort()}
  const signature=JSON.stringify(draft)
  // Retrying the same operation reuses its key; edited inputs are a new
  // operation, never a replay of an earlier room with different members.
  if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()}
  try{await onCreate({requestId:request.current.id,...draft})}
  catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 const back=()=>{setError('');setStep(n=>n-1)}
 return <Dialog className="room-create" title={t('Create room')} onClose={()=>{if(!pending.current)onClose()}}
  lede={t(['Choose who can access this room.','Give your room a name and purpose.','Invite members to start collaborating.'][step])}
  footer={<><div className="room-create-progress" aria-label={t('Step {step} of {total}',{step:step+1,total:3})}>{[0,1,2].map(n=><span key={n} className={step===n?'current':''}/>)}</div>
   <button type="button" className="dlg-btn room-create-back" disabled={busy} onClick={step===0?onClose:back}>{step>0&&<Icon name="chevron-left" size={15}/>} {t(step===0?'Cancel':'Back')}</button>
   <button type="button" className="dlg-btn primary" disabled={busy||(step>0&&!name.trim())} onClick={()=>{if(step<2){setStep(n=>n+1)}else void submit()}}>{t(busy?'Creating…':step===2?'Create':'Next')}</button></>}>
  {step===0&&<div className="room-create-visibility">{[false,true].map(value=><button key={String(value)} type="button" aria-pressed={privateRoom===value} onClick={()=>setPrivate(value)}>
   <span className="room-create-type-icon"><Icon name={value?'room-lock':'room'} size={16}/></span><span><strong>{t(value?'Private room':'Public room')}</strong><small>{t(value?'Only invited members can access.':'Everyone in the workspace can access.')}</small></span>
  </button>)}</div>}
  {step===1&&<>
   <label className="dlg-label" htmlFor="room-create-name">{t('Room name')}</label>
   <div className="room-create-name-row"><RoomColorPicker color={color} onChange={setColor}/><input ref={nameField} id="room-create-name" className="dlg-input" maxLength={120} value={name} placeholder={t('e.g. design-review')} onChange={e=>setName(e.target.value)}/></div>
   <label className="dlg-label" htmlFor="room-create-guidelines">{t('Guidelines')}</label><textarea id="room-create-guidelines" className="dlg-input room-create-guidelines" value={guidelines} maxLength={4096} onChange={e=>setGuidelines(e.target.value)} placeholder={t('Add context, rules, and guidelines for members collaborating in this room.')}/>
   <div className="room-create-count">{guidelines.length} / 4096</div>
  </>}
  {step===2&&<>
   <div className="room-create-notice"><Icon name={privateRoom?'lock':'globe'} size={15}/><span>{t(privateRoom?'Only invited members can view this room. Choose the initial members.':'Everyone in the workspace can view this room. Choose the initial members.')}</span></div>
   <label className="room-create-search"><Icon name="search" size={15}/><input ref={searchField} value={query} disabled={busy} aria-label={t('Search members')} placeholder={t('Search members')} onChange={e=>setQuery(e.target.value)}/></label>
   <div className="room-create-people"><label className="room-create-person room-create-all"><input ref={selectAllField} type="checkbox" aria-checked={someVisible&&!allVisible?'mixed':allVisible} checked={allVisible} disabled={busy||!selectable.length} onChange={()=>{setSelected(previous=>{const next=new Set(previous);for(const p of selectable){if(allVisible)next.delete(key(p));else next.add(key(p))}return next});if(allVisible)setGrantAccessAgentIds(previous=>previous.filter(agentId=>!selectable.some(p=>p.kind==='agent'&&p.id===agentId)))}}/><span>{t('Select all')}</span></label>
    {visible.map(p=>{const missingSelected=p.kind==='agent'?(p.missingAccessMembers||[]).filter(member=>selectedPeopleRefs.has(member.ref)):[];return <div className="room-create-person-row" key={key(p)}><label className="room-create-person"><input type="checkbox" checked={!p.requestOnly&&selected.has(key(p))} disabled={busy||p.requestOnly||Boolean(requesting)} onChange={()=>toggle(p)}/>{p.avatarUrl?<img src={p.avatarUrl} alt=""/>:<span className="room-create-avatar" aria-hidden="true">{p.name.slice(0,1)}</span>}<span className="room-create-person-name">{p.name}</span>{p.kind==='agent'&&<span aria-label={t('Agent')}><Icon name={p.requestOnly?'lock':'bot'} size={13}/></span>}</label>{p.requestOnly&&<button type="button" className="room-create-request-access" disabled={busy||Boolean(requesting)||p.accessRequestStatus==='pending'} onClick={()=>void requestAccess(p)}>{requesting===p.id?t('Sending…'):p.accessRequestStatus==='pending'?t('Request sent'):t('Request access')}</button>}
     {!p.requestOnly&&p.kind==='agent'&&selected.has(key(p))&&Boolean(missingSelected.length)&&<fieldset className="room-create-access-choice"><legend>{t('Some room members do not have access to this agent.')}</legend>{p.canGrantAccess?<>
      <label><input type="radio" name={`create-agent-access-${p.id}`} checked={!grantAccessAgentIds.includes(p.id)} onChange={()=>setGrantAccessAgentIds(previous=>previous.filter(id=>id!==p.id))}/>{t('Add without access')}</label>
      <label><input type="radio" name={`create-agent-access-${p.id}`} checked={grantAccessAgentIds.includes(p.id)} onChange={()=>setGrantAccessAgentIds(previous=>previous.includes(p.id)?previous:[...previous,p.id])}/>{t('Grant access and add ({n})',{n:missingSelected.length})}</label>
     </>:<p>{t('You need agent access permissions to grant access to these room members.')}</p>}</fieldset>}
    </div>})}
    {!visible.length&&<p className="room-create-empty">{t(query?'No matching members.':'No other members yet.')}</p>}
   </div><p className="room-create-count">{t('{count} selected',{count:chosen.length})}</p>
  </>}
  {error&&<p className="dlg-error" role="alert">{t(error)}</p>}
 </Dialog>
}
