import React, { useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { AgentAvatar } from './AgentAvatar'
import { useT } from '../utils/i18n'
import type { AgentProfile } from '../utils/harness'
import './NewHarnessAgent.css'

interface Props {
  agent: { id: string; name: string; emoji?: string | null; avatarUrl?: string | null }
  profile: AgentProfile
  onClose: () => void
  onSave: (patch: { name: string; emoji: string; specialty: string; tier: AgentProfile['tier'] }) => Promise<void>
}
const faces = ['🤖', '🔎', '🧭', '📚', '🛠️', '🌿']
export function EditAgentProfile({ agent, profile, onClose, onSave }: Props) {
  const t = useT()
  const [name, setName] = useState(agent.name), [emoji, setEmoji] = useState(agent.emoji || '')
  const [specialty, setSpecialty] = useState(profile.specialty), [tier, setTier] = useState(profile.tier)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false)
  const close = () => { if (!pending.current) onClose() }
  const changed = name.trim() !== agent.name || emoji !== (agent.emoji || '') || specialty.trim() !== profile.specialty || tier !== profile.tier
  const save = async () => {
    if (pending.current || !name.trim() || !changed) return
    pending.current = true; setBusy(true); setError('')
    try { await onSave({ name: name.trim(), emoji, specialty: specialty.trim(), tier }); onClose() }
    catch (cause) { setError(t(cause instanceof Error ? cause.message : 'That did not save.')) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Dialog className="hx-new-agent" title={t('Edit agent profile')} onClose={close} footer={<>
    <button className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button>
    <button className="dlg-btn primary" disabled={busy || !changed || !name.trim()} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Save')}</button>
  </>}>
    <button className="hx-new-agent-face" disabled={busy || !!agent.avatarUrl} onClick={() => setEmoji(faces[(faces.indexOf(emoji) + 1) % faces.length])} aria-label={t('Choose another avatar')}>
      <AgentAvatar agent={{ ...agent, emoji, avatarUrl: emoji !== (agent.emoji || '') ? null : agent.avatarUrl }} /><small>{t('Choose another avatar')}</small>
    </button>
    <label><span className="dlg-label">{t('Display name')}</span><input className="dlg-input" autoFocus maxLength={40} value={name} disabled={busy} onChange={e => setName(e.target.value)}/></label>
    <label><span className="dlg-label">{t('Specialty')}</span><input className="dlg-input" maxLength={120} value={specialty} disabled={busy} onChange={e => setSpecialty(e.target.value)} placeholder={t('e.g. Research and synthesis')}/><p className="dlg-hint">{t('Help teammates understand what this agent is good at.')}</p></label>
    <label><span className="dlg-label">{t('Intelligence')}</span><select className="dlg-input" disabled={busy} value={tier} onChange={e => setTier(e.target.value as AgentProfile['tier'])}>
      <option value="lite">{t('Fast')}</option><option value="standard">{t('Pro')}</option><option value="max">{t('Max')}</option>
    </select></label>
    {error && <p role="alert" className="form-error">{error}</p>}
  </Dialog>
}
