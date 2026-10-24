import React, {useEffect, useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {isTemp} from '../utils/pendingSend'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'

type Api = {httpBase: string; orgId: string; sessionToken: string}
type Run = {rowId: string; status: string; answered: number; version?: number}
const labels: Record<string, string> = {
  queued: 'Agent execution queued', running: 'Agent execution running',
  finished: 'Agent processing ended', failed: 'Agent execution failed',
  interrupted: 'Agent execution interrupted; outcome unconfirmed',
  cancelled: 'Agent execution stopped after access changed', no_agents: 'No eligible agent to run',
}

export function AgentRunStatus({api, channel, messages}: {api: Api; channel: string; messages: ChannelMessage[]}) {
  const t = useT()
  const sources = [...new Map(messages.filter(m => m.kind === 'message' && !m.deleted && !isTemp(m)).map(m => [m.id, m])).values()].slice(-20)
  const ids = JSON.stringify(sources.map(m => m.id))
  const scope = JSON.stringify([api.httpBase, api.orgId, api.sessionToken, channel, ids])
  const [state, setState] = useState<{scope: string; runs: Run[]; unavailable: boolean}>({scope, runs: [], unavailable: false})
  useEffect(() => {
    const rowIds: string[] = JSON.parse(ids)
    if (!rowIds.length) return
    let stopped = false, busy = false, attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const read = async () => {
      if (stopped || busy || document.visibilityState === 'hidden') return
      clearTimeout(timer)
      busy = true
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10000)
      const query = new URLSearchParams({orgId: api.orgId, channel})
      rowIds.forEach(id => query.append('messageId', id))
      let again = false
      try {
        const response = await fetch(`${api.httpBase}/channels/agent-runs?${query}`, {headers: {'x-session-token': api.sessionToken}, signal: controller.signal})
        if (!response.ok) throw new Error('unavailable')
        const result = await response.json()
        if (!Array.isArray(result.results)) throw new Error('unavailable')
        const runs: Run[] = result.results.filter((run: Run) => rowIds.includes(run.rowId) && labels[run.status])
        if (!stopped) setState({scope, runs, unavailable: result.available === false})
        attempts++
        again = result.available !== false && (runs.some(run => run.status === 'queued' || run.status === 'running') || (attempts < 3 && runs.length < rowIds.length))
      } catch {
        if (!stopped) setState({scope, runs: [], unavailable: true})
        again = ++attempts < 3
      } finally {
        clearTimeout(timeout)
        busy = false
        if (!stopped && again) timer = setTimeout(() => void read(), 5000)
      }
    }
    const resume = () => {attempts = 0; void read()}
    void read()
    window.addEventListener('focus', resume)
    window.addEventListener('honmaru:resync', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      stopped = true; clearTimeout(timer); controller?.abort()
      window.removeEventListener('focus', resume)
      window.removeEventListener('honmaru:resync', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [scope, ids, api.httpBase, api.orgId, api.sessionToken, channel])
  if (state.scope !== scope || (!state.runs.length && !state.unavailable)) return null
  if (state.unavailable) return <p className="slk-run-unavailable">{t('Agent execution status unavailable')}</p>
  const active = state.runs.filter(run => run.status === 'queued' || run.status === 'running').length
  return <details className="slk-agent-runs">
    <summary><span className="slk-run-disclosure"><Icon name="chevron-right" size={12}/></span><Icon name="bot" size={14}/>{t('Agent execution')}{active > 0 && <span className="slk-run-active" role="status">{t('{count} active', {count: active})}</span>}</summary>
    <ul>{state.runs.map(run => <li key={run.rowId}>
      <span className="slk-run-source" title={sources.find(m => m.id === run.rowId)?.body}>{sources.find(m => m.id === run.rowId)?.body.slice(0, 100) || t('Message')}</span>
      <span>{t(labels[run.status])}</span>
    </li>)}</ul>
    <p>{t('Processing ended does not confirm that the task or external actions succeeded.')}</p>
  </details>
}
