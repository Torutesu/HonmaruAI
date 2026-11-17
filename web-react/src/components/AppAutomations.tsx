import {MAX_PREVIEW_SOURCE} from '../utils/customAppLimits'
import React, {useEffect, useMemo, useRef, useState} from 'react'
import {Icon} from './Icon'
import {StepEditor, type AgentFace} from './WorkflowStepEditor'
import {AutomationTriggerEditor,type TriggerAppOption} from './AutomationTriggerEditor'
import {AutomationRuns} from './AutomationRuns'
import {AutomationSummary} from './AutomationSummary'
import type {App, AppAutomationState, AutomationBundle, HarnessApi, Workflow, Table, Trigger, Column} from '../utils/harness'
import {useT} from '../utils/i18n'

const removedTriggerConditions=(before:Trigger,after:Trigger,columns:Column[]|undefined)=>{
  const prior=before.type==='row'?before.where:before.type==='app_record_change'?before.when?.where:undefined
  const next=after.type==='row'?after.where:after.type==='app_record_change'?after.when?.where:undefined
  if(before.type==='row'&&before.column&&(after.type!=='row'||!after.column))return true
  const sameSource=before.type===after.type&&(before.type==='row'?before.tableId===after.tableId:
    before.type==='app_record_change'?before.appId===after.appId&&before.entityId===after.entityId:true)
  if(!sameSource)return Boolean(prior&&Object.keys(prior).length)
  // Count aliases per resolved column: two predicates on one column are ANDed
  // by the Worker, but rewriting one name as its ID does not remove a filter.
  const identity=(key:string)=>{const column=columns?.find(column=>column.id===key||column.name.toLowerCase()===key.toLowerCase());return column?`column:${column.id}`:`unresolved:${key}`}
  const remaining=new Map<string,number>()
  for(const key of Object.keys(next||{})){const id=identity(key);remaining.set(id,(remaining.get(id)||0)+1)}
  return Object.keys(prior||{}).some(key=>{const id=identity(key),count=remaining.get(id)||0;if(!count)return true;remaining.set(id,count-1);return false})
}

export function AppAutomations({app,api,reload,orgId}:{app:App;api:HarnessApi;reload:()=>unknown;orgId?:string}) {
  const t=useT()
  const [prompt,setPrompt]=useState('')
  const [state,setState]=useState<AppAutomationState|null>(null)
  const [previewGate,setPreviewGate]=useState<Awaited<ReturnType<HarnessApi['customPublishState']>>|null>(null)
  const [draft,setDraft]=useState<AutomationBundle>({version:1,items:[]})
  const [draftGeneration,setDraftGeneration]=useState(0)
  const [tables,setTables]=useState<Table[]>([]),[agents,setAgents]=useState<AgentFace[]>([])
  const [triggerApps,setTriggerApps]=useState<TriggerAppOption[]>([])
  const choiceScope=useMemo(()=>({appId:app.id,api}),[app.id,api]),choiceRequest=useRef(0),choicePending=useRef<{scope:typeof choiceScope}|null>(null)
  const [choiceState,setChoiceState]=useState<{scope:typeof choiceScope;status:'loading'|'ready'|'error';items:Workflow[]}>({scope:choiceScope,status:'loading',items:[]}),[selected,setSelected]=useState('')
  const [retryScope,setRetryScope]=useState<typeof choiceScope|null>(null)
  const choiceCurrent=choiceState.scope===choiceScope,choices=choiceCurrent?choiceState.items:[],choiceStatus=choiceCurrent?choiceState.status:'loading',selectedChoice=choiceCurrent?selected:''
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  // The server keeps only a digest of a webhook secret, so the release that
  // created it is the one chance to show it.
  const [webhookSecrets,setWebhookSecrets]=useState<{key:string;workflowId:string;secret:string}[]>([])
  const [checked,setChecked]=useState<string[]>([]),[includeSource,setIncludeSource]=useState(false)
  const pending=useRef<{fingerprint:string;requestId:string}|null>(null)
  const generation=useRef(0)
  const statusLabels:Record<string,string>={added:t('Added'),changed:t('Changed'),unchanged:t('Unchanged'),removed:t('Unpublished'),retired:t('Stopped'),drifted:t('Changed elsewhere'),missing:t('Workflow deleted')}
  const refresh=async()=>{
    const current=++generation.current
    setDraftGeneration(value=>value+1)
    let result:AppAutomationState,warning=''
    try {result=await api.appAutomations(app.id)} catch(e) {result=await api.appAutomations(app.id,true);warning=e instanceof Error?e.message:String(e)}
    if(current!==generation.current)return
    setState(result);setDraft(result.draft);setChecked([]);setError(warning)
  }
  useEffect(()=>{if(state && JSON.stringify(draft)!==JSON.stringify(state.draft) && state.version!==app.version){setError(t('The app changed elsewhere. Your unsaved draft is preserved. Copy its contents before reloading.'));return}void refresh().catch(e=>setError(String(e)));void api.tables?.().then(r=>setTables(r.tables)).catch(()=>{});if(api.appDatabase)void api.appDatabase(app.id).then(database=>setTriggerApps([{app:{id:app.id,name:app.name},entities:database.entities}])).catch(()=>setTriggerApps([]));void api.workflowAgents?.().then(r=>setAgents(r.agents)).catch(()=>{});return()=>{generation.current++}},[app.id,app.name,app.version,api])
  useEffect(()=>{let active=true;if(typeof api.customPublishState!=='function'){setPreviewGate(null);return()=>{active=false}}void api.customPublishState(app.id).then(result=>{if(active)setPreviewGate(result)}).catch(()=>{if(active)setPreviewGate(null)});return()=>{active=false}},[api,app.id,app.version,app.definition.custom?.draft])
  const loadChoices=async(force=false)=>{
    if(!force&&choicePending.current?.scope===choiceScope)return
    const operation={scope:choiceScope};choicePending.current=operation
    const request=++choiceRequest.current
    if(!choiceCurrent)setSelected('')
    setChoiceState(previous=>({scope:choiceScope,status:'loading',items:previous.scope===choiceScope?previous.items:[]}))
    try{
      const result=await api.workflows()
      if(choiceRequest.current!==request)return
      setSelected(current=>result.workflows.some(workflow=>workflow.id===current)?current:'')
      setChoiceState({scope:choiceScope,status:'ready',items:result.workflows})
    }catch{
      if(choiceRequest.current===request){setRetryScope(choiceScope);setChoiceState({scope:choiceScope,status:'error',items:[]})}
    }finally{if(choicePending.current===operation)choicePending.current=null}
  }
  useEffect(()=>{void loadChoices(true);return()=>{choiceRequest.current++;choicePending.current=null}},[choiceScope,app.name,app.version])
  const moveStep=(key:string,index:number,direction:number)=>{
    setDraft(current=>({...current,items:current.items.map(item=>{
      if(item.key!==key || index+direction<0 || index+direction>=item.steps.length)return item
      const steps=[...item.steps];[steps[index],steps[index+direction]]=[steps[index+direction],steps[index]]
      return {...item,steps}
    })}))
    setNotice(t('Step order changed. Check any inputs that refer to step numbers.'))
  }
  const dirty=state && JSON.stringify(draft)!==JSON.stringify(state.draft)
  const triggerColumns=(trigger:Trigger)=>trigger.type==='row'?tables.find(table=>table.id===trigger.tableId)?.columns:
    trigger.type==='app_record_change'?triggerApps.find(option=>option.app.id===trigger.appId)?.entities.find(entity=>entity.key===trigger.entityId)?.table.columns:undefined
  const removedConditions=state?.draft.items.some(previous=>{
    const current=draft.items.find(item=>item.key===previous.key)
    if(!current)return false
    return removedTriggerConditions(previous.trigger,current.trigger,triggerColumns(previous.trigger))
  })
  const removedPublishedConditions=state?.plan?.some(item=>{
    const baseline=item.live||item.published
    const current=draft.items.find(candidate=>candidate.key===item.key)
    return baseline&&current&&removedTriggerConditions(baseline.trigger,current.trigger,triggerColumns(baseline.trigger))
  })
  const conflicts=state?.plan?.filter(item=>item.status==='drifted'||item.status==='missing')||[]
  const sourceTooLarge=includeSource && (app.definition.custom?.draft?.length || 0)>MAX_PREVIEW_SOURCE
  const canPublish=!sourceTooLarge && (!includeSource || Boolean(previewGate?.candidate?.current&&previewGate.candidate.sourceHash===previewGate.sourceHash)) && state && state.version===app.version && state.revision>0 && state.plan && !dirty && conflicts.every(item=>checked.includes(item.key) && item.workflowId && (item.status!=='missing'||item.declared))
  const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{await fn()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  const release=async(action:'publish'|'unpublish')=>{
    if(!state)return
    const body={action,version:state.version,revision:state.revision,includeSource:action==='publish'&&includeSource,candidateId:action==='publish'&&includeSource?previewGate?.candidate?.id:undefined,reviewed:action==='publish'?conflicts.map(item=>({key:item.key,workflowId:item.workflowId,action:item.status==='missing'?'recreate':'replace',live:item.live})):[]}
    const fingerprint=JSON.stringify(body)
    if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,requestId:crypto.randomUUID()}
    setWebhookSecrets([])
    const result=await api.releaseAppAutomations(app.id,{...body,requestId:pending.current.requestId})
    pending.current=null;setWebhookSecrets(result?.webhookSecrets||[]);await refresh();await reload();setNotice(action==='publish'?t('Reviewed automations published.'):t('Automations unpublished.'))
  }
  return <section className="hx-app-automations" aria-label={t('App automations')}>
    <header><h3><Icon name="workflow" size={18}/> {t('Automations')}</h3><span>{state?.published?t('Published'):t('Draft')}</span></header>
    <p>{t('Save a draft, review its changes, then publish the work that runs with this app.')}</p>
    {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {webhookSecrets.length>0&&<div className="form-note" role="status"><p>{t('Webhook secrets are shown only once. Send them in the X-Hook-Secret header.')}</p>{webhookSecrets.map(item=><p key={item.workflowId}>{draft.items.find(value=>value.key===item.key)?.name||item.key}: <code className="hx-code">{item.secret}</code></p>)}</div>}
    {state && state.version!==app.version && <button className="pill-btn quiet" disabled={busy} onClick={()=>void run(refresh)}>{dirty?t('Discard unsaved changes and reload'):t('Reload latest')}</button>}
    {!state?<button disabled={busy} onClick={()=>void run(refresh)}>{t('Reload')}</button>:<>
      <form onSubmit={e=>{e.preventDefault();void run(async()=>{const result=await api.generateAppAutomation(app.id,prompt,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');setDraft({...draft,items:[...draft.items,result.automation]});setPrompt('');setNotice(t('Review the generated draft and save it. It will not run yet.'))})}}><label>{t('Describe the automation')}<textarea value={prompt} maxLength={4000} disabled={busy} onChange={e=>setPrompt(e.target.value)} placeholder={t('e.g. Every Monday at 9am, ask the assigned agent to review sales data')}/></label><button className="pill-btn" disabled={busy||!prompt.trim()||draft.items.length>=12}>{t('Generate automation')}</button></form>
      <div className="hx-actions"><select aria-label={t('Copy a workflow')} value={selectedChoice} disabled={choiceStatus!=='ready'} onChange={e=>setSelected(e.target.value)}><option value="">{t('Create a draft from a workflow')}</option>{choices.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="pill-btn quiet" disabled={busy||choiceStatus!=='ready'||!selectedChoice||draft.items.length>=12} onClick={()=>{const w=choices.find(w=>w.id===selectedChoice);if(w)setDraft({...draft,items:[...draft.items,{key:`auto_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`,name:w.name,enabled:false,trigger:w.trigger,steps:w.steps}]});setSelected('')}}>{t('Add to draft')}</button></div>
      {choiceStatus==='loading'&&<p role="status">{t('Loading workflows…')}</p>}
      {choiceStatus==='error'&&<p role="alert">{t('Could not load workflows. Your draft is preserved.')}</p>}
      {(choiceStatus==='error'||retryScope===choiceScope)&&<button type="button" className="pill-btn quiet" aria-disabled={choiceStatus==='loading'} onClick={()=>{if(choiceStatus==='loading')return;setRetryScope(choiceScope);void loadChoices()}}>{t('Reload workflows')}</button>}
      {choiceStatus==='ready'&&choices.length===0&&<p>{t('There are no workflows to copy yet.')}</p>}
      <button className="pill-btn quiet" disabled={busy||draft.items.length>=12} onClick={()=>setDraft({...draft,items:[...draft.items,{key:`auto_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`,name:t('New automation'),enabled:false,trigger:{type:'manual'},steps:[{type:'post'}]}]})}><Icon name="plus" size={14}/> {t('Create automation')}</button>
      {draft.items.length===0&&<p>{t('No automations yet. Create one or copy the steps from an existing workflow.')}</p>}
      {draft.items.map(item=><div className="hx-step" key={item.key}><label>{t('Name')}<input value={item.name} maxLength={80} disabled={busy} onChange={e=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,name:e.target.value}:v)})}/></label><label><input type="checkbox" checked={item.enabled} disabled={busy} onChange={e=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,enabled:e.target.checked}:v)})}/>{t('Enable after publishing')}</label><p>{item.trigger.type==='schedule'?t('Schedule'):item.trigger.type==='row'?t('Data change'):item.trigger.type==='app_record_change'?t('App record change'):item.trigger.type==='webhook'?t('Webhook'):t('Manual run')} · {t('{count} steps',{count:item.steps.length})}</p><details><summary>{t('Edit trigger and steps')}</summary><fieldset disabled={busy}><AutomationTriggerEditor key={`${item.key}:${draftGeneration}`} trigger={item.trigger} tables={tables} apps={triggerApps} onChange={trigger=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,trigger}:v)})}/>{item.steps.map((step,index)=><div key={index}><div className="hx-actions"><button type="button" className="pill-btn quiet" disabled={busy||index===0} aria-label={t('Move step {number} up',{number:index+1})} onClick={()=>moveStep(item.key,index,-1)}><Icon name="arrow-up" size={14}/></button><button type="button" className="pill-btn quiet" disabled={busy||index===item.steps.length-1} aria-label={t('Move step {number} down',{number:index+1})} onClick={()=>moveStep(item.key,index,1)}><Icon name="arrow-down" size={14}/></button></div><StepEditor api={api} step={step} tables={tables} agents={agents} previousStepType={index>0?item.steps[index-1]?.type:undefined} triggerTable={tables.find(t=>t.id===item.trigger.tableId)||triggerApps.find(option=>option.app.id===item.trigger.appId)?.entities.find(entity=>entity.key===item.trigger.entityId)?.table} onChange={step=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,steps:v.steps.map((s,i)=>i===index?step:s)}:v)})} onRemove={()=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,steps:v.steps.filter((_,i)=>i!==index)}:v)})}/></div>) }{!item.steps.some(step=>step.type==='code')&&<button className="pill-btn quiet" onClick={()=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,steps:[...v.steps,{type:'post'}]}:v)})}>{t('Add step')}</button>}</fieldset></details><button className="pill-btn quiet" disabled={busy} onClick={()=>setDraft({...draft,items:draft.items.filter(v=>v.key!==item.key)})}>{t('Remove from draft')}</button></div>)}
      {removedConditions&&<p role="alert">{t('Conditions were removed from this draft. Publishing may broaden the affected records. Review before saving and publishing.')}</p>}
      <button className="pill-btn" disabled={busy||!dirty||state.version!==app.version} onClick={()=>void run(async()=>{setDraftGeneration(value=>value+1);await api.saveAppAutomations(app.id,state.version,state.revision,draft);await refresh();setNotice(t('Draft saved. Published automations are unchanged.'))})}>{t('Save draft')}</button>
      <h4>{t('Changes to publish')}</h4>{removedPublishedConditions&&<p role="alert">{t('A condition or monitored column was removed from a published automation. Publishing may broaden the affected records.')}</p>}{dirty?<p>{t('Save the draft to review its differences from published automations.')}</p>:state.plan?.map(item=><details key={item.key}><summary>{item.declared?.name||item.published?.name||item.key} · {statusLabels[item.status]}</summary><div className="hx-automation-diff"><div><strong>{t('Current')}</strong><AutomationSummary definition={item.live} tables={tables} agents={agents} apps={triggerApps}/></div><div><strong>{t('After publishing')}</strong><AutomationSummary definition={item.declared} tables={tables} agents={agents} apps={triggerApps}/></div></div>{item.workflowId&&item.status!=='missing'&&<AutomationRuns key={item.workflowId} workflowId={item.workflowId} api={api} orgId={orgId}/>} {conflicts.includes(item)&&<label><input type="checkbox" disabled={busy} checked={checked.includes(item.key)} onChange={e=>setChecked(e.target.checked?[...checked,item.key]:checked.filter(k=>k!==item.key))}/>{item.status==='missing'?t('Restore this automation'):t('Review the current change and replace it with the app definition')}</label>}</details>)}
      {app.definition.custom&&<label><input type="checkbox" checked={includeSource} disabled={busy} onChange={e=>setIncludeSource(e.target.checked)}/>{t('Publish the saved app screen too')}</label>}
      {includeSource&&<p role={previewGate?.candidate?.current?'status':'alert'}>{previewGate?.candidate?.current?t('The reviewed app screen preview will publish with the automation.'):t('Open the custom app preview first, verify it with the test database, then choose “Mark this preview as reviewed.”')}</p>}
      {sourceTooLarge&&<p role="alert" className="form-error">{t('Shorten the app screen code to 119,800 characters or fewer to publish it with the automation.')}</p>}
      <div className="hx-actions"><button className="pill-btn" disabled={busy||!canPublish} onClick={()=>void run(()=>release('publish'))}>{t('Publish reviewed changes')}</button>{state.published&&<button className="pill-btn quiet" disabled={busy} onClick={()=>void run(()=>release('unpublish'))}>{t('Stop automations')}</button>}</div>
    </>}
  </section>
}
