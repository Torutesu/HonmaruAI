import React, { useEffect, useState } from 'react'
import { getLocale } from '../utils/locale'
import { useT } from '../utils/i18n'

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
  const t = useT()
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
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { window.prompt(t('Copy the record'), text) }
  }

  const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')

  return (
    <aside className="sheet sheet-side" role="dialog" aria-modal="true" aria-label={t('The record')}>
      <div className="sheet-title">{t('The record')} <button className="close" onClick={onClose} aria-label={t('Close')}>×</button></div>
      <p className="sheet-hint">{t('record.hint')}</p>
      <button className="ghost record-copy" onClick={copy}>{copied ? t('Copied') : t('Copy as Markdown')}</button>
      {sections === null && <p className="sheet-hint">{t('Loading…')}</p>}
      {sections?.length === 0 && <p className="sheet-empty">{t('Nothing decided yet.')}</p>}
      {sections?.map((s) => (
        <section key={s.slug || '-'} className="record-section">
          <h3>{s.name || t('Not yet filed')}</h3>
          {s.open.length > 0 && (
            <ul className="record-open">
              {s.open.map((c) => <li key={c.id}><span className="record-box" />{c.title} <small>{t('Waiting on {name}', { name: c.recipient })}</small></li>)}
            </ul>
          )}
          {s.decided.length === 0 && s.open.length === 0 && <p className="sheet-hint">{t('Nothing yet.')}</p>}
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
