import React, { useState } from 'react'
import type { Business } from '../types/card'

interface Props {
  businesses: Business[]
  selected: string | null          // slug, or null for everything
  counts: Record<string, number>   // pending per slug; '' for untagged
  onSelect: (slug: string | null) => void
  onAdd: (name: string) => Promise<void>
}

/// The businesses this organization runs, as a row of chips over the feed.
/// Ten businesses is the design point; one person reads them one at a time.
/// A new one is a name typed here — or on any card — and nothing more.
export const BusinessBar: React.FC<Props> = ({ businesses, selected, counts, onSelect, onAdd }) => {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const total = Object.values(counts).reduce((n, c) => n + c, 0)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setAdding(false); return }
    await onAdd(trimmed)
    setName('')
    setAdding(false)
  }

  return (
    <div className="business-bar" role="tablist" aria-label="Businesses">
      <button
        role="tab"
        aria-selected={selected === null}
        className={`business-chip${selected === null ? ' selected' : ''}`}
        onClick={() => onSelect(null)}
      >
        All{total > 0 && <span className="chip-count">{total}</span>}
      </button>
      {businesses.map((b) => (
        <button
          key={b.slug}
          role="tab"
          aria-selected={selected === b.slug}
          className={`business-chip${selected === b.slug ? ' selected' : ''}`}
          onClick={() => onSelect(selected === b.slug ? null : b.slug)}
        >
          {b.name}{(counts[b.slug] || 0) > 0 && <span className="chip-count">{counts[b.slug]}</span>}
        </button>
      ))}
      {(counts[''] || 0) > 0 && businesses.length > 0 && (
        <button
          role="tab"
          aria-selected={selected === ''}
          className={`business-chip muted${selected === '' ? ' selected' : ''}`}
          onClick={() => onSelect(selected === '' ? null : '')}
        >
          Unfiled<span className="chip-count">{counts['']}</span>
        </button>
      )}
      {adding ? (
        <form className="business-add" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={submit}
            placeholder="New business"
            aria-label="New business name"
          />
        </form>
      ) : (
        <button className="business-chip add" onClick={() => setAdding(true)} aria-label="Add a business">+</button>
      )}
    </div>
  )
}
