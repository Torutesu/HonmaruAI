import React, {useEffect, useMemo, useState} from 'react'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'
import {formatElapsedDuration} from '../utils/runDuration'
import {Icon} from './Icon'
import './AgentToolTrace.css'

type Api = {httpBase: string; orgId: string; sessionToken: string}
type Step = {name: string; status: 'completed' | 'failed' | 'interrupted'; elapsedMs: number}
type Trace = {startedAt: string; finishedAt: string; elapsedMs: number; steps: Step[]}

function safeTrace(value: unknown): Trace | null {
  if (!value || typeof value !== 'object') return null
  const trace = value as Partial<Trace>
  if (typeof trace.startedAt !== 'string' || !Number.isFinite(Date.parse(trace.startedAt)) ||
      typeof trace.finishedAt !== 'string' || !Number.isFinite(Date.parse(trace.finishedAt)) ||
      !Number.isFinite(trace.elapsedMs) || !Array.isArray(trace.steps)) return null
  const steps = trace.steps.filter((step): step is Step => Boolean(step) && typeof step.name === 'string' &&
    ['completed', 'failed', 'interrupted'].includes(step.status) && Number.isFinite(step.elapsedMs)).slice(0, 16)
  return steps.length ? {startedAt: trace.startedAt, finishedAt: trace.finishedAt, elapsedMs: trace.elapsedMs!, steps} : null
}

export function AgentToolTrace({api, channel, messageId}: {api: Api; channel: string; messageId: string}) {
  const t = useT()
  const scope = useMemo(() => JSON.stringify([api.httpBase, api.orgId, api.sessionToken, channel, messageId]), [api.httpBase, api.orgId, api.sessionToken, channel, messageId])
  const [state, setState] = useState<{scope: string; status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'; trace?: Trace}>({scope, status: 'idle'})
  useEffect(() => { setState({scope, status: 'idle'}) }, [scope])
  if (state.scope !== scope || state.status === 'missing') return null
  const load = async (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || state.status !== 'idle') return
    setState({scope, status: 'loading'})
    try {
      const query = new URLSearchParams({orgId: api.orgId, channel, messageId})
      const response = await fetch(`${api.httpBase}/channels/agent-tool-traces?${query}`, {headers: {'x-session-token': api.sessionToken}})
      if (response.status === 404) {setState({scope, status: 'missing'}); return}
      if (!response.ok) throw new Error('unavailable')
      const payload = await response.json()
      const trace = safeTrace(payload?.trace)
      setState(trace ? {scope, status: 'ready', trace} : {scope, status: 'missing'})
    } catch { setState({scope, status: 'error'}) }
  }
  const trace = state.status === 'ready' ? state.trace : null
  return <details className="slk-agent-tool-trace" onToggle={load}>
    <summary><span className="slk-agent-tool-trace-chevron"><Icon name="chevron-right" size={12}/></span><Icon name="tools" size={13}/><span>{t('Worked for')}</span>{trace && <span className="slk-agent-tool-trace-duration">{formatElapsedDuration(trace.startedAt, trace.finishedAt, getLocale())}</span>}</summary>
    {state.status === 'loading' && <p role="status">{t('Loading execution details…')}</p>}
    {state.status === 'error' && <p role="status">{t('Execution details unavailable')} <button type="button" onClick={event => {setState({scope, status: 'idle'}); const disclosure = event.currentTarget.closest('details'); if (disclosure) disclosure.open = false}}>{t('Retry')}</button></p>}
    {trace && <ol>{trace.steps.map((step, index) => <li key={`${index}:${step.name}`}>
      <span className="slk-agent-tool-step-icon" data-status={step.status} aria-hidden="true"><Icon name={step.status === 'completed' ? 'check' : step.status === 'failed' ? 'x' : 'clock'} size={12}/></span>
      <span className="slk-agent-tool-step-name">{step.name}</span>
      <span className="slk-agent-tool-step-status">{t(step.status === 'completed' ? 'Completed' : step.status === 'failed' ? 'Failed' : 'Interrupted')}</span>
      <span className="slk-agent-tool-step-time">{formatElapsedDuration(new Date(0).toISOString(), new Date(step.elapsedMs).toISOString(), getLocale())}</span>
    </li>)}</ol>}
  </details>
}
