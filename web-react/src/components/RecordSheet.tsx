import React, { useEffect, useState } from 'react'
import { getLocale } from '../utils/locale'
import { useT } from '../utils/i18n'
import { Markdown } from '../utils/markdown'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  /// The channel open beside it: its record only, with its context.
  channel?: { view: string; name: string } | null
  onClose: () => void
}

interface Entry { id: string; title: string; summary: string; recipient: string; createdAt: string; actionLabel?: string; actor?: string; decidedAt?: string | null; note?: string | null }
interface Section { slug: string; name: string | null; decided: Entry[]; open: Entry[] }

/// The record: what was decided, per business, written by nobody. A view
/// over the cards, so it is never stale — and one button to take it
/// anywhere as Markdown.
export const RecordSheet: React.FC<Props> = ({ httpBase, orgId, sessionToken, channel, onClose }) => {
  const t = useT()
  const [sections, setSections] = useState<Section[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [context, setContext] = useState<{ text: string | null; at: string | null; note: string | null } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const locale = getLocale()
  const query = `orgId=${encodeURIComponent(orgId)}&locale=${encodeURIComponent(locale)}${channel ? `&channel=${encodeURIComponent(channel.view)}` : ''}`

  const load = React.useCallback(async (refresh = false) => {
    try {
      const r = await fetch(`${httpBase}/record?${query}${refresh ? '&refresh=1' : ''}`, { headers: { 'x-session-token': sessionToken } })
      if (!r.ok) { setSections([]); return }
      const data = await r.json()
      setSections(data.businesses || [])
      if (channel) setContext({ text: data.context || null, at: data.contextAt || null, note: data.contextNote || null })
    } catch { setSections([]) }
  }, [httpBase, query, sessionToken, channel])
  useEffect(() => { setSections(null); setContext(null); void load() }, [load])

  const copy = async () => {
    const res = await fetch(`${httpBase}/record?${query}&format=md`, { headers: { 'x-session-token': sessionToken } })
    const text = await res.text()
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { window.prompt(t('Copy the record'), text) }
  }

  const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')

  return (
    <aside className="sheet sheet-side" role="dialog" aria-modal="true" aria-label={t('The record')}>
      <div className="sheet-title">{channel ? t('#{name}: the record', { name: channel.name }) : t('The record')} <button className="close" onClick={onClose} aria-label={t('Close')}>×</button></div>
      <p className="sheet-hint">{channel ? t('record.channelHint') : t('record.hint')}</p>
      <button className="ghost record-copy" onClick={copy}>{copied ? t('Copied') : t('Copy as Markdown')}</button>
      {sections === null && <p className="sheet-hint">{channel ? t('Reading the channel and writing its context…') : t('Loading…')}</p>}
      {channel && context && (
        <section className="record-context" data-record-context="1">
          <h3>{t('Context')}</h3>
          {context.text
            ? <Markdown source={context.text} className="record-md" />
            : <p className="sheet-hint">{context.note === 'noModel' ? t('No AI model is set up, so the context is not written yet.') : context.note === 'quota' ? t('Today’s AI answers are used up; the context is written tomorrow.') : t('Nothing said here yet.')}</p>}
          {context.at && (
            <p className="sheet-hint record-context-at">
              {t('Written {when}', { when: new Date(context.at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}
              {' · '}
              <button type="button" className="linkish" disabled={refreshing} onClick={async () => { setRefreshing(true); await load(true); setRefreshing(false) }}>{refreshing ? t('Writing…') : t('Write again')}</button>
            </p>
          )}
        </section>
      )}
      {channel && sections && <h3 className="record-decisions-title">{t('Decisions')}</h3>}
      {sections?.length === 0 && <p className="sheet-empty">{t('Nothing decided yet.')}</p>}
      {sections?.map((s) => (
        <section key={s.slug || '-'} className="record-section">
          {!channel && <h3>{s.name || t('Not yet filed')}</h3>}
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
