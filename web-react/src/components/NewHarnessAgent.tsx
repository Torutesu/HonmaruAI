import React, { useRef, useState } from 'react'
import { AgentTierSelect, type AgentTier } from './AgentTierSelect'
import { Dialog } from './Dialog'
import { useT } from '../utils/i18n'
import { agentError, type ClientAgent } from '../utils/agents'
import './NewHarnessAgent.css'

interface Props {
  httpBase: string; orgId: string; sessionToken: string
  onClose: () => void
  onCreated: (agent: ClientAgent, agents: ClientAgent[]) => void
  onAdvanced?: () => void
}
const faces = ['🤖', '🔎', '🧭', '📚', '🛠️', '🌿']
export function NewHarnessAgent({ httpBase, orgId, sessionToken, onClose, onCreated, onAdvanced }: Props) {
  const t = useT()
  const [name, setName] = useState(''), [specialty, setSpecialty] = useState('')
  const [tier, setTier] = useState<AgentTier>('standard'), [face, setFace] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false)
  // Keep the same handle on retries, so an uncertain network response cannot
  // accidentally create a second agent under a different generated handle.
  const handle = useRef(`agent-${crypto.randomUUID().slice(0, 8)}`)
  const close = () => { if (!pending.current) onClose() }
  const create = async () => {
    if (pending.current || !name.trim()) return
    pending.current = true; setBusy(true); setError('')
    try {
      const instructions = `You are ${name.trim()}, a teammate in this workspace.${specialty.trim() ? ` Your specialty is ${specialty.trim()}.` : ''} Help with the user's requests, ask when essential information is missing, and distinguish verified results from assumptions. Only use tools and data you are authorized to access.`
      const response = await fetch(`${httpBase}/channels/agents`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, name: name.trim(), handle: handle.current, emoji: faces[face], description: specialty.trim(), instructions, scope: 'personal', profile: { specialty: specialty.trim(), tier } }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || t('Could not create the agent.'))
      if (!data.agent?.id) throw new Error(t('Could not create the agent.'))
      try { window.dispatchEvent(new Event('honmaru:agents-changed')) } catch { /* no listeners */ }
      onCreated(data.agent, Array.isArray(data.agents) ? data.agents : [data.agent])
    } catch (cause) {
      setError(cause instanceof Error ? agentError(cause.message, t) : String(cause))
    } finally { pending.current = false; setBusy(false) }
  }
  return <Dialog className="hx-new-agent" title={t('New agent')}
    lede={t('Give your agent a name and a face. It starts private and has no access to existing rooms. Add it to a room after creation.')}
    onClose={close} footer={<>
      <button className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button>
      <button className="dlg-btn primary" disabled={busy || !name.trim()} onClick={() => void create()}>{t(busy ? 'Creating…' : 'Create')}</button>
    </>}>
    <button className="hx-new-agent-face" disabled={busy} onClick={() => setFace((face + 1) % faces.length)} aria-label={t('Choose another avatar')}>
      <span aria-hidden="true">{faces[face]}</span><small>{t('Choose another avatar')}</small>
    </button>
    <label><span className="dlg-label">{t('Name')}</span><input className="dlg-input" autoFocus maxLength={40} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder={t('e.g. Atlas')} /></label>
    <label><span className="dlg-label">{t('Specialty')}</span><input className="dlg-input" maxLength={120} value={specialty} disabled={busy} onChange={e => setSpecialty(e.target.value)} placeholder={t('e.g. Research and synthesis')} /><p className="dlg-hint">{t('Help teammates understand what this agent is good at.')}</p></label>
    <div><span className="dlg-label">{t('How it runs')}</span><div className="hx-new-agent-runtime">{t('Workspace AI')}<p className="dlg-hint">{t('Uses this workspace’s configured AI provider. Creation does not run the model.')}</p></div></div>
    <div><span className="dlg-label">{t('Intelligence')}</span><AgentTierSelect value={tier} disabled={busy} onChange={setTier}/></div>
    <p className="dlg-hint">{t('Starts with basic instructions based on the name and specialty. You can edit its persona after creation.')}</p>
    {onAdvanced && <button className="dlg-btn link" disabled={busy} onClick={() => { close(); onAdvanced() }}>{t('Open the detailed agent editor')}</button>}
    {error && <p className="dlg-error" role="alert">{error}</p>}
  </Dialog>
}
