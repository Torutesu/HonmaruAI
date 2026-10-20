import React, { useState } from 'react'
import type { AgentMemory, MemoryKind } from '../utils/harness'
import { useT } from '../utils/i18n'
const kinds: MemoryKind[] = ['preference', 'feedback', 'reference', 'context']
const labels: Record<MemoryKind, string> = { preference: 'Preference', feedback: 'Feedback', reference: 'Reference', context: 'Context' }
export function MemoryKindSelect({ value, onChange, disabled = false }: { value: MemoryKind; onChange: (kind: MemoryKind) => void; disabled?: boolean }) {
  const t = useT()
  return <select className="hx-cell-select" aria-label={t('Memory type')} value={value} disabled={disabled} onChange={e => onChange(e.target.value as MemoryKind)}>{kinds.map(k => <option key={k} value={k}>{t(labels[k])}</option>)}</select>
}
export function AgentMemoryList({ memories, canEdit, busy, onForget }: { memories: AgentMemory[]; canEdit: boolean; busy: boolean; onForget: (memory: AgentMemory) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const visible = memories.filter(m => (kind === 'all' || (m.kind || 'context') === kind) && m.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <>
    <div className="hx-memory-filters">
      <input type="search" className="hx-cell-input" aria-label={t('Search memories')} placeholder={t('Search memories')} value={query} onChange={e => setQuery(e.target.value)} />
      <select className="hx-cell-select" aria-label={t('Filter memory type')} value={kind} onChange={e => setKind(e.target.value)}><option value="all">{t('All memory types')}</option>{kinds.map(k => <option key={k} value={k}>{t(labels[k])}</option>)}</select>
    </div>
    <p className="row-sub" role="status">{t('{shown} of {total} memories', { shown: visible.length, total: memories.length })}</p>
    {visible.map(m => <div key={m.id} className="row static memory-row">
      <span className="row-main"><span className="memory-text">{m.text}</span><span className="row-sub">{t(labels[(m.kind || 'context') as MemoryKind] || m.kind!)} · {t(m.channel ? 'Conversation memory' : 'Shared knowledge')} · {new Date(m.createdAt).toLocaleDateString()}</span></span>
      {canEdit && <button className="btn-text" disabled={busy} onClick={() => onForget(m)}>{t('Forget')}</button>}
    </div>)}
    {!visible.length && <p className="empty">{t(memories.length ? 'No memories match these filters.' : 'No memories yet.')}</p>}
  </>
}
