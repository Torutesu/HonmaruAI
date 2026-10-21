import React,{useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import './RoomCreateDialog.css'

export const ROOM_COLORS={teal:'#4b8b80',olive:'#7b8056',blue:'#668ec1',purple:'#9978b9',pink:'#bd799b',orange:'#c48b57',red:'#bb7474',gray:'#858585'} as const
export interface RoomPerson {id:string;kind:'person'|'agent';name:string;avatarUrl?:string;selected?:boolean}
export interface RoomCreateInput {requestId:string;name:string;private:boolean;guidelines:string;color:keyof typeof ROOM_COLORS;memberRefs:string[];agentIds:string[]}
export function RoomCreateDialog({people,onCreate,onClose}:{people:RoomPerson[];onCreate:(input:RoomCreateInput)=>Promise<void>;onClose:()=>void}) {
 const t=useT(),[step,setStep]=useState(0),[privateRoom,setPrivate]=useState(false),[name,setName]=useState(''),[guidelines,setGuidelines]=useState('')
 const [color,setColor]=useState<keyof typeof ROOM_COLORS>('teal'),[colorsOpen,setColorsOpen]=useState(false),[query,setQuery]=useState('')
 const key=(p:RoomPerson)=>`${p.kind}:${p.id}`
 const [selected,setSelected]=useState(()=>new Set(people.filter(p=>p.selected).map(key)))
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),pending=useRef(false),requestId=useRef(crypto.randomUUID())
 const nameField=useRef<HTMLInputElement>(null),searchField=useRef<HTMLInputElement>(null)
 useEffect(()=>{if(step===1)nameField.current?.focus();if(step===2)searchField.current?.focus()},[step])
 const visible=people.filter(p=>p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 const chosen=people.filter(p=>selected.has(key(p))),allVisible=visible.length>0&&visible.every(p=>selected.has(key(p)))
 const toggle=(id:string)=>setSelected(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next})
 const submit=async()=>{
  if(pending.current||!name.trim())return
  pending.current=true;setBusy(true);setError('')
  try{await onCreate({requestId:requestId.current,name:name.trim(),private:privateRoom,guidelines,color,memberRefs:chosen.filter(p=>p.kind==='person').map(p=>p.id),agentIds:chosen.filter(p=>p.kind==='agent').map(p=>p.id)})}
  catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 const back=()=>{setColorsOpen(false);setError('');setStep(n=>n-1)}
 return <Dialog className="room-create" title={t('Create room')} onClose={()=>{if(!pending.current)onClose()}}
  lede={t(['Choose who can access this room.','Give your room a name and purpose.','Invite members to start collaborating.'][step])}
  footer={<><div className="room-create-progress" aria-label={t('Step {step} of {total}',{step:step+1,total:3})}>{[0,1,2].map(n=><span key={n} className={step===n?'current':''}/>)}</div>
   <button type="button" className="dlg-btn room-create-back" disabled={busy} onClick={step===0?onClose:back}>{step>0&&<Icon name="chevron-left" size={15}/>} {t(step===0?'Cancel':'Back')}</button>
   <button type="button" className="dlg-btn primary" disabled={busy||(step>0&&!name.trim())} onClick={()=>{if(step<2){setColorsOpen(false);setStep(n=>n+1)}else void submit()}}>{t(busy?'Creating…':step===2?'Create':'Next')}</button></>}>
  {step===0&&<div className="room-create-visibility">{[false,true].map(value=><button key={String(value)} type="button" aria-pressed={privateRoom===value} onClick={()=>setPrivate(value)}>
   <span className="room-create-type-icon"><Icon name={value?'room-lock':'room'} size={16}/></span><span><strong>{t(value?'Private room':'Public room')}</strong><small>{t(value?'Only invited members can access.':'Everyone in the workspace can access.')}</small></span>
  </button>)}</div>}
  {step===1&&<>
   <label className="dlg-label" htmlFor="room-create-name">{t('Room name')}</label>
   <div className="room-create-name-row"><div className="room-create-color-wrap"><button type="button" className="room-create-color" aria-label={t('Room color: {color}',{color:t(color)})} aria-expanded={colorsOpen} onClick={()=>setColorsOpen(v=>!v)} style={{'--room-color':ROOM_COLORS[color]} as React.CSSProperties}><Icon name="room" size={18}/></button>
    {colorsOpen&&<div className="room-create-colors" role="group" aria-label={t('Room color')}>{Object.entries(ROOM_COLORS).map(([id,value])=><button key={id} type="button" aria-label={t(id)} aria-pressed={id===color} style={{background:value}} onClick={()=>{setColor(id as keyof typeof ROOM_COLORS);setColorsOpen(false)}}>{id===color&&<Icon name="check" size={14}/>}</button>)}</div>}
   </div><input ref={nameField} id="room-create-name" className="dlg-input" maxLength={120} value={name} placeholder={t('e.g. design-review')} onChange={e=>setName(e.target.value)}/></div>
   <label className="dlg-label" htmlFor="room-create-guidelines">{t('Guidelines')}</label><textarea id="room-create-guidelines" className="dlg-input room-create-guidelines" value={guidelines} maxLength={4096} onChange={e=>setGuidelines(e.target.value)} placeholder={t('Add context, rules, and guidelines for members collaborating in this room.')}/>
   <div className="room-create-count">{guidelines.length} / 4096</div>
  </>}
  {step===2&&<>
   <div className="room-create-notice"><Icon name={privateRoom?'lock':'globe'} size={15}/><span>{t(privateRoom?'Only invited members can view this room. Choose the initial members.':'Everyone in the workspace can view this room. Choose the initial members.')}</span></div>
   <label className="room-create-search"><Icon name="search" size={15}/><input ref={searchField} value={query} disabled={busy} aria-label={t('Search members')} placeholder={t('Search members')} onChange={e=>setQuery(e.target.value)}/></label>
   <div className="room-create-people"><label className="room-create-person room-create-all"><input type="checkbox" checked={allVisible} disabled={busy||!visible.length} onChange={()=>setSelected(previous=>{const next=new Set(previous);for(const p of visible){if(allVisible)next.delete(key(p));else next.add(key(p))}return next})}/><span>{t('Select all')}</span></label>
    {visible.map(p=><label className="room-create-person" key={key(p)}><input type="checkbox" checked={selected.has(key(p))} disabled={busy} onChange={()=>toggle(key(p))}/>{p.avatarUrl?<img src={p.avatarUrl} alt=""/>:<span className="room-create-avatar" aria-hidden="true">{p.name.slice(0,1)}</span>}<span className="room-create-person-name">{p.name}</span>{p.kind==='agent'&&<span aria-label={t('Agent')}><Icon name="bot" size={13}/></span>}</label>)}
    {!visible.length&&<p className="room-create-empty">{t(query?'No matching members.':'No other members yet.')}</p>}
   </div><p className="room-create-count">{t('{count} selected',{count:chosen.length})}</p>
  </>}
  {error&&<p className="dlg-error" role="alert">{t(error)}</p>}
 </Dialog>
}
