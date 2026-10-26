import React, {useEffect, useRef, useState} from 'react'
import {Dialog} from './Dialog'
import type {AppEntity, Column, Row} from '../utils/harness'
import {AppPersonPicker, type AppPerson} from './AppPersonPicker'

type RelationEntity=AppEntity & {rows:Row[]}
function relationLabel(entity:RelationEntity,row:Row){const column=entity.table.columns[0];const value=column?row.values[column.id]:null;return value==null||value===''?row.id:String(value)}
function RelationField({column,value,entity,disabled,onChange}:{column:Column;value:unknown;entity?:RelationEntity;disabled:boolean;onChange:(value:unknown)=>void}){
 const options=entity?.rows||[],known=new Set(options.map(row=>row.id)),selectedIds=Array.isArray(value)?value.map((item:unknown)=>String(item)):[],single=value==null||Array.isArray(value)?'':String(value)
 const missing:string[]=column.multiple?selectedIds.filter((id:string)=>!known.has(id)):single&&!known.has(single)?[single]:[]
 return <select className="dlg-input hx-relation-select" aria-label={column.name} disabled={disabled} multiple={column.multiple||undefined} value={column.multiple?selectedIds:single} onChange={event=>onChange(column.multiple?Array.from(event.currentTarget.selectedOptions,option=>option.value):event.target.value||null)}>{!column.multiple&&<option value="">{column.name}を選択</option>}{missing.map((id:string)=><option key={id} value={id}>{id}（未取得）</option>)}{options.map(row=><option key={row.id} value={row.id}>{relationLabel(entity!,row)}</option>)}</select>
}

export function AppRecordDialog({appName,columns,initial={},record,conversation,members=[],membersReady=true,relationEntities=[],save,onClose}:{appName:string;columns:Column[];initial?:Record<string,unknown>;record?:Row;conversation?:React.ReactNode;members?:AppPerson[];membersReady?:boolean;relationEntities?:RelationEntity[];save:(values:Record<string,unknown>)=>Promise<void>;onClose:()=>void}) {
 const [draft,setDraft]=useState<Record<string,unknown>>(record?.values || initial),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const pending=useRef(false),form=useRef<HTMLFormElement>(null)
 const close=()=>{if(!pending.current)onClose()}
 useEffect(()=>{const trap=(e:KeyboardEvent)=>{if(e.key!=='Tab')return;const dialog=form.current?.closest('[role="dialog"]');const fields=Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')||[]);const first=fields[0],last=fields.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}};document.addEventListener('keydown',trap,true);return()=>document.removeEventListener('keydown',trap,true)},[])
 const submit=async(e:React.FormEvent)=>{e.preventDefault();if(pending.current)return;pending.current=true;setBusy(true);setError('');try{const values=Object.fromEntries(columns.filter(c=>record ? draft[c.id]!==record.values[c.id] : draft[c.id]!==undefined&&draft[c.id]!=='').map(c=>[c.id,draft[c.id]===''?null:c.type==='number'&&draft[c.id]!=null?Number(draft[c.id]):draft[c.id]]));await save(values);onClose()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{pending.current=false;setBusy(false)}}
 const change=(id:string,value:unknown)=>setDraft(d=>({...d,[id]:value}))
 return <Dialog title={record?"レコード詳細":"新規レコード"} lede={record?appName:`${appName}に新しいレコードを作成します。`} className={`hx-record-dialog${conversation?' hx-record-with-chat':''}`} onClose={close} footer={<><button className="dlg-btn" disabled={busy} onClick={close}>キャンセル</button><button className="dlg-btn primary" form="hx-record-form" type="submit" disabled={busy}>{busy?(record?'保存中…':'作成中…'):(record?'保存':'作成')}</button></>}>
  <div className="hx-record-columns"><form id="hx-record-form" ref={form} onSubmit={e=>void submit(e)} className="hx-record-form">
   {columns.map((c,i)=>c.type==='relation'
    ? <label key={c.id}><span className="dlg-label">{c.name}</span><RelationField column={c} value={draft[c.id]} entity={relationEntities.find(item=>item.key===c.targetEntity)} disabled={busy} onChange={value=>change(c.id,value)}/></label>
    : c.type==='person'
    ? <div key={c.id} className="hx-record-field"><span className="dlg-label">{c.name}</span><AppPersonPicker label={c.name} value={String(draft[c.id]??'')} members={members} ready={membersReady} disabled={busy} onChange={value=>change(c.id,value)}/></div>
    : <label key={c.id}><span className="dlg-label">{c.name}</span>{c.type==='checkbox'?<input type="checkbox" checked={Boolean(draft[c.id])} disabled={busy} onChange={e=>change(c.id,e.target.checked)}/>:c.type==='select'?<select className="dlg-input" disabled={busy} value={String(draft[c.id]??'')} onChange={e=>change(c.id,e.target.value)}><option value="">{c.name}を選択</option>{draft[c.id] && !(c.options||[]).includes(String(draft[c.id])) ? <option value={String(draft[c.id])}>{String(draft[c.id])}</option>:null}{(c.options||[]).map(o=><option key={o}>{o}</option>)}</select>:c.type==='text'?<textarea className="dlg-input" rows={i===0?3:2} maxLength={5000} disabled={busy} value={String(draft[c.id]??'')} onChange={e=>change(c.id,e.target.value)}/>:<input className="dlg-input" type={c.type==='number'?'number':c.type==='date'?'date':c.type==='email'?'email':c.type==='url'?'url':'text'} step={c.type==='number'?'any':undefined} disabled={busy} value={String(draft[c.id]??'')} onChange={e=>change(c.id,e.target.value)}/>}</label>)}
   {record&&<dl className="hx-record-metadata"><div><dt>ID</dt><dd>{record.id}</dd></div><div><dt>作成日時</dt><dd>{record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'}</dd></div><div><dt>更新日時</dt><dd>{new Date(record.updatedAt).toLocaleString()}</dd></div></dl>}
   {error&&<p role="alert" className="dlg-error">{error}</p>}
  </form>{conversation}</div>
 </Dialog>
}
