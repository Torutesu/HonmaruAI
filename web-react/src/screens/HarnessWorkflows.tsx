import {describeWorkflowCondition} from '../utils/workflowCondition'
import {runDuration} from '../utils/runDuration'
import {getLocale} from '../utils/locale'
import {WorkflowRunUsage} from '../components/WorkflowRunUsage'
import {WorkflowSource} from '../components/WorkflowSource'
import {WorkflowNotices} from '../components/WorkflowNotices'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import {StepEditor} from '../components/WorkflowStepEditor'
import type { Workflow, Run, Step, StepType, Trigger, TriggerType, Table, HeldWorkflowEvents } from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps } from './HarnessShared'

// Workflows (docs/kylon-gap-plan.md): a trigger and the steps after it,
// built from a form rather than a graph, with every run and every step's
// outcome kept where anyone can read it.

const CADENCES = ['daily', 'weekdays', 'weekly', 'monthly']
const weekdayName = (day:number) => new Intl.DateTimeFormat(getLocale(),{weekday:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,4+day)))

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
    {payload && <pre>{JSON.stringify(payload.input, null, 2)}</pre>}
  </details>
}

interface AgentFace { id: string; handle: string; name: string; emoji?: string | null }

function stepLabel(t: (k: string) => string, type: StepType) {
  return ({
    post: t('Post in a room'), agent: t('Ask an agent'), add_row: t('Add a row'),
    update_row: t('Change the row'), approval: t('Ask for approval'), followup: t('Follow up later'),
  } as Record<StepType, string>)[type]
}

function triggerLabel(t: (k: string, v?: Record<string, string | number>) => string, tr: Trigger, tables: Table[]) {
  if (tr.type === 'schedule') return `${t('Schedule')}: ${t(tr.cadence || 'daily')}${tr.cadence === 'weekly' ? ` · ${weekdayName(tr.weekday ?? 1)}` : tr.cadence === 'monthly' ? ` · ${t('Day {day}',{day:tr.monthday ?? 1})}` : ''} ${String(tr.hour ?? 9).padStart(2, '0')}:${String(tr.minute ?? 0).padStart(2, '0')} ${tr.timezone || ''}`
  if (tr.type === 'row') {
    const table = tables.find((x) => x.id === tr.tableId)
    const where = tr.where ? Object.entries(tr.where).map(([k, v]) => `${k} = ${v.join('/')}`).join(', ') : ''
    return `${t('When a row is {on} in {table}', { on: tr.on || 'any', table: table?.name || '?' })}${where ? ` (${where})` : ''}`
  }
  if (tr.type === 'webhook') return t('When its webhook is called')
  return t('When someone runs it')
}

const blankStep = (type: StepType): Step => ({ type, ...(type === 'followup' ? { minutes: 1440 } : {}) })


function Builder({ tables, agents, onSave, onCancel, busy, initial }: { initial?: Workflow; tables: Table[]; agents: AgentFace[]; onSave: (w: { name: string; trigger: Trigger; steps: Step[] }) => void; onCancel: () => void; busy: boolean }) {
  const t = useT()
  const [name, setName] = useState(initial?.name || '')
  const [trigger, setTrigger] = useState<Trigger>(initial ? structuredClone(initial.trigger) : { type: 'manual' })
  const [steps, setSteps] = useState<Step[]>(initial ? structuredClone(initial.steps) : [blankStep('post')])
  const scheduleValid = trigger.type !== 'schedule' || (()=>{
    try { new Intl.DateTimeFormat('en',{timeZone:trigger.timezone}); } catch { return false }
    return Boolean(trigger.timezone?.trim()) && Number.isInteger(trigger.hour) && trigger.hour!>=0 && trigger.hour!<=23 && Number.isInteger(trigger.minute) && trigger.minute!>=0 && trigger.minute!<=59
  })()
  const table = tables.find((x) => x.id === trigger.tableId)
  const whereCol = table?.columns.find((c) => c.type === 'select')
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
  return (
    <div className="hx-builder">
      <input className="hx-cell-input hx-title-input" placeholder={t('Workflow name')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('Workflow name')} />
      <div className="rows-title">{t('Trigger')}</div>
      <div className="hx-step">
        <select value={trigger.type} onChange={(e) => {
          const type = e.target.value as TriggerType
          setTrigger(type === 'schedule' ? { type, cadence: 'weekdays', hour: 9, minute: 0, timezone: tz } : type === 'row' ? { type, on: 'changed', tableId: tables[0]?.id } : { type })
        }} aria-label={t('Trigger')}>
          <option value="manual">{t('By hand')}</option>
          <option value="schedule">{t('On a schedule')}</option>
          <option value="webhook">{t('A webhook')}</option>
          <option value="row">{t('A row added or changed')}</option>
        </select>
        {trigger.type === 'schedule' && (
          <span className="hx-inline">
            <select value={trigger.cadence} onChange={(e) => setTrigger({ ...trigger, cadence: e.target.value })} aria-label={t('Cadence')}>
              {CADENCES.map((c) => <option key={c} value={c}>{t(c)}</option>)}
            </select>
            {trigger.cadence === 'weekly' && <select aria-label={t('Weekday')} value={trigger.weekday ?? 1} onChange={e=>setTrigger({...trigger,weekday:Number(e.target.value)})}>
              {Array.from({length:7},(_,day)=><option key={day} value={day}>{weekdayName(day)}</option>)}
            </select>}
            {trigger.cadence === 'monthly' && <select aria-label={t('Day of month')} value={trigger.monthday ?? 1} onChange={e=>setTrigger({...trigger,monthday:Number(e.target.value)})}>
              {Array.from({length:31},(_,index)=><option key={index+1} value={index+1}>{t('Day {day}',{day:index+1})}</option>)}
            </select>}
            <input type="time" className="hx-cell-input" value={`${String(trigger.hour ?? 9).padStart(2, '0')}:${String(trigger.minute ?? 0).padStart(2, '0')}`} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); setTrigger({ ...trigger, hour: h, minute: m }) }} aria-label={t('Time')} />
            <input className="hx-cell-input" aria-label={t('Time zone')} value={trigger.timezone || ''} placeholder="Asia/Tokyo" onChange={e=>setTrigger({...trigger,timezone:e.target.value})} />
            {!scheduleValid && <span className="form-error" role="alert">{t('Enter a valid time and time zone.')}</span>}
            {trigger.cadence === 'monthly' && <span className="row-sub">{t('If the date does not exist, runs on the last day of the month.')}</span>}
          </span>
        )}
        {trigger.type === 'row' && (
          <span className="hx-inline">
            <select value={trigger.tableId || ''} onChange={(e) => setTrigger({ ...trigger, tableId: e.target.value, where: undefined })} aria-label={t('Table')}>
              {tables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <select value={trigger.on} onChange={(e) => setTrigger({ ...trigger, on: e.target.value as Trigger['on'] })} aria-label={t('When')}>
              <option value="added">{t('is added')}</option>
              <option value="changed">{t('is changed')}</option>
              <option value="any">{t('is added or changed')}</option>
            </select>
            {whereCol && (
              <select value={trigger.where?.[whereCol.id]?.[0] || ''} onChange={(e) => setTrigger({ ...trigger, where: e.target.value ? { [whereCol.id]: [e.target.value] } : undefined })} aria-label={whereCol.name}>
                <option value="">{t('any {column}', { column: whereCol.name })}</option>
                {(whereCol.options || []).map((o) => <option key={o} value={o}>{whereCol.name} = {o}</option>)}
              </select>
            )}
          </span>
        )}
        {trigger.type === 'row' && tables.length === 0 && <div className="row-sub">{t('Build an app first: its table is what a row trigger watches.')}</div>}
      </div>
      <div className="rows-title">{t('Steps')}</div>
      {steps.map((s, i) => (
        <StepEditor
          key={i}
          step={s}
          tables={tables}
          agents={agents}
          triggerTable={trigger.type === 'row' ? table : undefined}
          onChange={(next) => setSteps(steps.map((x, j) => (j === i ? next : x)))}
          onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
        />
      ))}
      <button className="pill-btn quiet" onClick={() => setSteps([...steps, blankStep('post')])}><Icon name="plus" size={14} /> {t('Add a step')}</button>
      <p className="hx-hint">{t('Steps can use what started them: {{row.Column}}, {{input.text}}, {{steps.1.output}}.')}</p>
      <div className="playbook-add-foot">
        <button className="btn-text" onClick={onCancel}>{t('Cancel')}</button>
        <button className="pill-btn" disabled={busy || !name.trim() || steps.length === 0 || !scheduleValid} onClick={() => onSave({ name, trigger, steps })}>{t('Save workflow')}</button>
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
  const [agents, setAgents] = useState<AgentFace[]>([])
  const [editing, setEditing] = useState<Workflow | null>(null)
  const [building, setBuilding] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [manual, setManual] = useState(false)
  const [open, setOpen] = useState<{ workflow: Workflow; runs: Run[]; canEdit: boolean; held?: HeldWorkflowEvents } | null>(null)
  const [hook, setHook] = useState<string | null>(null)
  const [hookAction, setHookAction] = useState<'rotate' | 'revoke' | null>(null)
  const [replaySelection, setReplaySelection] = useState<string[] | null>(null)
  const [discardSelection, setDiscardSelection] = useState<string[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const detailRequest = useRef(0)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => {
    const [w, tb] = await Promise.all([api.workflows(), api.tables()])
    setWorkflows(w.workflows); setTables(tb.tables)
    const res = await fetch(`${props.httpBase}/channels/agents?orgId=${encodeURIComponent(props.orgId)}`, { headers: { 'x-session-token': props.sessionToken } }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => ({})) : {}
    setAgents((data.agents || []) as AgentFace[])
  }), [api, act, props.httpBase, props.orgId, props.sessionToken, props.requestedWorkflowId])
  useEffect(() => { load() }, [load])

  const openOne = (id: string) => {
    if(props.onNavigateWorkflow && props.requestedWorkflowId!==id){props.onNavigateWorkflow(id);return Promise.resolve()}
    const request = ++detailRequest.current
    return act(`open:${id}`, async () => {
      setHookAction(null); setReplaySelection(null); setDiscardSelection(null); setConfirmDelete(false)
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
    <Builder key={editing.id} initial={editing} tables={tables} agents={agents} busy={!!busy}
      onCancel={() => { if(!busy)setEditing(null) }} onSave={draft => act('save',async()=>{
        await api.updateWorkflow(editing.id,{...draft,expectedUpdatedAt:editing.updatedAt})
        await refreshOpen(editing.id)
        setEditing(null)
      })}/>
  </Shell>

  if (open) {
    const w = open.workflow
    return (
      <Shell className="hx-resource-screen" title={w.name} onClose={() => { detailRequest.current++; if(props.onNavigateWorkflow){props.onNavigateWorkflow();return}setOpen(null); load() }} nested actions={
        <button className="pill-btn quiet" disabled={!!busy} onClick={() => act('refresh', async () => {
          setHookAction(null); setReplaySelection(null); setDiscardSelection(null); setConfirmDelete(false)
          await refreshOpen(w.id)
        })}><Icon name="refresh" size={14} /> {t('Refresh')}</button>
      }>
        {!w.enabled && !w.safety?.paused_at && <p className="form-note">{t('Automatic triggers are paused. You can still run this workflow manually.')}</p>}
        {w.safety?.paused_at && <section className="form-note" role="status">
          <strong>{t('Paused after three consecutive failures')}</strong>
          <p>{t('Review the failed runs below before resuming. Held events will not replay automatically.')}</p>
          {open.canEdit && <button className="pill-btn" disabled={!!busy} onClick={()=>act('resume',async()=>{
            await api.resumeWorkflow(w.id,w.safety!.generation)
            await refreshOpen(w.id)
          })}>{t('Resume after review')}</button>}
        </section>}
        <div className="hx-flow-diagram"><div className="hx-flow-node"><small>{t('Trigger')}</small><strong>{triggerLabel(t, w.trigger, tables)}</strong></div>{w.steps.map((step, index) => <React.Fragment key={index}><span className="hx-flow-connector">↓</span><div className="hx-flow-node"><small>{index + 1}. {stepLabel(t, step.type)}</small><strong>{step.text || step.prompt || step.title || tables.find(table => table.id === step.tableId)?.name}</strong>{step.channel && <span>{step.channel.startsWith('ag:') || step.channel.startsWith('dm:') ? t('Private chat') : step.channel.replace(/^b:/, '#')}</span>}{step.agentId && <span>{t('Agent')}: {agents.find(agent => agent.id === step.agentId)?.name || step.agentId}</span>}{step.to && <span>@{step.to}</span>}{step.summary && <p>{step.summary}</p>}{step.minutes && <span>{step.minutes} min</span>}{step.values && <pre>{JSON.stringify(step.values, null, 2)}</pre>}{step.when && <div className="hx-flow-condition"><small>{t('Execution condition')}</small><p>{describeWorkflowCondition(step.when,tables.find(table=>table.id===w.trigger.tableId)?.columns)}</p></div>}</div></React.Fragment>)}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-main">{triggerLabel(t, w.trigger, tables)}
              <span className="row-sub">{w.steps.map((s) => stepLabel(t, s.type)).join(' → ')}</span>
              {w.nextRunAt && !w.safety?.paused_at && <span className="row-sub">{t('Next run {when}', { when: new Date(w.nextRunAt).toLocaleString() })}</span>}
              {w.hookUrl && <code className="hx-code">{w.hookUrl}</code>}
            </span>
          </div>
        </div>
        <WorkflowSource key={w.id} api={api} workflowId={w.id} orgId={props.orgId}/>
        {error && <div className="form-error">{error}</div>}
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
          {!w.hookUrl && <p className="form-note">{t('This webhook is revoked. Generate a new URL to accept events again.')}</p>}
          {hookAction ? <div className="form-note">
            <p>{t(hookAction === 'rotate' ? 'The current webhook URL will stop working. Update your sender with the new URL.' : 'The webhook URL will stop accepting events. Existing runs are not cancelled.')}</p>
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
        <div className="rows">
          {open.runs.map((r) => (
            <div key={r.id} className="row static hx-run" data-run={r.id}>
              <div className="row-main">
                <span className={`hx-status ${r.status}`}>{t(r.status)}</span> <time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString(getLocale())}</time> · {t(r.trigger)}
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
        </div>
      </Shell>
    )
  }

  return (
    <Shell className="hx-resource-screen" title={t('Workflows')} onClose={props.onClose} actions={!building && <button className="pill-btn" onClick={() => setBuilding(true)}><Icon name="plus" size={14} /> {t('Set up an automation')}</button>}>
      <WorkflowNotices api={api} onOpen={id=>void openOne(id)} />
      <p className="lede">{t('Describe the outcome once: when it should happen, and what follows. A person approves what matters.')}</p>
      {error && <div className="form-error">{error}</div>}
      {hook && <div className="form-note">{t('Call this address to start it:')} <code className="hx-code">{hook}</code></div>}
      {building && <section className="hx-generation">
        <label htmlFor="workflow-prompt">{t('Describe an automation')}</label>
        <textarea id="workflow-prompt" className="context-input" rows={4} maxLength={4000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t('e.g. Every weekday at 9, ask an agent to summarize tasks and post in #ops.')} />
        <p className="row-sub">{t('Created paused. Review the steps before turning it on.')}</p>
        <div className="hx-actions"><button className="pill-btn" disabled={busy !== null || !prompt.trim()} onClick={() => act('generate', async () => { const made = await api.generateWorkflow(prompt); await openOne(made.workflow.id); setBuilding(false); setPrompt('') })}>{t(busy === 'generate' ? 'Building…' : 'Build')}</button><button className="btn-text" onClick={() => setManual(v => !v)}>{t('Manual setup')}</button><button className="btn-text" onClick={() => setBuilding(false)}>{t('Cancel')}</button></div>
      </section>}
      {building && manual && (
        <Builder
          tables={tables}
          agents={agents}
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
            <span className="row-main">{w.name}{w.safety?.paused_at && <span className="hx-off"> · {t('Paused after failures')}</span>}{!w.enabled && <span className="hx-off"> · {t('off')}</span>}
              <span className="row-sub">{triggerLabel(t, w.trigger, tables)} · {w.steps.length} {t('steps')}</span>
            </span>
            <span className="row-value">›</span>
          </button>
        ))}
      </div>
    </Shell>
  )
}
