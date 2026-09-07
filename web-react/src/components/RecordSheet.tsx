import React, { useEffect, useState } from 'react'
import { getLocale } from '../utils/locale'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  onClose: () => void
}

interface Entry { id: string; title: string; summary: string; recipient: string; createdAt: string; actionLabel?: string; actor?: string; decidedAt?: string | null; note?: string | null }
interface Section { slug: string; name: string | null; decided: Entry[]; open: Entry[] }

/// The record: what was decided, per business, written by nobody. A view
/// over the cards, so it is never stale — and one button to take it
/// anywhere as Markdown.
export const RecordSheet: React.FC<Props> = ({ httpBase, orgId, sessionToken, onClose }) => {
  const [sections, setSections] = useState<Section[] | null>(null)
  const [copied, setCopied] = useState(false)
  const locale = getLocale()
  const query = `orgId=${encodeURIComponent(orgId)}&locale=${encodeURIComponent(locale)}`

  useEffect(() => {
    fetch(`${httpBase}/record?${query}`, { headers: { 'x-session-token': sessionToken } })
      .then(async (r) => { if (r.ok) setSections((await r.json()).businesses || []) })
      .catch(() => setSections([]))
  }, [httpBase, query, sessionToken])

  const copy = async () => {
    const res = await fetch(`${httpBase}/record?${query}&format=md`, { headers: { 'x-session-token': sessionToken } })
    const text = await res.text()
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { window.prompt('Copy the record', text) }
  }

  const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')

  return (
    <aside className="sheet sheet-side" role="dialog" aria-label="The record">
      <div className="sheet-title">The record <button className="close" onClick={onClose} aria-label="Close">×</button></div>
      <p className="sheet-hint">Every decision, per business, as it stands now. Nobody writes this; it is what happened.</p>
      <button className="ghost record-copy" onClick={copy}>{copied ? 'Copied' : 'Copy as Markdown'}</button>
      {sections === null && <p className="sheet-hint">Loading…</p>}
      {sections?.length === 0 && <p className="sheet-empty">Nothing decided yet.</p>}
      {sections?.map((s) => (
        <section key={s.slug || '-'} className="record-section">
          <h3>{s.name || 'Not yet filed'}</h3>
          {s.open.length > 0 && (
            <ul className="record-open">
              {s.open.map((c) => <li key={c.id}><span className="record-box" />{c.title} <small>waiting on {c.recipient}</small></li>)}
            </ul>
          )}
          {s.decided.length === 0 && s.open.length === 0 && <p className="sheet-hint">Nothing yet.</p>}
          <ul className="record-decided">
            {s.decided.map((c) => (
              <li key={c.id}>
                <span className="record-date">{day(c.decidedAt)}</span>
                <span className="record-title">{c.title}</span>
                <span className="record-action">{c.actionLabel} · {c.actor}</span>
                {c.note && <span className="record-note">“{c.note}”</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  )
}
