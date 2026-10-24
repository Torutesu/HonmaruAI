import React,{useCallback,useEffect,useRef,useState} from 'react'
import type {HarnessApi,Run} from '../utils/harness'
import {getLocale} from '../utils/locale'
const labels:Record<string,string>={done:'完了',running:'実行中',waiting:'承認待ち',failed:'失敗',declined:'却下',ok:'成功',cancelled:'キャンセル'}
export function runDuration(run: Pick<Run,'status'|'startedAt'|'finishedAt'>): string | null {
 if(!['done','failed','declined','cancelled'].includes(run.status)||!run.finishedAt)return null
 const elapsed=Date.parse(run.finishedAt)-Date.parse(run.startedAt)
 if(!Number.isFinite(elapsed)||elapsed<0)return null
 let locale=getLocale()
 try{new Intl.NumberFormat(locale)}catch{locale='en'}
 const seconds=elapsed/1000
 const units: Array<[number,'hour'|'minute'|'second']> = seconds<60
  ? [[seconds,'second']]
  : seconds<3600 ? [[Math.floor(seconds/60),'minute'],[Math.floor(seconds%60),'second']]
  : [[Math.floor(seconds/3600),'hour'],[Math.floor(seconds%3600/60),'minute']]
 return units.map(([value,unit])=>new Intl.NumberFormat(locale,{style:'unit',unit,unitDisplay:'short',maximumFractionDigits:unit==='second'&&seconds<60?1:0}).format(value)).join(' ')
}
export function AutomationRuns({workflowId,api}:{workflowId:string;api:HarnessApi}) {
 const [runs,setRuns]=useState<Run[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[isOpen,setIsOpen]=useState(false)
 const request=useRef(0),pending=useRef<number|null>(null),opened=useRef(false)
 const load=useCallback(async()=>{
  if(pending.current!==null)return
  const current=++request.current;pending.current=current;setBusy(true);setError('')
  try{const result=await api.workflow(workflowId);if(current===request.current)setRuns(result.runs)}
  catch(e){if(current===request.current){setRuns(null);setError(e instanceof Error?e.message:String(e))}}
  finally{if(pending.current===current)pending.current=null;if(current===request.current)setBusy(false)}
 },[workflowId,api])
 useEffect(()=>{
  request.current++;pending.current=null;setRuns(null);setError('');setBusy(false)
  if(opened.current)void load()
  return ()=>{request.current++}
 },[load])
 useEffect(()=>{
  if(!isOpen||busy||error||!runs?.some(run=>run.status==='running'||run.status==='waiting'))return
  const timer=setTimeout(()=>void load(),10000)
  return ()=>clearTimeout(timer)
 },[isOpen,busy,error,runs,load])
 return <details onToggle={e=>{opened.current=e.currentTarget.open;setIsOpen(opened.current);if(opened.current && runs===null && !busy)void load()}}><summary>実行履歴</summary>
  {busy&&<p role="status">実行履歴を読み込み中…</p>}{error&&<p role="alert">{error}</p>}
  {runs?.length===0&&<p>まだ実行されていません。</p>}
  {runs?.map(run=><details key={run.id}><summary>{new Date(run.startedAt).toLocaleString(getLocale())} · {labels[run.status]||run.status}{runDuration(run)!==null&&<> · <span title="開始から終了まで（承認待ち時間を含む）">{runDuration(run)}</span></>}</summary>
   <ol>{run.log.map((entry,index)=><li key={index}><strong>{entry.step}. {labels[entry.status]||entry.status}</strong>{entry.error&&<p className="form-error">{entry.error}</p>}{entry.output&&<pre>{entry.output}</pre>}</li>)}</ol>
   <small>実行ID: {run.id}</small>
  </details>)}
  <button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>void load()}>{error?'再試行':'履歴を更新'}</button>
 </details>
}
