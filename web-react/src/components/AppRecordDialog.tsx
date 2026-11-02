import React, {useRef, useState} from 'react'
import {Dialog} from './Dialog'
import type {AppEntity, Column, Row} from '../utils/harness'
import {AppPersonPicker, type AppPerson} from './AppPersonPicker'
import {AppRelationPicker} from './AppRelationPicker'
import {useT} from '../utils/i18n'

type RelationEntity=AppEntity & {rows:Row[]}

function equalValue(left:unknown,right:unknown):boolean {
 if(Object.is(left,right))return true
 return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((item,index)=>equalValue(item,right[index]))
}

export function AppRecordDialog({appName,tableName=appName,columns,initial={},record,conversation,members=[],membersReady=true,relationEntities=[],save,onClose}:{appName:string;tableName?:string;columns:Column[];initial?:Record<string,unknown>;record?:Row;conversation?:React.ReactNode;members?:AppPerson[];membersReady?:boolean;relationEntities?:RelationEntity[];save:(values:Record<string,unknown>)=>Promise<void>;onClose:()=>void}) {
 const t=useT()
 const [draft,setDraft]=useState<Record<string,unknown>>(record?.values || initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmDiscard,setConfirmDiscard]=useState(false)
 const pending=useRef(false),form=useRef<HTMLFormElement>(null),original=useRef(record?.values||initial)
 const values=(source=draft)=>Object.fromEntries(columns.filter(c=>record ? source[c.id]!==record.values[c.id] : source[c.id]!==undefined&&source[c.id]!=='').map(c=>[c.id,source[c.id]===''?null:c.type==='number'&&source[c.id]!=null?Number(source[c.id]):source[c.id]]))
 const close=()=>{
  if(pending.current||confirmDiscard)return
  const current=values(),baseline=record?original.current:values(original.current)
  const changed=record?Object.entries(current).some(([id,value])=>!equalValue(value,baseline[id])):Array.from(new Set([...Object.keys(current),...Object.keys(baseline)])).some(id=>!equalValue(current[id],baseline[id]))
  // Number() can round distinct input strings to the same IEEE-754 value.
  // Keep the user's exact numeric text safe when closing, even if saving it
  // would currently coerce to the original number.
  const numericTextChanged=columns.some(c=>c.type==='number'&&String(draft[c.id]??'')!==String(original.current[c.id]??''))
  const incomplete=Array.from(form.current?.querySelectorAll<HTMLInputElement>('input')||[]).some(input=>input.validity.badInput)
  if(changed||numericTextChanged||incomplete)setConfirmDiscard(true);else onClose()
 }
 const submit=async(e:React.FormEvent)=>{e.preventDefault();if(pending.current||confirmDiscard)return;pending.current=true;setBusy(true);setError('');try{await save(values());onClose()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{pending.current=false;setBusy(false)}}
 const change=(id:string,value:unknown)=>setDraft(d=>({...d,[id]:value}))
 return <Dialog title={record?"レコード詳細":tableName!==appName?`新規${tableName}`:"新規レコード"} lede={record?appName:`${appName}に新しいレコードを作成します。`} className={`hx-record-dialog${conversation?' hx-record-with-chat':''}`} onClose={close} footer={<><button className="dlg-btn" disabled={busy} onClick={close}>キャンセル</button><button className="dlg-btn primary" form="hx-record-form" type="submit" disabled={busy}>{busy?(record?'保存中…':'作成中…'):(record?'保存':'作成')}</button></>}>
  <div className="hx-record-columns"><form id="hx-record-form" ref={form} onSubmit={e=>void submit(e)} className="hx-record-form">
   {columns.map((c,i)=>c.type==='relation'
    ? <div key={c.id} className="hx-record-field"><span className="dlg-label">{c.name}</span><AppRelationPicker column={c} value={draft[c.id]} rows={relationEntities.find(item=>item.key===c.targetEntity)?.rows} targetColumn={relationEntities.find(item=>item.key===c.targetEntity)?.table.columns[0]} disabled={busy} onChange={value=>change(c.id,value)}/></div>
    : c.type==='person'
    ? <div key={c.id} className="hx-record-field"><span className="dlg-label">{c.name}</span><AppPersonPicker label={c.name} value={String(draft[c.id]??'')} members={members} ready={membersReady} disabled={busy} onChange={value=>change(c.id,value)}/></div>
    : <label key={c.id}><span className="dlg-label">{c.name}</span>{c.type==='checkbox'?<input type="checkbox" checked={Boolean(draft[c.id])} disabled={busy} onChange={e=>change(c.id,e.target.checked)}/>:c.type==='select'?<select className="dlg-input" disabled={busy} value={String(draft[c.id]??'')} onChange={e=>change(c.id,e.target.value)}><option value="">{c.name}を選択</option>{draft[c.id] && !(c.options||[]).includes(String(draft[c.id])) ? <option value={String(draft[c.id])}>{String(draft[c.id])}</option>:null}{(c.options||[]).map(o=><option key={o}>{o}</option>)}</select>:c.type==='text'?<textarea className="dlg-input" rows={i===0?3:2} maxLength={5000} disabled={busy} value={String(draft[c.id]??'')} onChange={e=>change(c.id,e.target.value)}/>:<input className="dlg-input" type={c.type==='number'?'number':c.type==='date'?'date':c.type==='email'?'email':c.type==='url'?'url':'text'} step={c.type==='number'?'any':undefined} disabled={busy} value={String(draft[c.id]??'')} onChange={e=>change(c.id,e.target.value)}/>}</label>)}
   {record&&<dl className="hx-record-metadata"><div><dt>ID</dt><dd>{record.id}</dd></div><div><dt>作成日時</dt><dd>{record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'}</dd></div><div><dt>更新日時</dt><dd>{new Date(record.updatedAt).toLocaleString()}</dd></div></dl>}
   {error&&<p role="alert" className="dlg-error">{error}</p>}
  </form>{conversation}</div>
  {confirmDiscard&&<Dialog title={t('Discard unsaved record changes?')} lede={t('Your record changes have not been saved.')} onClose={()=>setConfirmDiscard(false)} footer={<><button className="dlg-btn" onClick={()=>setConfirmDiscard(false)}>{t('Keep editing')}</button><button className="dlg-btn primary" onClick={onClose}>{t('Discard changes')}</button></>}>{null}</Dialog>}
 </Dialog>
}
