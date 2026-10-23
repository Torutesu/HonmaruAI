import React, { useRef, useState } from 'react'
import { Dialog } from './Dialog'
import type { AgentMemory } from '../utils/harness'
import { useT } from '../utils/i18n'
import './AgentMemoryEditor.css'

export function AgentMemoryReview({ memory, onClose, onSave }: { memory: AgentMemory; onClose: () => void; onSave: (evidence: string) => Promise<void> }) {
  const t = useT(), pending = useRef(false)
  const [evidence, setEvidence] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const close = () => { if (!pending.current) onClose() }
  const save = async () => {
    if (pending.current || !evidence.trim()) return
    pending.current = true; setBusy(true); setError('')
    try { await onSave(evidence.trim()); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Dialog title={t('Review memory')} className="hx-memory-editor" onClose={close} footer={<>
    <button className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button>
    <button className="dlg-btn primary" disabled={busy || !evidence.trim()} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Confirm memory')}</button>
  </>}>
    <strong>{memory.title || memory.text}</strong>
    <div className="hx-run-detail"><pre>{memory.body || memory.text}</pre></div>
    <p className="dlg-hint">{t('Confirm that this content is still correct. Editing alone does not validate a memory.')}</p>
    <label><span className="dlg-label">{t('Review evidence')}</span><textarea className="dlg-input" rows={4} maxLength={2000} disabled={busy} value={evidence} onChange={e => setEvidence(e.target.value)}/></label>
    {error && <p className="dlg-error" role="alert">{t(error)}</p>}
  </Dialog>
}
