import React,{useEffect,useRef,useState} from 'react'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'
import type {HarnessApi,WorkflowSourceState} from '../utils/harness'
export function WorkflowSource({api,workflowId}:{api:HarnessApi;workflowId:string}){
 const t=useT(),sequence=useRef(0),pending=useRef(false)
 const [state,setState]=useState<WorkflowSourceState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState('')
 useEffect(()=>{sequence.current++;pending.current=false;setState(null);setSelected('');setError('');setBusy(false);return()=>{sequence.current++}},[api,workflowId])
 const act=async(messageId?:string,more=false)=>{
  if(pending.current)return
  const current=++sequence.current;pending.current=true;setBusy(true);setError('')
  try{
   const result=messageId?await api.bindWorkflowSource(workflowId,messageId):await api.workflowSource(workflowId,more?state?.nextCursor||undefined:undefined)
   if(current===sequence.current){setState(old=>more&&old?{...result,candidates:[...old.candidates,...result.candidates]}:result);setSelected('')}
  }catch(e){if(current===sequence.current){setState(null);setSelected('');setError(e instanceof Error?e.message:String(e))}}
  finally{if(current===sequence.current){pending.current=false;setBusy(false)}}
 }
 return <details className="hx-workflow-source" onToggle={e=>{if(e.currentTarget.open&&!state&&!busy&&!error)void act()}}><summary>{t('Automation source thread')}</summary>
  {busy&&<p role="status">{t('Loading…')}</p>}{error&&<p role="alert" className="form-error">{error}</p>}
  {state?.source?<><p>{state.source.body}</p><p className="form-note">{t('Failure notices are sent to this thread.')}</p></>:state&&<>
   <p className="form-note">{t('Choose the thread where this automation was created. Failure notices will be posted there. This choice is fixed after saving.')}</p>
   {!state.canBind?<p>{t('Only the creator can choose the source thread.')}</p>:<>
    <div className="rows">{state.candidates.map(root=><label className="row static" key={root.id}><input type="radio" name={'workflow-source-'+workflowId} checked={selected===root.id} disabled={busy} onChange={()=>setSelected(root.id)}/><span className="row-main">{root.body}<small className="row-sub">{new Date(root.createdAt).toLocaleString(getLocale())}</small></span></label>)}</div>
    {!state.candidates.length&&<p>{t('No accessible threads on this page.')}</p>}
    {state.nextCursor&&<button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>void act(undefined,true)}>{t('Load older threads')}</button>}
    <button type="button" className="pill-btn" disabled={busy||!selected} onClick={()=>void act(selected)}>{t('Use selected thread')}</button>
   </>}
  </>}
  <button type="button" className="btn-text" disabled={busy} onClick={()=>void act()}>{t('Refresh')}</button>
 </details>
}
