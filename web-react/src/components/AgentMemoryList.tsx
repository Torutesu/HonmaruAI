import React, { useState } from 'react'
import type { AgentMemory, MemoryKind } from '../utils/harness'
import { useT } from '../utils/i18n'
const kinds: MemoryKind[] = ['preference', 'feedback', 'reference', 'context']
const labels: Record<MemoryKind, string> = { preference: 'Preference', feedback: 'Feedback', reference: 'Reference', context: 'Context' }
export function MemoryKindSelect({ value, onChange, disabled = false }: { value: MemoryKind; onChange: (kind: MemoryKind) => void; disabled?: boolean }) {
  const t = useT()
  return <select className="hx-cell-select" aria-label={t('Memory type')} value={value} disabled={disabled} onChange={e => onChange(e.target.value as MemoryKind)}>{kinds.map(k => <option key={k} value={k}>{t(labels[k])}</option>)}</select>
}
export function AgentMemoryList({ memories, canEdit, busy, onForget, onEdit, onSearch }: { memories: AgentMemory[]; canEdit: boolean; busy: boolean; onForget: (memory: AgentMemory) => void; onEdit?: (memory: AgentMemory) => void; onSearch?: (query: string, kind: string) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const visible = onSearch ? memories : memories.filter(m => (kind === 'all' || (m.kind || 'context') === kind) && [m.title, m.description, m.body || m.text].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <>
    <form className="hx-memory-filters" onSubmit={e => { e.preventDefault(); onSearch?.(query.trim(), kind) }}>
      <input type="search" className="hx-cell-input" aria-label={t('Search memories')} placeholder={t('Search memories')} value={query} maxLength={200} onChange={e => setQuery(e.target.value)} />
      <select className="hx-cell-select" aria-label={t('Filter memory type')} value={kind} onChange={e => setKind(e.target.value)}><option value="all">{t('All memory types')}</option>{kinds.map(k => <option key={k} value={k}>{t(labels[k])}</option>)}</select>
      {onSearch && <button type="submit" className="btn-text" disabled={busy}>{t('Search')}</button>}
    </form>
    <p className="row-sub" role="status">{onSearch ? t('{count} memories loaded', { count: memories.length }) : t('{shown} of {total} memories', { shown: visible.length, total: memories.length })}</p>
    {visible.map(m => <div key={m.id} className="row static memory-row">
      <span className="row-main">{m.body && (m.body !== m.text || m.description || m.title !== m.text) ? <details className="hx-memory-entry"><summary>{m.title || m.text}</summary>{m.description && <p className="row-sub">{m.description}</p>}<div className="memory-text">{m.body}</div></details> : <span className="memory-text">{m.text}</span>}<span className="row-sub">{t(labels[(m.kind || 'context') as MemoryKind] || m.kind!)} · {t(m.channel ? 'Conversation memory' : 'Agent memory')} · {new Date(m.createdAt).toLocaleDateString()}</span></span>
      {canEdit && onEdit && <button className="btn-text" disabled={busy} onClick={() => onEdit(m)}>{t('Edit memory')}</button>}
      {canEdit && <button className="btn-text" disabled={busy} onClick={() => onForget(m)}>{t('Forget')}</button>}
    </div>)}
    {!visible.length && <p className="empty">{t(memories.length ? 'No memories match these filters.' : 'No memories yet.')}</p>}
  </>
}
