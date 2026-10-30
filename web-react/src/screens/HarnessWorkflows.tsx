import {WorkflowProgramEditor} from '../components/WorkflowProgramEditor'
import {WorkflowHistory} from '../components/WorkflowHistory'
import {describeWorkflowCondition} from '../utils/workflowCondition'
import {getLocale} from '../utils/locale'
import {runDuration} from '../utils/runDuration'
import {groupRunsByStartDay,runDayLabel,runTimestampLabel} from '../utils/runHistory'
import {stepLabel,triggerLabel,type WorkflowAppOption} from '../utils/workflowLabels'
import {WorkflowRunUsage} from '../components/WorkflowRunUsage'
import {WorkflowSource} from '../components/WorkflowSource'
import {WorkflowNotices} from '../components/WorkflowNotices'
import {ScheduleTriggerFields} from '../components/ScheduleTriggerFields'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import {StepEditor} from '../components/WorkflowStepEditor'
import type { Workflow, Run, Step, StepType, Trigger, TriggerType, Table, App, ConditionScalar, HeldWorkflowEvents, HarnessApi } from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps } from './HarnessShared'

// Workflows (docs/kylon-gap-plan.md): a trigger and the steps after it,
// built from a form rather than a graph, with every run and every step's
// outcome kept where anyone can read it.

const WEBHOOK_SENDER_EXAMPLE = `const { createHmac, randomUUID } = require('node:crypto')

const endpoint = new URL(process.env.HONMARU_WEBHOOK_URL)
const secret = process.env.HONMARU_WEBHOOK_SECRET
endpoint.searchParams.delete('secret')

const eventId = randomUUID() // Reuse this ID and the same body when retrying
const body = JSON.stringify({ orderId: 'order-123' })
const timestamp = String(Math.floor(Date.now() / 1000))
const signature = createHmac('sha256', secret)
  .update(\`${'${timestamp}.${eventId}.${body}'}\`)
  .digest('hex')

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hook-secret': secret,
    'x-webhook-timestamp': timestamp,
    'x-webhook-event-id': eventId,
    'x-webhook-signature': \`v1=\${signature}\`,
  },
  body,
})
console.log(response.status, await response.json())`

function HeldEventPreview({ receivedAt, load }: { receivedAt: string; load: () => Promise<{ event: { input: unknown } }> }) {
  const t = useT()
  const [payload, setPayload] = useState<{ input: unknown } | null>(null)
  const pending = useRef(false)
  const { busy, error, act } = useAct()
  const readPayload = () => {
    if (payload || pending.current) return
    pending.current = true
    void act('payload', async () => {
      try { setPayload((await load()).event) } finally { pending.current = false }
    })
  }
  return <details className="hx-run-detail" onToggle={event => { if (event.currentTarget.open) readPayload() }}>
    <summary>{new Date(receivedAt).toLocaleString()} · {t('Received payload')}</summary>
    {busy && <p role="status">{t('Loading…')}</p>}
    {error && <div><p role="alert">{error}</p><button type="button" disabled={!!busy} onClick={readPayload}>{t('Retry')}</button></div>}
    {payload && <pre className="hx-held-payload">{JSON.stringify(payload.input, null, 2)}</pre>}
  </details>
}

interface AgentFace { id: string; handle: string; name: string; emoji?: string | null }
interface AppTriggerChoice extends WorkflowAppOption { app: App }

const blankStep = (type: StepType): Step => ({ type, ...(type === 'followup' ? { minutes: 1440 } : {}) })


function Builder({ api, tables, agents, triggerApps, onSave, onCancel, busy, initial }: { api:HarnessApi; initial?: Workflow; tables: Table[]; agents: AgentFace[]; triggerApps:AppTriggerChoice[]; onSave: (w: { name: string; trigger: Trigger; steps: Step[] }) => void; onCancel: () => void; busy: boolean }) {
  const t = useT()
  const [name, setName] = useState(initial?.name || '')
  const [trigger, setTrigger] = useState<Trigger>(initial ? structuredClone(initial.trigger) : { type: 'manual' })
  const [format,setFormat]=useState(initial?.steps[0]?.type==='code'?'code':'form')
  const [formSteps,setSteps]=useState<Step[]>(initial?.steps[0]?.type!=='code'&&initial?structuredClone(initial.steps):[blankStep('post')])
  const [program,setProgram]=useState<Step>(initial?.steps[0]?.type==='code'?structuredClone(initial.steps[0]):{type:'code',code:'console.log("Hello from your workflow");'})
  const steps=format==='code'?[program]:formSteps
  const programValid=format!=='code'||Boolean(program.gatewayId&&program.code?.trim()&&new TextEncoder().encode(program.code).length<=48000)
  const appTriggerValid=trigger.type!=='app_record_change'||Boolean(trigger.appId&&trigger.entityId&&trigger.events?.length)
  const scheduleValid = trigger.type !== 'schedule' || (()=>{
    if (trigger.kind === 'every') return Number.isSafeInteger(trigger.everyMs) && trigger.everyMs! >= 600000 && trigger.everyMs! <= 8640000000000000-Date.now()
    if (trigger.kind === 'at') return Boolean(trigger.at && Number.isFinite(Date.parse(trigger.at)) && Date.parse(trigger.at) > Date.now())
    if (trigger.kind === 'cron') {
      try { new Intl.DateTimeFormat('en',{timeZone:trigger.timezone}); } catch { return false }
      return Boolean(trigger.expr?.trim()) && trigger.expr!.trim().split(/\s+/).length === 5
    }
    try { new Intl.DateTimeFormat('en',{timeZone:trigger.timezone}); } catch { return false }
    return Boolean(trigger.timezone?.trim()) && Number.isInteger(trigger.hour) && trigger.hour!>=0 && trigger.hour!<=23 && Number.isInteger(trigger.minute) && trigger.minute!>=0 && trigger.minute!<=59
  })()
  const table = tables.find((x) => x.id === trigger.tableId)
  const whereCol = table?.columns.find((c) => c.type === 'select')
  const triggerApp = triggerApps.find(option => option.app.id === trigger.appId)
  const triggerEntity = triggerApp?.entities.find(entity => entity.key === trigger.entityId)
  const setAppWhere = (key:string,value:ConditionScalar|ConditionScalar[]|undefined) => {
    const where={...trigger.when?.where}
    if(value===undefined || (Array.isArray(value)&&!value.length)) delete where[key]; else where[key]=value
    setTrigger({...trigger,when:Object.keys(where).length?{where}:undefined})
  }
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
  return (
    <div className="hx-builder">
      <input className="hx-cell-input hx-title-input" placeholder={t('Workflow name')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('Workflow name')} />
      <div className="rows-title">{t('Trigger')}</div>
      <div className="hx-step">
        <select value={trigger.type} onChange={(e) => {
          const type = e.target.value as TriggerType
          setTrigger(type === 'schedule' ? { type, cadence: 'weekdays', hour: 9, minute: 0, timezone: tz } : type === 'row' ? { type, on: 'changed', tableId: tables[0]?.id } : type === 'app_record_change' ? {type,appId:triggerApps[0]?.app.id,entityId:triggerApps[0]?.entities[0]?.key,events:['insert','update']} : { type })
        }} aria-label={t('Trigger')}>
          <option value="manual">{t('By hand')}</option>
          <option value="schedule">{t('On a schedule')}</option>
          <option value="webhook">{t('A webhook')}</option>
          <option value="row">{t('A table row event')}</option>
          <option value="app_record_change">{t('An app record changes')}</option>
        </select>
        {trigger.type === 'schedule' && (
          <><ScheduleTriggerFields trigger={trigger} onChange={setTrigger} legacyDefault="weekdays" />
            {!scheduleValid && <span className="form-error" role="alert">{t('Enter a valid schedule and time zone.')}</span>}
          </>
        )}
        {trigger.type === 'row' && (
          <span className="hx-inline">
            <select value={trigger.tableId || ''} onChange={(e) => setTrigger({ ...trigger, tableId: e.target.value, where: undefined })} aria-label={t('Table')}>
              {tables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <select value={trigger.on} onChange={(e) => setTrigger({ ...trigger, on: e.target.value as Trigger['on'], ...(e.target.value==='deleted'?{where:undefined,column:undefined}:{}) })} aria-label={t('When')}>
              <option value="added">{t('is added')}</option>
              <option value="changed">{t('is changed')}</option>
              <option value="deleted">{t('is deleted')}</option>
              <option value="any">{t('is added or changed')}</option>
            </select>
            {whereCol && trigger.on!=='deleted' && (
              <select value={trigger.where?.[whereCol.id]?.[0] || ''} onChange={(e) => setTrigger({ ...trigger, where: e.target.value ? { [whereCol.id]: [e.target.value] } : undefined })} aria-label={whereCol.name}>
                <option value="">{t('any {column}', { column: whereCol.name })}</option>
                {(whereCol.options || []).map((o) => <option key={o} value={o}>{whereCol.name} = {o}</option>)}
              </select>
            )}
            {trigger.on==='deleted'&&<span className="row-sub">{t('Delete events do not include record fields.')}</span>}
          </span>
        )}
        {trigger.type === 'row' && tables.length === 0 && <div className="row-sub">{t('Build an app first: its table is what a row trigger watches.')}</div>}
        {trigger.type === 'app_record_change' && <span className="hx-inline">
          <select aria-label={t('App')} value={trigger.appId||''} onChange={e=>{const option=triggerApps.find(x=>x.app.id===e.target.value);setTrigger({type:'app_record_change',appId:e.target.value,entityId:option?.entities[0]?.key,events:trigger.events?.length?trigger.events:['insert','update']})}}>
            <option value="">{t('Choose an app')}</option>{triggerApps.map(option=><option key={option.app.id} value={option.app.id}>{option.app.name}</option>)}
          </select>
          <select aria-label={t('Entity')} value={trigger.entityId||''} onChange={e=>setTrigger({...trigger,entityId:e.target.value,when:undefined})}>
            <option value="">{t('Choose an entity')}</option>{triggerApp?.entities.map(entity=><option key={entity.key} value={entity.key}>{entity.table.name}</option>)}
          </select>
          {(['insert','update','delete'] as const).map(event=><label className="hx-inline" key={event}><input type="checkbox" checked={trigger.events?.includes(event)||false} onChange={e=>{const events=new Set(trigger.events||[]);e.target.checked?events.add(event):events.delete(event);setTrigger({...trigger,events:[...events] as Trigger['events']})}}/>{t(event==='insert'?'is added':event==='update'?'is updated':'is deleted')}</label>)}
          {triggerEntity?.table.columns.map(column=><fieldset key={column.id}><legend>{column.name}</legend>{column.type==='select'?<>{(column.options||[]).map(value=><label className="hx-inline" key={value}><input type="checkbox" checked={(trigger.when?.where[column.id] as ConditionScalar[]|undefined)?.includes(value)||false} onChange={e=>{const old=trigger.when?.where[column.id];const values=Array.isArray(old)?old:old===undefined?[]:[old];setAppWhere(column.id,e.target.checked?[...values,value]:values.filter(v=>v!==value))}}/>{value}</label>)}<small>{t('Choose no values to match every value.')}</small></>:column.type==='checkbox'?<label className="hx-inline">{t('Equals')}<select value={trigger.when?.where[column.id]===true?'true':trigger.when?.where[column.id]===false?'false':''} onChange={e=>setAppWhere(column.id,e.target.value===''?undefined:e.target.value==='true')}><option value="">{t('Any value')}</option><option value="true">{t('Checked')}</option><option value="false">{t('Unchecked')}</option></select></label>:<label className="hx-inline">{t('Equals')}<input type={column.type==='number'?'number':column.type==='date'?'date':'text'} value={String(trigger.when?.where[column.id]??'')} onChange={e=>setAppWhere(column.id,e.target.value===''?undefined:column.type==='number'?Number(e.target.value):e.target.value)}/></label>}</fieldset>)}
          {trigger.events?.includes('delete')&&trigger.when?.where&&<span className="row-sub">{t('Delete events have no field data and do not match this condition.')}</span>}
          {!triggerApps.length&&<div className="row-sub">{t('No accessible apps are available for a record trigger.')}</div>}
        </span>}
      </div>
      <label className="hx-inline">{t('Workflow format')} <select aria-label={t('Workflow format')} value={format} onChange={event=>setFormat(event.target.value)}>
        <option value="form">{t('Form steps')}</option><option value="code">{t('TypeScript program')}</option>
      </select></label>
      {format==='code'?<WorkflowProgramEditor api={api} step={program} onChange={setProgram}/>:<>
      <div className="rows-title">{t('Steps')}</div>
      {steps.map((s, i) => (
        <StepEditor
          key={i}
          step={s}
          tables={tables}
          agents={agents}
          triggerTable={trigger.type === 'row' ? table : trigger.type === 'app_record_change' ? triggerEntity?.table : undefined}
          onChange={(next) => setSteps(steps.map((x, j) => (j === i ? next : x)))}
          onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
        />
      ))}
      <button className="pill-btn quiet" onClick={() => setSteps([...steps, blankStep('post')])}><Icon name="plus" size={14} /> {t('Add a step')}</button>
      <p className="hx-hint">{t('Steps can use what started them: {{row.Column}}, {{input.text}}, {{steps.1.output}}.')}</p>
      </>}
      <div className="playbook-add-foot">
        <button className="btn-text" onClick={onCancel}>{t('Cancel')}</button>
        <button className="pill-btn" disabled={busy || !name.trim() || steps.length === 0 || !scheduleValid || !programValid || !appTriggerValid} onClick={() => onSave({ name, trigger, steps })}>{t('Save workflow')}</button>
      </div>
    </div>
  )
}

type WorkflowProps = HarnessProps & {requestedWorkflowId?: string | null; onNavigateWorkflow?: (id?: string) => void}

export const HarnessWorkflows: React.FC<WorkflowProps> = (props) => (
  <ScopedHarnessWorkflows key={JSON.stringify([props.httpBase, props.orgId, props.sessionToken, props.requestedWorkflowId])} {...props} />
)

const ScopedHarnessWorkflows: React.FC<WorkflowProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null)
  const [tables, setTables] = useState<Table[]>([])
  const [triggerApps,setTriggerApps]=useState<AppTriggerChoice[]>([])
  const [agents, setAgents] = useState<AgentFace[]>([])
  const [editing, setEditing] = useState<Workflow | null>(null)
  const [building, setBuilding] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [manual, setManual] = useState(false)
  const [open, setOpen] = useState<{ workflow: Workflow; runs: Run[]; canEdit: boolean; held?: HeldWorkflowEvents } | null>(null)
  const [failedRunsOnly,setFailedRunsOnly]=useState(false)
  const [budgetDraft,setBudgetDraft]=useState({daily:'0',weekly:'0',monthly:'0',ai24h:'0',ai7d:'0',ai30d:'0',aiAction:'warn' as 'warn'|'pause'})
  const [hook, setHook] = useState<string | null>(null)
  const [hookAction, setHookAction] = useState<'rotate' | 'revoke' | null>(null)
  const [replaySelection, setReplaySelection] = useState<string[] | null>(null)
  const [discardSelection, setDiscardSelection] = useState<string[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [syncError,setSyncError]=useState('')
  const detailRequest = useRef(0)
  const { busy, error, act } = useAct()
  useEffect(()=>setFailedRunsOnly(false),[open?.workflow.id])
  useEffect(()=>{
    const safety=open?.workflow.safety
    if(!safety)return
    setBudgetDraft({daily:String(safety.daily_run_limit??0),weekly:String(safety.weekly_run_limit??0),monthly:String(safety.monthly_run_limit??0),ai24h:String(safety.budget?.ai?.['24h']?.limitUsd??0),ai7d:String(safety.budget?.ai?.['7d']?.limitUsd??0),ai30d:String(safety.budget?.ai?.['30d']?.limitUsd??0),aiAction:safety.budget?.ai?.action??'warn'})
  },[open?.workflow.id,open?.workflow.safety?.budget_revision])
  const activeWorkflowId=!editing&&open?.runs.some(run=>run.status==='running')?open.workflow.id:null
  useEffect(()=>{
    if(!activeWorkflowId||busy)return
    let stopped=false,timer:ReturnType<typeof setTimeout>
    const request=detailRequest.current
    const refresh=async()=>{
      try{
        const result=await api.workflow(activeWorkflowId)
        if(stopped||detailRequest.current!==request)return
        setSyncError('')
        setOpen(current=>current?.workflow.id===activeWorkflowId?result:current)
        if(result.runs.some(run=>run.status==='running'))timer=setTimeout(refresh,5000)
      }catch(error){
        if(stopped||detailRequest.current!==request)return
        setSyncError(error instanceof Error?error.message:String(error))
        setOpen(null)
        setWorkflows(current=>current?.filter(workflow=>workflow.id!==activeWorkflowId)??null)
      }
    }
    timer=setTimeout(refresh,5000)
    return()=>{stopped=true;clearTimeout(timer)}
  },[api,activeWorkflowId,busy])


  const load = useCallback(() => act('load', async () => {
    const [w, tb, appList] = await Promise.all([api.workflows(), api.tables(),api.apps?.().catch(()=>({apps:[]}))||Promise.resolve({apps:[]})])
    setWorkflows(w.workflows); setTables(tb.tables)
    const appChoices:Array<AppTriggerChoice|null>=[]
    for(let index=0;index<appList.apps.length;index+=6){
      const batch=await Promise.all(appList.apps.slice(index,index+6).map(async app=>{try{if(!api.appDatabase)return null;const database=await api.appDatabase(app.id);return {app,entities:database.entities}}catch{return null}}))
      appChoices.push(...batch)
    }
    setTriggerApps(appChoices.filter((choice):choice is AppTriggerChoice=>Boolean(choice)))
    const res = await fetch(`${props.httpBase}/channels/agents?orgId=${encodeURIComponent(props.orgId)}`, { headers: { 'x-session-token': props.sessionToken } }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => ({})) : {}
    setAgents((data.agents || []) as AgentFace[])
  }), [api, act, props.httpBase, props.orgId, props.sessionToken, props.requestedWorkflowId])
  useEffect(() => { load() }, [load])

  const openOne = (id: string) => {
    if(props.onNavigateWorkflow && props.requestedWorkflowId!==id){props.onNavigateWorkflow(id);return Promise.resolve()}
    const request = ++detailRequest.current
    return act(`open:${id}`, async () => {
      setSyncError(''); setHookAction(null); setReplaySelection(null); setDiscardSelection(null); setConfirmDelete(false)
      try {
        const result = await api.workflow(id)
        if (detailRequest.current === request) setOpen(result)
      } catch (error) {
        if (detailRequest.current === request) throw error
      }
    })
  }
  const refreshOpen = async (id: string) => {
    const request = detailRequest.current
    const result = await api.workflow(id)
    setOpen(current => detailRequest.current === request && current?.workflow.id === id ? result : current)
  }
  useEffect(() => { if(props.requestedWorkflowId)void openOne(props.requestedWorkflowId);return()=>{detailRequest.current++} }, [])

  if (open && editing) return <Shell className="hx-resource-screen" title={t('Edit workflow')} onClose={() => { if(!busy)setEditing(null) }} nested>
    {error && <div className="form-error" role="alert">{error}</div>}
    <Builder api={api} key={editing.id} initial={editing} tables={tables} agents={agents} triggerApps={triggerApps} busy={!!busy}
      onCancel={() => { if(!busy)setEditing(null) }} onSave={draft => act('save',async()=>{
        await api.updateWorkflow(editing.id,{...draft,expectedUpdatedAt:editing.updatedAt})
        await refreshOpen(editing.id)
        setEditing(null)
      })}/>
  </Shell>

  if (open) {
    const w = open.workflow
    const budget=w.safety?.budget
    const budgetPause=w.safety?.pause_reason?.startsWith('budget_')===true
    const aiBudgetPause=w.safety?.pause_reason?.startsWith('budget_ai_')===true
    const aiPausedPeriod=aiBudgetPause?({budget_ai_24h:'24h',budget_ai_7d:'7d',budget_ai_30d:'30d'} as const)[w.safety?.pause_reason as 'budget_ai_24h'|'budget_ai_7d'|'budget_ai_30d']:undefined
    const pausedPeriod=budgetPause&&!aiBudgetPause?(w.safety?.pause_reason?.slice('budget_'.length) as 'daily'|'weekly'|'monthly'):null
    const pausedBudget=aiPausedPeriod?budget?.ai?.[aiPausedPeriod]:pausedPeriod?budget?.[pausedPeriod]:null
    const budgetDraftValid=['daily','weekly','monthly'].every(key=>{const value=budgetDraft[key as 'daily'|'weekly'|'monthly'];return value!==''&&Number.isSafeInteger(Number(value))&&Number(value)>=0&&Number(value)<=1_000_000})&&['ai24h','ai7d','ai30d'].every(key=>{const value=Number(budgetDraft[key as 'ai24h'|'ai7d'|'ai30d']);return budgetDraft[key as 'ai24h'|'ai7d'|'ai30d']!==''&&Number.isFinite(value)&&value>=0&&value<=1_000_000&&Math.abs(value*1_000_000-Math.round(value*1_000_000))<0.001})
    const visibleRuns=open.runs.filter(run=>!failedRunsOnly||run.status==='failed')
    const runDays=groupRunsByStartDay(visibleRuns)
    return (
      <Shell className="hx-resource-screen" title={w.name} onClose={() => { detailRequest.current++; if(props.onNavigateWorkflow){props.onNavigateWorkflow();return}setOpen(null); load() }} nested actions={
        <button className="pill-btn quiet" disabled={!!busy} onClick={() => act('refresh', async () => {
          setHookAction(null); setReplaySelection(null); setDiscardSelection(null); setConfirmDelete(false)
          await refreshOpen(w.id)
        })}><Icon name="refresh" size={14} /> {t('Refresh')}</button>
      }>
        {!w.enabled && !w.safety?.paused_at && <p className="form-note">{t('Automatic triggers are paused. You can still run this workflow manually.')}</p>}
        {w.safety?.paused_at && <section className="form-note" role="status">
          <strong>{aiBudgetPause?t('Paused by estimated AI usage budget'):budgetPause?t('Paused after reaching the {period} run limit',{period:pausedPeriod?t(`${pausedPeriod[0].toUpperCase()+pausedPeriod.slice(1)} run budget`):t('Daily run budget')}):t('Paused after three consecutive failures')}</strong>
          {aiBudgetPause&&w.safety?.pause_reason==='budget_ai_unpriced'?<p>{t('AI usage could not be priced. This workflow can resume after the unpriced usage leaves its rolling window or the limit is changed.')}</p>:aiBudgetPause?<p>{t('This workflow can run again on its next trigger after {when}, or when its AI usage budget is raised.',{when:pausedBudget?.resetAt?new Date(pausedBudget.resetAt).toLocaleString():''})}</p>:budgetPause?<p>{t('This workflow can run again on the next trigger after {when}, or as soon as its run limit is raised.',{when:pausedBudget?.resetAt?new Date(pausedBudget.resetAt).toLocaleString():''})}</p>:<p>{t('Review the failed runs below before resuming. Held events will not replay automatically.')}</p>}
          {open.canEdit && !budgetPause && <button className="pill-btn" disabled={!!busy} onClick={()=>act('resume',async()=>{
            await api.resumeWorkflow(w.id,w.safety!.generation)
            await refreshOpen(w.id)
          })}>{t('Resume after review')}</button>}
        </section>}
        <section className="form-note hx-workflow-budget" aria-label={t('Run budget')}>
          <strong>{t('Run budget')}</strong>
          <p>{t('Limits apply to every run, including manual runs. Enter 0 for unlimited. Windows use UTC.')}</p>
          <div className="hx-inline">
            {(['daily','weekly','monthly'] as const).map(period=>{
              const status=budget?.[period]
              const label=t(`${period[0].toUpperCase()+period.slice(1)} run budget`)
              return (<label key={period}>{t(label)}
                <input className="hx-cell-input" type="number" min="0" max="1000000" step="1" aria-label={t('{period} run limit',{period:label})} value={budgetDraft[period]} disabled={!open.canEdit||!!busy} onChange={event=>setBudgetDraft(current=>({...current,[period]:event.target.value}))}/>
                <span className="row-sub">{status?.limit?t('{used} of {limit} runs',{used:status.used,limit:status.limit}):t('No limit ({used} used)',{used:status?.used??0})}{status?.exhausted&&<span> · {t('resets {when}',{when:new Date(status.resetAt).toLocaleString()})}</span>}</span>
              </label>)
            })}
          </div>
          <div className="rows-title">{t('Estimated AI usage budget')}</div>
          <p>{t('Rolling windows use estimated USD list prices from recorded model tokens. They are not provider invoices or Kylon credits; tool fees and unreported usage may be missing.')}</p>
          <label className="hx-inline">{t('When an AI estimate reaches its limit')}
            <select aria-label={t('When an AI estimate reaches its limit')} value={budgetDraft.aiAction} disabled={!open.canEdit||!!busy} onChange={event=>setBudgetDraft(current=>({...current,aiAction:event.target.value as 'warn'|'pause'}))}>
              <option value="warn">{t('Warn only')}</option><option value="pause">{t('Pause after the current run')}</option>
            </select>
          </label>
          <div className="hx-inline">
            {(['24h','7d','30d'] as const).map(period=>{
              const key=period==='24h'?'ai24h':period==='7d'?'ai7d':'ai30d'
              const status=budget?.ai?.[period]
              const label=t(`${period} rolling AI budget`)
              return <label key={period}>{label}
                <input className="hx-cell-input" type="number" min="0" max="1000000" step="0.000001" aria-label={label} value={budgetDraft[key]} disabled={!open.canEdit||!!busy} onChange={event=>setBudgetDraft(current=>({...current,[key]:event.target.value}))}/>
                <span className="row-sub">{status?.limitUsd?t('{used} of {limit} estimated',{used:status.usedUsd.toFixed(6),limit:status.limitUsd.toFixed(6)}):t('No AI usage limit ({used} estimated)',{used:(status?.usedUsd??0).toFixed(6)})}{status?.unpricedCalls?` · ${t('{count} unpriced calls',{count:status.unpricedCalls})}`:''}{status?.exhausted&&status.resetAt?<span> · {t('rolling reset {when}',{when:new Date(status.resetAt).toLocaleString()})}</span>:null}</span>
              </label>
            })}
          </div>
          {open.canEdit&&<button className="pill-btn" disabled={!!busy||!budgetDraftValid} onClick={()=>act('budget',async()=>{
            await api.updateWorkflowBudget(w.id,{revision:w.safety?.budget_revision??0,dailyLimit:Number(budgetDraft.daily),weeklyLimit:Number(budgetDraft.weekly),monthlyLimit:Number(budgetDraft.monthly),dailyAiLimitUsd:Number(budgetDraft.ai24h),weeklyAiLimitUsd:Number(budgetDraft.ai7d),monthlyAiLimitUsd:Number(budgetDraft.ai30d),aiBudgetAction:budgetDraft.aiAction})
            await refreshOpen(w.id)
          })}>{t('Save budget settings')}</button>}
        </section>
        <div className="hx-flow-diagram"><div className="hx-flow-node"><small>{t('Trigger')}</small><strong>{triggerLabel(t, w.trigger, tables, triggerApps)}</strong></div>{w.steps.map((step, index) => <React.Fragment key={index}><span className="hx-flow-connector">↓</span><div className="hx-flow-node"><small>{index + 1}. {stepLabel(t, step.type)}</small><strong>{step.text || step.prompt || step.title || tables.find(table => table.id === step.tableId)?.name}</strong>{step.channel && <span>{step.channel.startsWith('ag:') || step.channel.startsWith('dm:') ? t('Private chat') : step.channel.replace(/^b:/, '#')}</span>}{step.agentId && <span>{t('Agent')}: {agents.find(agent => agent.id === step.agentId)?.name || step.agentId}</span>}{step.to && <span>@{step.to}</span>}{step.summary && <p>{step.summary}</p>}{step.minutes && <span>{step.minutes} min</span>}{step.type==='code'&&<details><summary>{t('Program source')}</summary><pre className="hx-program-source">{step.code}</pre></details>}{step.values && <pre>{JSON.stringify(step.values, null, 2)}</pre>}{step.when && <div className="hx-flow-condition"><small>{t('Execution condition')}</small><p>{describeWorkflowCondition(step.when,tables.find(table=>table.id===w.trigger.tableId)?.columns)}</p></div>}</div></React.Fragment>)}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-main">{triggerLabel(t, w.trigger, tables, triggerApps)}
              <span className="row-sub">{w.steps.map((s) => stepLabel(t, s.type)).join(' → ')}</span>
              {w.nextRunAt && !w.safety?.paused_at && <span className="row-sub">{t('Next run {when}', { when: new Date(w.nextRunAt).toLocaleString() })}</span>}
              {w.hookUrl && <code className="hx-code">{w.hookUrl}</code>}
            </span>
          </div>
        </div>
        <WorkflowHistory key={`${w.id}:${w.updatedAt}`} api={api} workflowId={w.id} tables={tables} agents={agents} apps={triggerApps}/>
        <WorkflowSource key={w.id} api={api} workflowId={w.id} orgId={props.orgId}/>
        {(error||syncError) && <div className="form-error" role="alert">{error||syncError}</div>}
        {open.canEdit && (
          <div className="hx-actions">
            <button className="pill-btn quiet" disabled={!!busy || !w.updatedAt} onClick={() => setEditing(structuredClone(w))}><Icon name="edit" size={14} /> {t('Edit workflow')}</button>
            <button className="pill-btn" disabled={!!busy || !!w.safety?.paused_at} onClick={() => act('run', async () => { await api.runWorkflow(w.id, ''); await refreshOpen(w.id) })}><Icon name="zap" size={14} /> {t('Run now')}</button>
            <button className="pill-btn quiet" disabled={!!busy} onClick={() => act('toggle', async () => { await api.updateWorkflow(w.id, { enabled: !w.enabled }); await refreshOpen(w.id) })}>{w.enabled ? t('Turn off') : t('Turn on')}</button>
            <button className="btn-text danger" disabled={!!busy} onClick={() => { setConfirmDelete(true); setHookAction(null); setReplaySelection(null); setDiscardSelection(null) }}>{t('Delete')}</button>
          </div>
        )}
        {open.canEdit && confirmDelete && <section className="form-note" aria-label={t('Delete workflow')}>
          <p>{t('Delete “{name}” and its run history? This cannot be undone. Past changes are not undone.', { name: w.name })}</p>
          <div className="hx-actions">
            <button className="pill-btn danger" disabled={!!busy} onClick={() => act('delete', async () => {
              await api.deleteWorkflow(w.id)
              if(props.onNavigateWorkflow){props.onNavigateWorkflow();return}
              setOpen(current => current?.workflow.id === w.id ? null : current)
              setConfirmDelete(false)
              await load()
            })}>{t('Delete workflow')}</button>
            <button className="btn-text" disabled={!!busy} onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button>
          </div>
        </section>}
        {open.canEdit && w.trigger.type === 'webhook' && <section aria-label={t('Webhook')}>
          <div className="rows-title">{t('Webhook')}</div>
          {w.hookUrl && !w.webhookSignatureRequired && <p className="form-note">{t('This existing webhook still accepts its URL secret alone. Generate a new URL to switch it to signed requests.')}</p>}
          {w.hookUrl && w.webhookSignatureRequired && <details className="form-note">
            <summary>{t('Send signed webhook events')}</summary>
            <p>{t('Sign the exact JSON body with the webhook secret. Use a fresh timestamp and a stable event ID for retries; signed requests expire after 5 minutes and event IDs are remembered for 7 days.')}</p>
            <p>{t('Store the URL and secret in your sender’s environment as HONMARU_WEBHOOK_URL and HONMARU_WEBHOOK_SECRET.')}</p>
            <pre className="hx-program-source">{WEBHOOK_SENDER_EXAMPLE}</pre>
          </details>}
          {!w.hookUrl && <p className="form-note">{t('This webhook is revoked. Generate a new URL to accept events again.')}</p>}
          {hookAction ? <div className="form-note">
            <p>{t(hookAction === 'rotate' ? 'The current webhook URL will stop working. Update your sender with the new URL and signed-request headers.' : 'The webhook URL will stop accepting events. Existing runs are not cancelled.')}</p>
            <div className="hx-actions">
              <button className="pill-btn danger" disabled={!!busy} onClick={() => act('hook', async () => {
                const result = await api.changeWorkflowHook(w.id, hookAction, w.hookSecret ?? null)
                setOpen(current => current?.workflow.id === w.id ? { ...current, workflow: result.workflow } : current)
                setHookAction(null)
              })}>{t(hookAction === 'rotate' ? 'Generate new webhook URL' : 'Revoke webhook')}</button>
              <button className="btn-text" disabled={!!busy} onClick={() => setHookAction(null)}>{t('Cancel')}</button>
            </div>
          </div> : <div className="hx-actions">
            <button className="pill-btn quiet" disabled={!!busy} onClick={() => setHookAction('rotate')}>{t('Generate new webhook URL')}</button>
            {w.hookUrl && <button className="btn-text danger" disabled={!!busy} onClick={() => setHookAction('revoke')}>{t('Revoke webhook')}</button>}
          </div>}
          {!!open.held?.count && <div className="form-note">
            <p>{t('Held events: {count}', { count: open.held.count })}</p>
            {open.held.oldestExpiry && <p>{t('Oldest event expires: {when}', { when: new Date(open.held.oldestExpiry).toLocaleString() })}</p>}
            <p>{t('Resuming does not replay held events. Replay runs the saved workflow with real effects, oldest first.')}</p>
            {replaySelection && <ul>{open.held.events.filter(event => replaySelection.includes(event.id)).map(event => <li key={event.id}><HeldEventPreview receivedAt={event.receivedAt} load={() => api.heldWorkflowEvent(w.id, event.id)} /></li>)}</ul>}
            {replaySelection ? <div className="hx-actions">
              <button className="pill-btn" disabled={!!busy || !w.enabled || !!w.safety?.paused_at} onClick={() => act('replay', async () => {
                await api.replayWorkflowEvents(w.id, replaySelection)
                setReplaySelection(null)
                await refreshOpen(w.id)
              })}>{t('Replay {count} events', { count: replaySelection.length })}</button>
              <button className="btn-text" disabled={!!busy} onClick={() => setReplaySelection(null)}>{t('Cancel')}</button>
            </div> : !discardSelection && <div className="hx-actions">
              <button className="pill-btn quiet" disabled={!!busy || !w.enabled || !!w.safety?.paused_at} onClick={() => setReplaySelection(open.held!.events.map(e => e.id))}>{t('Review held events')}</button>
              <button className="btn-text danger" disabled={!!busy || !open.held.discardEventIds?.length} onClick={() => setDiscardSelection([...open.held!.discardEventIds!])}>{t('Discard held events')}</button>
            </div>}
            {discardSelection && <div>
              <p>{t('These held events will be permanently discarded without running. New arrivals and existing runs are kept.')}</p>
              <div className="hx-actions">
                <button className="pill-btn danger" disabled={!!busy} onClick={() => act('discard', async () => {
                  await api.discardWorkflowEvents(w.id, discardSelection)
                  setDiscardSelection(null)
                  await refreshOpen(w.id)
                })}>{t('Discard {count} events', { count: discardSelection.length })}</button>
                <button className="btn-text" disabled={!!busy} onClick={() => setDiscardSelection(null)}>{t('Cancel')}</button>
              </div>
            </div>}
          </div>}
        </section>}
        <div className="rows-title">{t('Runs')}</div>
        {open.runs.length === 0 && <div className="empty">{t('It has not run yet.')}</div>}
        {!!open.runs.length&&<div className="hx-run-history-tools"><button type="button" className="pill-btn quiet hx-run-filter" aria-pressed={failedRunsOnly} onClick={()=>setFailedRunsOnly(value=>!value)}>{t('Failed runs only')}</button></div>}
        {open.runs.length>0&&visibleRuns.length===0&&<p className="hx-run-empty">{t('No failed runs.')}</p>}
        {runDays.map(([key,group])=><section className="hx-run-day" key={key}><h4>{runDayLabel(group.date,getLocale(),t)}</h4><div className="rows hx-run-day-rows">
          {group.runs.map((r) => (
            <div key={r.id} className="row static hx-run" data-run={r.id}>
              <div className="row-main">
                <span className={`hx-status ${r.status}`}>{t(r.status)}</span> <time dateTime={Number.isFinite(new Date(r.startedAt).getTime())?r.startedAt:undefined}>{runTimestampLabel(r.startedAt,getLocale(),t('Date unavailable'))}</time> · {t(r.trigger)}{r.definitionRevision && <span className="row-sub">{t('Version {version}',{version:r.definitionRevision})}</span>}
                {runDuration(r)!==null&&<> · <span title={t('Elapsed time, including approval waits')}>{runDuration(r)}</span></>}
                <WorkflowRunUsage usage={r.usage}/>
                {r.log.map((l) => {
                  const output=l.status==='skipped'&&l.output==='Condition did not match.'?t('Condition did not match.'):l.output
                  return (
                  l.output || l.error ? <details key={l.step} className="hx-run-detail">
                    <summary className="row-sub">{l.step}. {stepLabel(t, l.type)} — <span className={`hx-status ${l.status}`}>{t(l.status)}</span>
                      {`: ${(l.error || output || '').slice(0, 160)}${(l.error || output || '').length > 160 ? '…' : ''}`}
                    </summary>
                    {l.output && <div><strong>{t('Output')}</strong><pre>{output}</pre></div>}
                    {l.error && <div><strong>{t('Error')}</strong><pre>{l.error}</pre></div>}
                    <time dateTime={l.at}>{new Date(l.at).toLocaleString(getLocale())}</time>
                  </details> : <span key={l.step} className="row-sub hx-log">{l.step}. {stepLabel(t, l.type)} — <span className={`hx-status ${l.status}`}>{t(l.status)}</span></span>
                )})}
              </div>
            </div>
          ))}
        </div></section>)}
      </Shell>
    )
  }

  return (
    <Shell className="hx-resource-screen" title={t('Workflows')} onClose={props.onClose} actions={!building && <button className="pill-btn" onClick={() => setBuilding(true)}><Icon name="plus" size={14} /> {t('Set up an automation')}</button>}>
      <WorkflowNotices api={api} onOpen={id=>void openOne(id)} />
      <p className="lede">{t('Describe the outcome once: when it should happen, and what follows. A person approves what matters.')}</p>
      {(error||syncError) && <div className="form-error" role="alert">{error||syncError}</div>}
      {hook && <div className="form-note">{t('Call this address to start it:')} <code className="hx-code">{hook}</code></div>}
      {building && !manual && <section className="hx-generation">
        <label htmlFor="workflow-prompt">{t('Describe an automation')}</label>
        <textarea id="workflow-prompt" className="context-input" rows={4} maxLength={4000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t('e.g. Every weekday at 9, ask an agent to summarize tasks and post in #ops.')} />
        <p className="row-sub">{t('Created paused. Review the steps before turning it on.')}</p>
        <div className="hx-actions"><button className="pill-btn" disabled={busy !== null || !prompt.trim()} onClick={() => act('generate', async () => { const made = await api.generateWorkflow(prompt); await openOne(made.workflow.id); setBuilding(false); setPrompt('') })}>{t(busy === 'generate' ? 'Building…' : 'Build')}</button><button className="btn-text" onClick={() => setManual(v => !v)}>{t('Manual setup')}</button><button className="btn-text" onClick={() => setBuilding(false)}>{t('Cancel')}</button></div>
      </section>}
      {building && manual && (
        <Builder
          api={api}
          tables={tables}
          agents={agents}
          triggerApps={triggerApps}
          busy={busy === 'save'}
          onCancel={() => setBuilding(false)}
          onSave={(w) => act('save', async () => {
            const made = await api.createWorkflow(w)
            setHook(made.hookUrl || null)
            setBuilding(false)
            await load()
          })}
        />
      )}
      {workflows === null && <div className="empty">{t('Loading…')}</div>}
      {workflows?.length === 0 && !building && <div className="hx-resource-empty"><span className="hx-resource-symbol"><Icon name="zap" size={24} /></span><h2>{t('No workflows yet.')}</h2><p>{t('Automations do work on a schedule or when something happens in this room.')}</p><button onClick={() => setBuilding(true)}>{t('Set up an automation')}</button></div>}
      <div className="rows">
        {workflows?.map((w) => (
          <button key={w.id} className="row" onClick={() => openOne(w.id)} data-workflow={w.id}>
            <span className="row-icon"><Icon name="zap" size={18} /></span>
            <span className="row-main">{w.name}{w.safety?.paused_at && <span className="hx-off"> · {w.safety.pause_reason?.startsWith('budget_ai_')?t('Paused by estimated AI usage budget'):w.safety.pause_reason?.startsWith('budget_')?t('Paused by run budget'):t('Paused after failures')}</span>}{!w.enabled && <span className="hx-off"> · {t('off')}</span>}
              <span className="row-sub">{triggerLabel(t, w.trigger, tables, triggerApps)} · {w.steps.length} {t('steps')}</span>
            </span>
            <span className="row-value">›</span>
          </button>
        ))}
      </div>
    </Shell>
  )
}
