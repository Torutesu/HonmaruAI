import React, {useEffect, useRef, useState} from 'react'
import {useT} from '../utils/i18n'

type Props = {api: {httpBase: string; orgId: string; sessionToken: string}; channel: string; rowId: string; assignmentId: string; generation: number; retry?: boolean; onStopped: (remoteStop?: string) => void}
export function AgentRunStop({api, channel, rowId, assignmentId, generation, retry = false, onStopped}: Props) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'pending' | 'stopped' | 'changed' | 'error'>('idle')
  const flight = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => {alive.current = true; return () => {alive.current = false; flight.current?.abort()}}, [])
  const stop = async () => {
    if (flight.current || state === 'stopped') return
    const controller = new AbortController(); flight.current = controller; setState('pending')
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`${api.httpBase}/channels/agent-runs/stop`, {method: 'POST', headers: {'content-type': 'application/json', 'x-session-token': api.sessionToken}, body: JSON.stringify({orgId: api.orgId, channel, messageId: rowId, assignmentId, generation}), signal: controller.signal})
      if (!alive.current) return
      if (response.status === 409) {setState('changed'); onStopped(); return}
      if (!response.ok) throw new Error('unavailable')
      const result = await response.json()
      if (!result.stopped) throw new Error('unavailable')
      if (alive.current) {setState('stopped'); onStopped(typeof result.remoteStop === 'string' ? result.remoteStop : undefined)}
    } catch {if (alive.current) setState('error')}
    finally {clearTimeout(timeout); flight.current = null}
  }
  return <span className="slk-run-stop"><button type="button" disabled={state === 'pending' || state === 'stopped' || state === 'changed'} onClick={() => void stop()}>{t(state === 'pending' ? 'Stopping agent execution…' : state === 'stopped' ? 'Agent execution cancelled' : retry ? 'Retry provider cancellation' : 'Stop execution')}</button>{state === 'changed' && <span role="status">{t('Execution changed; review the current agent before stopping.')}</span>}{state === 'error' && <span role="alert">{t('Could not confirm execution stopped. Refresh or try again.')}</span>}</span>
}
