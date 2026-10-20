import React, { useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { MemoryKindSelect } from './AgentMemoryList'
import type { AgentMemory, MemoryEntryInput, MemoryKind } from '../utils/harness'
import { useT } from '../utils/i18n'

export function AgentMemoryEditor({ memory, onClose, onSave }: { memory?: AgentMemory; onClose: () => void; onSave: (entry: MemoryEntryInput) => Promise<void> }) {
  const t = useT(), pending = useRef(false)
  const [title,setTitle] = useState(memory?.title || memory?.text.slice(0,120) || '')
  const [description,setDescription] = useState(memory?.description || '')
  const [body,setBody] = useState(memory?.body || memory?.text || '')
  const [kind,setKind] = useState<MemoryKind>((memory?.kind || 'context') as MemoryKind)
  const [busy,setBusy] = useState(false), [error,setError] = useState('')
  const close = () => { if (!pending.current) onClose() }
  const save = async () => {
    if (pending.current || !title.trim() || !body.trim()) return
    pending.current = true; setBusy(true); setError('')
    try { await onSave({ title: title.trim(), description: description.trim(), body, kind }); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Dialog title={t(memory ? 'Edit memory' : 'Add detailed memory')} onClose={close} className="hx-memory-editor" footer={<>
    <button className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button>
    <button className="dlg-btn primary" disabled={busy || !title.trim() || !body.trim()} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Save')}</button>
  </>}>
    <label><span className="dlg-label">{t('Title')}</span><input className="dlg-input" value={title} maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)}/></label>
    <label><span className="dlg-label">{t('Description')}</span><textarea className="dlg-input" value={description} maxLength={500} rows={2} disabled={busy} onChange={event => setDescription(event.target.value)}/></label>
    <MemoryKindSelect value={kind} onChange={setKind} disabled={busy}/>
    <label><span className="dlg-label">{t('Memory body')}</span><textarea className="dlg-input" value={body} maxLength={16000} rows={12} disabled={busy} onChange={event => setBody(event.target.value)}/></label>
    <p className="dlg-hint">{t('Use a title and description to find this entry. Line breaks in the body are preserved.')}</p>
    {error && <p className="dlg-error" role="alert">{t(error)}</p>}
  </Dialog>
}
