import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import type { Workflow, Run, Step, StepType, Trigger, TriggerType, Table, HeldWorkflowEvents } from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps } from './HarnessShared'

// Workflows (docs/kylon-gap-plan.md): a trigger and the steps after it,
// built from a form rather than a graph, with every run and every step's
// outcome kept where anyone can read it.

const CADENCES = ['daily', 'weekdays', 'weekly', 'monthly']
const STEP_TYPES: StepType[] = ['post', 'agent', 'add_row', 'update_row', 'approval', 'followup']

interface AgentFace { id: string; handle: string; name: string; emoji?: string | null }

function stepLabel(t: (k: string) => string, type: StepType) {
  return ({
    post: t('Post in a room'), agent: t('Ask an agent'), add_row: t('Add a row'),
    update_row: t('Change the row'), approval: t('Ask for approval'), followup: t('Follow up later'),
  } as Record<StepType, string>)[type]
}

function triggerLabel(t: (k: string, v?: Record<string, string | number>) => string, tr: Trigger, tables: Table[]) {
  if (tr.type === 'schedule') return `${t('Schedule')}: ${tr.cadence} ${String(tr.hour ?? 9).padStart(2, '0')}:${String(tr.minute ?? 0).padStart(2, '0')} ${tr.timezone || ''}`
  if (tr.type === 'row') {
    const table = tables.find((x) => x.id === tr.tableId)
    const where = tr.where ? Object.entries(tr.where).map(([k, v]) => `${k} = ${v.join('/')}`).join(', ') : ''
    return `${t('When a row is {on} in {table}', { on: tr.on || 'any', table: table?.name || '?' })}${where ? ` (${where})` : ''}`
  }
  if (tr.type === 'webhook') return t('When its webhook is called')
  return t('When someone runs it')
}

const blankStep = (type: StepType): Step => ({ type, ...(type === 'followup' ? { minutes: 1440 } : {}) })

function StepEditor({ step, onChange, onRemove, tables, agents, triggerTable }: {
  step: Step; onChange: (s: Step) => void; onRemove: () => void; tables: Table[]; agents: AgentFace[]; triggerTable?: Table
}) {
  const t = useT()
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch })
  const valueTable = step.type === 'add_row' ? tables.find((x) => x.id === step.tableId) : triggerTable
  return (
    <div className="hx-step">
      <div className="hx-step-head">
        <select value={step.type} onChange={(e) => onChange(blankStep(e.target.value as StepType))} aria-label={t('Step')}>
          {STEP_TYPES.map((s) => <option key={s} value={s}>{stepLabel(t, s)}</option>)}
        </select>
        <button className="btn-text danger" onClick={onRemove} aria-label={t('Remove step')}><Icon name="x" size={14} /></button>
      </div>
      {(step.type === 'post' || step.type === 'followup') && (
        <input className="hx-cell-input" placeholder="#ops" value={(step.channel || '').replace(/^b:/, '#')} onChange={(e) => set({ channel: `b:${e.target.value.replace(/^#/, '')}` })} aria-label={t('Room')} />
      )}
      {(step.type === 'post' || step.type === 'followup') && (
        <textarea className="context-input" rows={2} placeholder={t('e.g. {{row.Client}} is overdue')} value={step.text || ''} onChange={(e) => set({ text: e.target.value })} aria-label={t('Text')} />
      )}
      {step.type === 'followup' && (
        <label className="hx-inline">{t('In')} <input type="number" min={1} className="hx-cell-input hx-num" value={Math.round((step.minutes || 0) / 60)} onChange={(e) => set({ minutes: Math.max(1, Number(e.target.value)) * 60 })} /> {t('hours')}</label>
      )}
      {step.type === 'agent' && (
        <>
          <select value={step.agentId || ''} onChange={(e) => set({ agentId: e.target.value })} aria-label={t('Agent')}>
            <option value="">{t('Choose an agent')}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji ? `${a.emoji} ` : ''}{a.name} (@{a.handle})</option>)}
          </select>
          <textarea className="context-input" rows={2} placeholder={t('What to ask it')} value={step.prompt || ''} onChange={(e) => set({ prompt: e.target.value })} aria-label={t('Prompt')} />
          <input className="hx-cell-input" placeholder={t('#room to post its answer (optional)')} value={(step.channel || '').replace(/^b:/, '#')} onChange={(e) => set({ channel: e.target.value ? `b:${e.target.value.replace(/^#/, '')}` : undefined })} aria-label={t('Room')} />
        </>
      )}
      {step.type === 'add_row' && (
        <select value={step.tableId || ''} onChange={(e) => set({ tableId: e.target.value, values: {} })} aria-label={t('Table')}>
          <option value="">{t('Choose a table')}</option>
          {tables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      )}
      {(step.type === 'add_row' || step.type === 'update_row') && valueTable && (
        <div className="hx-values">
          {valueTable.columns.map((c) => (
            <label key={c.id} className="hx-inline">
              <span>{c.name}</span>
              <input className="hx-cell-input" value={step.values?.[c.id] || ''} placeholder={c.type === 'select' ? (c.options || []).join(' / ') : ''} onChange={(e) => set({ values: { ...(step.values || {}), [c.id]: e.target.value } })} />
            </label>
          ))}
        </div>
      )}
      {step.type === 'update_row' && !valueTable && <div className="row-sub">{t('Changes the row that started the run: use a row trigger.')}</div>}
      {step.type === 'approval' && (
        <>
          <input className="hx-cell-input" placeholder={t('@who approves')} value={step.to ? `@${step.to}` : ''} onChange={(e) => set({ to: e.target.value.replace(/^@/, '') })} aria-label={t('Approver')} />
          <input className="hx-cell-input" placeholder={t('e.g. Send {{row.Client}} a reminder?')} value={step.title || ''} onChange={(e) => set({ title: e.target.value })} aria-label={t('Title')} />
          <textarea className="context-input" rows={2} placeholder={t('What they should know')} value={step.summary || ''} onChange={(e) => set({ summary: e.target.value })} aria-label={t('Summary')} />
        </>
      )}
    </div>
  )
}

function Builder({ tables, agents, onSave, onCancel, busy }: { tables: Table[]; agents: AgentFace[]; onSave: (w: { name: string; trigger: Trigger; steps: Step[] }) => void; onCancel: () => void; busy: boolean }) {
  const t = useT()
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState<Trigger>({ type: 'manual' })
  const [steps, setSteps] = useState<Step[]>([blankStep('post')])
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
            <input type="time" className="hx-cell-input" value={`${String(trigger.hour ?? 9).padStart(2, '0')}:${String(trigger.minute ?? 0).padStart(2, '0')}`} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); setTrigger({ ...trigger, hour: h, minute: m }) }} aria-label={t('Time')} />
            <span className="row-sub">{trigger.timezone}</span>
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
        <button className="pill-btn" disabled={busy || !name.trim() || steps.length === 0} onClick={() => onSave({ name, trigger, steps })}>{t('Save workflow')}</button>
      </div>
    </div>
  )
}

export const HarnessWorkflows: React.FC<HarnessProps> = (props) => (
  <ScopedHarnessWorkflows key={JSON.stringify([props.httpBase, props.orgId, props.sessionToken])} {...props} />
)

const ScopedHarnessWorkflows: React.FC<HarnessProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null)
  const [tables, setTables] = useState<Table[]>([])
  const [agents, setAgents] = useState<AgentFace[]>([])
  const [building, setBuilding] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [manual, setManual] = useState(false)
  const [open, setOpen] = useState<{ workflow: Workflow; runs: Run[]; canEdit: boolean; held?: HeldWorkflowEvents } | null>(null)
  const [hook, setHook] = useState<string | null>(null)
  const [hookAction, setHookAction] = useState<'rotate' | 'revoke' | null>(null)
  const [replaySelection, setReplaySelection] = useState<string[] | null>(null)
  const [discardSelection, setDiscardSelection] = useState<string[] | null>(null)
  const detailRequest = useRef(0)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => {
    const [w, tb] = await Promise.all([api.workflows(), api.tables()])
    setWorkflows(w.workflows); setTables(tb.tables)
    const res = await fetch(`${props.httpBase}/channels/agents?orgId=${encodeURIComponent(props.orgId)}`, { headers: { 'x-session-token': props.sessionToken } }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => ({})) : {}
    setAgents((data.agents || []) as AgentFace[])
  }), [api, act, props.httpBase, props.orgId, props.sessionToken])
  useEffect(() => { load() }, [load])

  const openOne = (id: string) => {
    const request = ++detailRequest.current
    return act(`open:${id}`, async () => {
      setHookAction(null); setReplaySelection(null); setDiscardSelection(null)
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
  useEffect(() => { let id: string | null = null; try { id = sessionStorage.getItem('hx.openWorkflow'); sessionStorage.removeItem('hx.openWorkflow') } catch {} if (id) void openOne(id) }, [])

  if (open) {
    const w = open.workflow
    return (
      <Shell className="hx-resource-screen" title={w.name} onClose={() => { detailRequest.current++; setOpen(null); load() }} nested>
        {!w.enabled && <p className="form-note">{t('Automatic triggers are paused. You can still run this workflow manually.')}</p>}
        <div className="hx-flow-diagram"><div className="hx-flow-node"><small>{t('Trigger')}</small><strong>{triggerLabel(t, w.trigger, tables)}</strong></div>{w.steps.map((step, index) => <React.Fragment key={index}><span className="hx-flow-connector">↓</span><div className="hx-flow-node"><small>{index + 1}. {stepLabel(t, step.type)}</small><strong>{step.text || step.prompt || step.title || tables.find(table => table.id === step.tableId)?.name}</strong>{step.channel && <span>{step.channel.startsWith('ag:') || step.channel.startsWith('dm:') ? t('Private chat') : step.channel.replace(/^b:/, '#')}</span>}{step.agentId && <span>{t('Agent')}: {agents.find(agent => agent.id === step.agentId)?.name || step.agentId}</span>}{step.to && <span>@{step.to}</span>}{step.summary && <p>{step.summary}</p>}{step.minutes && <span>{step.minutes} min</span>}{step.values && <pre>{JSON.stringify(step.values, null, 2)}</pre>}</div></React.Fragment>)}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-main">{triggerLabel(t, w.trigger, tables)}
              <span className="row-sub">{w.steps.map((s) => stepLabel(t, s.type)).join(' → ')}</span>
              {w.nextRunAt && <span className="row-sub">{t('Next run {when}', { when: new Date(w.nextRunAt).toLocaleString() })}</span>}
              {w.hookUrl && <code className="hx-code">{w.hookUrl}</code>}
            </span>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        {open.canEdit && (
          <div className="hx-actions">
            <button className="pill-btn" disabled={!!busy} onClick={() => act('run', async () => { await api.runWorkflow(w.id, ''); await refreshOpen(w.id) })}><Icon name="zap" size={14} /> {t('Run now')}</button>
            <button className="pill-btn quiet" onClick={() => act('toggle', async () => { await api.updateWorkflow(w.id, { enabled: !w.enabled }); await refreshOpen(w.id) })}>{w.enabled ? t('Turn off') : t('Turn on')}</button>
            <button className="btn-text danger" onClick={() => act('delete', async () => { await api.deleteWorkflow(w.id); setOpen(current => current?.workflow.id === w.id ? null : current); load() })}>{t('Delete')}</button>
          </div>
        )}
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
            {replaySelection && <ul>{open.held.events.filter(event => replaySelection.includes(event.id)).map(event => <li key={event.id}>{new Date(event.receivedAt).toLocaleString()}</li>)}</ul>}
            {replaySelection ? <div className="hx-actions">
              <button className="pill-btn" disabled={!!busy || !w.enabled} onClick={() => act('replay', async () => {
                await api.replayWorkflowEvents(w.id, replaySelection)
                setReplaySelection(null)
                await refreshOpen(w.id)
              })}>{t('Replay {count} events', { count: replaySelection.length })}</button>
              <button className="btn-text" disabled={!!busy} onClick={() => setReplaySelection(null)}>{t('Cancel')}</button>
            </div> : !discardSelection && <div className="hx-actions">
              <button className="pill-btn quiet" disabled={!!busy || !w.enabled} onClick={() => setReplaySelection(open.held!.events.map(e => e.id))}>{t('Review held events')}</button>
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
              <span className="row-main">
                <span className={`hx-status ${r.status}`}>{t(r.status)}</span> {new Date(r.startedAt).toLocaleString()} · {t(r.trigger)}
                {r.log.map((l) => (
                  <span key={l.step} className="row-sub hx-log">{l.step}. {stepLabel(t, l.type)} — <span className={`hx-status ${l.status}`}>{t(l.status)}</span>{l.output ? `: ${l.output.slice(0, 160)}` : ''}{l.error ? `: ${l.error}` : ''}</span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Shell>
    )
  }

  return (
    <Shell className="hx-resource-screen" title={t('Workflows')} onClose={props.onClose} actions={!building && <button className="pill-btn" onClick={() => setBuilding(true)}><Icon name="plus" size={14} /> {t('Set up an automation')}</button>}>
      <p className="lede">{t('Describe the outcome once: when it should happen, and what follows. A person approves what matters.')}</p>
      {error && <div className="form-error">{error}</div>}
      {hook && <div className="form-note">{t('Call this address to start it:')} <code className="hx-code">{hook}</code></div>}
      {building && <section className="hx-generation">
        <label htmlFor="workflow-prompt">{t('Describe an automation')}</label>
        <textarea id="workflow-prompt" className="context-input" rows={4} maxLength={4000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t('e.g. Every weekday at 9, ask an agent to summarize tasks and post in #ops.')} />
        <p className="row-sub">{t('Created paused. Review the steps before turning it on.')}</p>
        <div className="hx-actions"><button className="pill-btn" disabled={busy !== null || !prompt.trim()} onClick={() => act('generate', async () => { const made = await api.generateWorkflow(prompt); setOpen(await api.workflow(made.workflow.id)); setBuilding(false); setPrompt('') })}>{t(busy === 'generate' ? 'Building…' : 'Build')}</button><button className="btn-text" onClick={() => setManual(v => !v)}>{t('Manual setup')}</button><button className="btn-text" onClick={() => setBuilding(false)}>{t('Cancel')}</button></div>
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
            <span className="row-main">{w.name}{!w.enabled && <span className="hx-off"> · {t('off')}</span>}
              <span className="row-sub">{triggerLabel(t, w.trigger, tables)} · {w.steps.length} {t('steps')}</span>
            </span>
            <span className="row-value">›</span>
          </button>
        ))}
      </div>
    </Shell>
  )
}
