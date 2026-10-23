import React, { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { MemoryKindSelect } from './AgentMemoryList'
import type { AgentMemory, MemoryEntryInput, MemoryKind } from '../utils/harness'
import { useT } from '../utils/i18n'
import './AgentMemoryEditor.css'

export function AgentMemoryReview({ memory, onClose, onSave }: { memory: AgentMemory; onClose: () => void; onSave: (evidence: string, entry?: MemoryEntryInput) => Promise<void> }) {
  const t = useT(), pending = useRef(false)
  const errorElement = useRef<HTMLParagraphElement>(null)
  const [evidence, setEvidence] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [updating, setUpdating] = useState(false)
  const [entry, setEntry] = useState<MemoryEntryInput>({ title: memory.title || memory.text.slice(0,120), description: memory.description || '', body: memory.body || memory.text, kind: (memory.kind || 'context') as MemoryKind })
  const valid = evidence.trim() && (!updating || (entry.title.trim() && entry.body.trim()))
  useEffect(() => { if (error) errorElement.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  const close = () => { if (!pending.current) onClose() }
  const save = async () => {
    if (pending.current || !valid) return
    pending.current = true; setBusy(true); setError('')
    try { await onSave(evidence.trim(), updating ? entry : undefined); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Dialog title={t('Review memory')} className="hx-memory-editor" onClose={close} footer={<>
    <button className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button>
    <button className="dlg-btn primary" disabled={busy || !valid} onClick={() => void save()}>{t(busy ? 'Saving…' : updating ? 'Update and confirm memory' : 'Confirm memory')}</button>
  </>}>
    <label><input type="checkbox" checked={updating} disabled={busy} onChange={e => setUpdating(e.target.checked)}/> {t('Update content while reviewing')}</label>
    {updating ? <>
      <label><span className="dlg-label">{t('Title')}</span><input className="dlg-input" value={entry.title} maxLength={120} disabled={busy} onChange={e => setEntry({...entry,title:e.target.value})}/></label>
      <label><span className="dlg-label">{t('Description')}</span><textarea className="dlg-input" rows={2} value={entry.description} maxLength={500} disabled={busy} onChange={e => setEntry({...entry,description:e.target.value})}/></label>
      <label><span className="dlg-label">{t('Memory type')}</span><MemoryKindSelect value={entry.kind} disabled={busy} onChange={kind => setEntry({...entry,kind})}/></label>
      <label><span className="dlg-label">{t('Memory body')}</span><textarea className="dlg-input" rows={8} value={entry.body} maxLength={16000} disabled={busy} onChange={e => setEntry({...entry,body:e.target.value})}/></label>
    </> : <><strong>{memory.title || memory.text}</strong><div className="hx-run-detail"><pre>{memory.body || memory.text}</pre></div></>}
    <p className="dlg-hint">{t('Confirm that this content is still correct. Editing alone does not validate a memory.')}</p>
    <label><span className="dlg-label">{t('Review evidence')}</span><textarea className="dlg-input" rows={4} maxLength={2000} disabled={busy} value={evidence} onChange={e => setEvidence(e.target.value)}/></label>
    {error && <p ref={errorElement} className="dlg-error" role="alert">{t(error)}</p>}
  </Dialog>
}
