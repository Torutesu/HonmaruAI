import React,{useCallback,useEffect,useRef,useState} from 'react'
import type {Gateway,HarnessApi,Step} from '../utils/harness'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'

export function WorkflowProgramEditor({api,step,onChange}:{api:HarnessApi;step:Step;onChange:(step:Step)=>void}) {
 const t=useT(),generation=useRef(0)
 const [nodes,setNodes]=useState<Gateway[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const load=useCallback(async()=>{
  const token=++generation.current;setBusy(true);setError('')
  try{const result=await api.gateways();if(token===generation.current)setNodes(result.gateways.filter(node=>!node.revokedAt))}
  catch(error){if(token===generation.current){setNodes([]);setError(error instanceof Error?error.message:String(error))}}
  finally{if(token===generation.current)setBusy(false)}
 },[api])
 useEffect(()=>{void load();return()=>{generation.current++}},[load])
 const bytes=new TextEncoder().encode(step.code||'').length
 return <section className="hx-program-editor">
  <div className="hx-program-toolbar"><strong><Icon name="code" size={16}/> {t('TypeScript program')}</strong><span>workflow.ts</span></div>
  <p className="row-sub">{t('Runs from the top of the file. Exported functions are not called automatically.')}</p>
  <label className="hx-inline">{t('Execution node')} <select aria-label={t('Execution node')} disabled={busy} value={step.gatewayId||''} onChange={event=>onChange({...step,gatewayId:event.target.value})}>
   <option value="">{t('Choose an execution node')}</option>
   {step.gatewayId&&!nodes.some(node=>node.id===step.gatewayId)&&<option value={step.gatewayId}>{t('Selected node unavailable')}</option>}
   {nodes.map(node=><option key={node.id} value={node.id}>{node.name}</option>)}
  </select><button className="btn-text" type="button" disabled={busy} onClick={()=>void load()}>{t('Refresh')}</button></label>
  {busy&&<p role="status">{t('Loading…')}</p>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  {!busy&&!error&&!nodes.length&&<p className="row-sub">{t('Connect an execution node in Settings to run this program.')}</p>}
  <textarea className="hx-program-source hx-program-input" aria-label={t('TypeScript source')} spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={18} value={step.code||''} onChange={event=>onChange({...step,code:event.target.value})}/>
  <div className="hx-program-toolbar"><span>{t('Saved state is available through @honmaru/workflow-sdk.')}</span><span>{bytes.toLocaleString()} / 48,000 B</span></div>
  {bytes>48000&&<p className="form-error" role="alert">{t('Program source exceeds 48 KB.')}</p>}
 </section>
}
