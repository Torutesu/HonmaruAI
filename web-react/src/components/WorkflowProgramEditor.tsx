import React,{useCallback,useEffect,useRef,useState} from 'react'
import type {App,AppEntity,Gateway,HarnessApi,Step} from '../utils/harness'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'

export function WorkflowProgramEditor({api,step,onChange,sourceApps=[]}:{api:HarnessApi;step:Step;onChange:(step:Step)=>void;sourceApps?:Array<{app:App;entities:AppEntity[]}>}) {
 const t=useT(),generation=useRef(0)
 const lineNumbers=useRef<HTMLPreElement>(null)
 const [nodes,setNodes]=useState<Gateway[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const load=useCallback(async()=>{
  const token=++generation.current;setBusy(true);setError('')
  try{const result=await api.gateways();if(token===generation.current)setNodes(result.gateways.filter(node=>!node.revokedAt))}
  catch(error){if(token===generation.current){setNodes([]);setError(error instanceof Error?error.message:String(error))}}
  finally{if(token===generation.current)setBusy(false)}
 },[api])
 useEffect(()=>{void load();return()=>{generation.current++}},[load])
 const bytes=new TextEncoder().encode(step.code||'').length
 const lineCount=(step.code||'').split('\n').length
 const selectedApp=sourceApps.find(choice=>choice.app.id===step.sourceAppId)
 const selectedSources=step.sourceTables??(step.sourceEntityId&&step.sourceTableId?[{entityId:step.sourceEntityId,tableId:step.sourceTableId}]:[])
 const selectedEntityIds=new Set(selectedSources.map(source=>source.entityId))
 const setSources=(entityIds:string[])=>{
  const entities=selectedApp?.entities.filter(entity=>entityIds.includes(entity.key))??[]
  if(!selectedApp||!entities.length){onChange({...step,sourceAppId:undefined,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:undefined});return}
  const sources=entities.map(entity=>({entityId:entity.key,tableId:entity.table.id,...(selectedSources.find(source=>source.entityId===entity.key)?.write?{write:true}:{})}))
  if(sources.length===1)onChange({...step,sourceAppId:selectedApp.app.id,sourceEntityId:sources[0].entityId,sourceTableId:sources[0].tableId,sourceTables:undefined})
  else onChange({...step,sourceAppId:selectedApp.app.id,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:sources})
 }
 const setSourceWrite=(entityId:string,write:boolean)=>{
  if(!selectedApp)return
  const sources=selectedApp.entities.filter(item=>selectedEntityIds.has(item.key)).map(item=>({entityId:item.key,tableId:item.table.id,...(item.key===entityId?write?{write:true}:{ }:selectedSources.find(source=>source.entityId===item.key)?.write?{write:true}:{})}))
  onChange({...step,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:sources})
 }
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
  <label className="hx-inline">{t('App/Table source')} <select aria-label={t('App/Table source')} value={step.sourceAppId||''} onChange={event=>{
   const choice=sourceApps.find(item=>item.app.id===event.target.value),entity=choice?.entities[0]
   onChange({...step,...(choice&&entity?{sourceAppId:choice.app.id,sourceEntityId:entity.key,sourceTableId:entity.table.id,sourceTables:undefined}:{sourceAppId:undefined,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:undefined})})
  }}>
   <option value="">{t('No App/Table source')}</option>
   {step.sourceAppId&&!selectedApp&&<option value={step.sourceAppId}>{t('Selected App unavailable')}</option>}
   {sourceApps.map(choice=><option key={choice.app.id} value={choice.app.id}>{choice.app.name}</option>)}
  </select></label>
  {step.sourceAppId&&<fieldset className="hx-program-sources" aria-label={t('Authorized App entities')}>
   <legend>{t('Authorized App entities')}</legend>
   {selectedApp?.entities.map(entity=><div key={entity.key}><label><input type="checkbox" aria-label={`${t('Include entity')}: ${entity.table.name}`} checked={selectedEntityIds.has(entity.key)} disabled={!selectedEntityIds.has(entity.key)&&selectedEntityIds.size>=20} onChange={event=>setSources(event.target.checked?[...selectedEntityIds,entity.key]:[...selectedEntityIds].filter(key=>key!==entity.key))}/>{entity.table.name}</label>{selectedEntityIds.has(entity.key)&&<label><input type="checkbox" aria-label={`${t('Allow row creation')}: ${entity.table.name}`} checked={selectedSources.find(source=>source.entityId===entity.key)?.write===true} onChange={event=>setSourceWrite(entity.key,event.target.checked)}/>{t('Allow row creation')}</label>}</div>)}
   {!selectedApp&&selectedSources.map(source=><label key={source.entityId}><input type="checkbox" checked disabled readOnly/>{t('Selected entity unavailable')} · {source.entityId}</label>)}
   {selectedApp&&selectedSources.some(source=>!selectedApp.entities.some(entity=>entity.key===source.entityId))&&<p role="alert">{t('Some selected entities are unavailable. Repair the source before saving.')}</p>}
   {!selectedSources.length&&<p role="alert">{t('Choose at least one App entity.')}</p>}
  </fieldset>}
  <p className="row-sub">{t('The table.query helper reads saved App entities. table.insert stages rows only for entities with Allow row creation enabled, and commits them only after the program succeeds. No VM network or database access is enabled.')}</p>
  <div className="hx-program-code" style={{'--program-gutter':`${Math.max(2,String(lineCount).length)+2}ch`} as React.CSSProperties}>
   <div className="hx-program-gutter" aria-hidden="true"><pre ref={lineNumbers}>{Array.from({length:lineCount},(_,index)=>index+1).join('\n')}</pre></div>
   <textarea className="hx-program-source hx-program-input" aria-label={t('TypeScript source')} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" rows={18} value={step.code||''} onScroll={event=>{if(lineNumbers.current)lineNumbers.current.style.transform=`translateY(-${event.currentTarget.scrollTop}px)`}} onChange={event=>onChange({...step,code:event.target.value})}/>
  </div>
  <div className="hx-program-toolbar"><span>{t('Saved state is available through @honmaru/workflow-sdk.')}</span><span>{t('Use parallel and pipeline for bounded batches; failed items return null and call onError.')}</span><span>{t('table.query reads and table.insert creates rows within the saved App/Table permissions.')}</span><span>{t('sendMessage(text) stages a report draft in run history; it never posts to a Room.')}</span><span>{t('Workflow programs can run for up to 15 minutes.')}</span><span>{bytes.toLocaleString()} / 48,000 B</span></div>
  {bytes>48000&&<p className="form-error" role="alert">{t('Program source exceeds 48 KB.')}</p>}
 </section>
}
