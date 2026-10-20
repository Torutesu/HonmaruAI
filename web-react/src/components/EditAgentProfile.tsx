import React, { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { AgentAvatar } from './AgentAvatar'
import { useT } from '../utils/i18n'
import type { AgentProfile } from '../utils/harness'
import './NewHarnessAgent.css'

interface Props {
  agent: { id: string; name: string; emoji?: string | null; avatarUrl?: string | null }
  profile: AgentProfile
  onClose: () => void
  onSave: (patch: { name: string; emoji: string; specialty: string; tier: AgentProfile['tier'] }, picture?: File | null) => Promise<void>
}
const faces = ['🤖', '🔎', '🧭', '📚', '🛠️', '🌿']
export function EditAgentProfile({ agent, profile, onClose, onSave }: Props) {
  const t = useT()
  const [name, setName] = useState(agent.name), [emoji, setEmoji] = useState(agent.emoji || '')
  const [specialty, setSpecialty] = useState(profile.specialty), [tier, setTier] = useState(profile.tier)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false), pictureInput = useRef<HTMLInputElement>(null)
  const [picture, setPicture] = useState<{ file: File; url: string } | null>(null)
  const [removePicture, setRemovePicture] = useState(false)
  useEffect(() => () => { if (picture) URL.revokeObjectURL(picture.url) }, [picture])
  const choosePicture = (file?: File) => {
    if (!file || pending.current) return
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setError(t('A picture is a PNG, JPEG, WebP or GIF.')); return }
    if (file.size > 2 * 1024 * 1024) { setError(t('A picture is at most 2 MB.')); return }
    setPicture({ file, url: URL.createObjectURL(file) }); setRemovePicture(false); setError('')
  }
  const close = () => { if (!pending.current) onClose() }
  const changed = !!picture || removePicture || name.trim() !== agent.name || emoji !== (agent.emoji || '') || specialty.trim() !== profile.specialty || tier !== profile.tier
  const save = async () => {
    if (pending.current || !name.trim() || !changed) return
    pending.current = true; setBusy(true); setError('')
    try { await onSave({ name: name.trim(), emoji, specialty: specialty.trim(), tier }, picture?.file || (removePicture ? null : undefined)); onClose() }
    catch (cause) { setError(t(cause instanceof Error ? cause.message : 'That did not save.')) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Dialog className="hx-new-agent" title={t('Edit agent profile')} onClose={close} footer={<>
    <button className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button>
    <button className="dlg-btn primary" disabled={busy || !changed || !name.trim()} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Save')}</button>
  </>}>
    <input ref={pictureInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { choosePicture(e.target.files?.[0]); e.target.value = '' }}/>
    <div className="hx-edit-agent-avatar">
      <button className="hx-new-agent-face" disabled={busy} onClick={() => pictureInput.current?.click()} aria-label={t('Change the picture')}>
        <AgentAvatar agent={{ ...agent, emoji, avatarUrl: picture?.url || (removePicture ? null : agent.avatarUrl) }} />
      </button>
      <button className="btn-text" disabled={busy} onClick={() => { setEmoji(faces[(faces.indexOf(emoji) + 1) % faces.length]); setPicture(null); setRemovePicture(!!agent.avatarUrl) }}>{t('Choose another avatar')}</button>
      {(picture || (agent.avatarUrl && !removePicture)) && <button className="btn-text" disabled={busy} onClick={() => { setPicture(null); setRemovePicture(!!agent.avatarUrl) }}>{t('Remove picture')}</button>}
    </div>
    <label><span className="dlg-label">{t('Display name')}</span><input className="dlg-input" autoFocus maxLength={40} value={name} disabled={busy} onChange={e => setName(e.target.value)}/></label>
    <label><span className="dlg-label">{t('Specialty')}</span><input className="dlg-input" maxLength={120} value={specialty} disabled={busy} onChange={e => setSpecialty(e.target.value)} placeholder={t('e.g. Research and synthesis')}/><p className="dlg-hint">{t('Help teammates understand what this agent is good at.')}</p></label>
    <label><span className="dlg-label">{t('Intelligence')}</span><select className="dlg-input" disabled={busy} value={tier} onChange={e => setTier(e.target.value as AgentProfile['tier'])}>
      <option value="lite">{t('Fast')}</option><option value="standard">{t('Pro')}</option><option value="max">{t('Max')}</option>
    </select></label>
    {error && <p role="alert" className="form-error">{error}</p>}
  </Dialog>
}
