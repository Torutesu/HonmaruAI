import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { agentError, MAX_INSTRUCTIONS, type ClientAgent } from '../utils/agents'
import { Markdown } from '../utils/markdown'
import { Icon } from './Icon'
import './AgentPersona.css'

interface Props {
  agent: { id: string; name: string; instructions?: string; description?: string }
  httpBase: string; orgId: string; sessionToken: string; canEdit: boolean
  onUpdated: (agent: ClientAgent) => void
  onDiscuss?: () => void
}
export function AgentPersona({ agent, httpBase, orgId, sessionToken, canEdit, onUpdated, onDiscuss }: Props) {
  const t = useT()
  const [editing, setEditing] = useState(false), [text, setText] = useState('')
  const [baseline, setBaseline] = useState(''), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false)
  const pending = useRef(false), menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const outside = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) menu.current?.removeAttribute('open') }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); event.stopPropagation(); menu.current.removeAttribute('open') }
    }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape, true) }
  }, [])
  const edit = () => {
    menu.current?.removeAttribute('open')
    setText(agent.instructions || ''); setBaseline(agent.instructions || '')
    setError(''); setConflict(false); setEditing(true)
  }
  const submit = async (reload = false) => {
    if (!canEdit || pending.current || (!reload && (!text.trim() || text.length > MAX_INSTRUCTIONS || conflict))) return
    pending.current = true; setBusy(true); setError('')
    try {
      const response = await fetch(reload ? `${httpBase}/channels/agents?orgId=${encodeURIComponent(orgId)}` : `${httpBase}/channels/agents`, {
        method: reload ? 'GET' : 'PUT',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        ...(reload ? {} : { body: JSON.stringify({ orgId, id: agent.id, instructions: text, expectedInstructions: baseline }) }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 409) setConflict(true)
        throw new Error(data.message || t('That did not save.'))
      }
      const updated = reload ? data.agents?.find((item: ClientAgent) => item.id === agent.id) : data.agent
      if (!updated?.id || typeof updated.instructions !== 'string') throw new Error(t('Could not load the agent.'))
      onUpdated(updated)
      if (reload) { setText(updated.instructions); setBaseline(updated.instructions); setConflict(false) }
      else {
        setEditing(false)
        try { window.dispatchEvent(new Event('honmaru:agents-changed')) } catch { /* no listeners */ }
      }
    } catch (cause) { setError(cause instanceof Error ? agentError(cause.message, t) : String(cause)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <section className="hx-persona" onKeyDown={event => { if (editing && event.key === 'Escape') event.stopPropagation() }}>
    <header><span>{t('Persona')}</span>{editing ? <div className="hx-persona-actions">
      <button disabled={busy} onClick={() => { setEditing(false); setError(''); setConflict(false) }}>{t('Cancel')}</button>
      <button className="hx-persona-save" disabled={!canEdit || busy || conflict || !text.trim() || text.trim() === baseline.trim() || text.length > MAX_INSTRUCTIONS} onClick={() => void submit()}>{t(busy ? 'Saving…' : 'Save persona')}</button>
    </div> : canEdit && <details className="hx-persona-menu" ref={menu}>
      <summary aria-label={t('Edit persona')}><Icon name="edit" size={16}/></summary>
      <div><button onClick={edit}><Icon name="edit" size={15}/>{t('Edit yourself')}</button>
        {onDiscuss && <button onClick={() => { menu.current?.removeAttribute('open'); onDiscuss() }}><Icon name="message" size={15}/>{t('Discuss changes with the agent')}</button>}
      </div>
    </details>}</header>
    {editing ? <>
      <textarea className="hx-persona-editor" aria-label={t('Persona Markdown')} autoFocus disabled={busy || !canEdit} maxLength={MAX_INSTRUCTIONS} value={text} onChange={e => setText(e.target.value)} />
      <p className="hx-persona-hint">{t('Markdown is supported. Saved changes apply to future replies.')}</p>
      {conflict && <button className="btn-text" disabled={busy} onClick={() => void submit(true)}>{t('Discard my draft and reload the latest persona')}</button>}
    </> : <>{agent.description && <p>{agent.description}</p>}<div className="hx-persona-text"><Markdown source={agent.instructions || t('Edit this agent to set its instructions.')} /></div></>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>
}
