import React, { useEffect, useRef, useState } from 'react'
import type { DecisionCard } from '../types/card'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

/// A channel message holds this many characters.
const MAX_CHARS = 4000

const draftKey = (cardId: string) => `daily-draft:${cardId}`

function readDraft(cardId: string): string | null {
  try { return localStorage.getItem(draftKey(cardId)) } catch { return null }
}

function writeDraft(cardId: string, text: string | null): void {
  try {
    if (text === null) localStorage.removeItem(draftKey(cardId))
    else localStorage.setItem(draftKey(cardId), text)
  } catch { /* the draft is still on screen */ }
}

interface Exchange { ask: string; note: string | null; pending?: boolean }

/// Your daily report, drafted by your AI in your voice: read it, change any
/// of it — by hand, or by asking your AI ("shorter", "add that the cost
/// sheet is done") — and post it to the channel under your name. Nothing
/// reaches the channel until you press Post. What you type is kept on the
/// server as you go, so the phone opens where the laptop left off.
///
/// The same draft shows on its card in the feed and, in the list, in the
/// channel it is for, just above the box you write in (`inChannel`).
export const DailyReportDraft: React.FC<{
  card: DecisionCard
  api: { httpBase: string; orgId: string; sessionToken: string }
  inChannel?: boolean
  onPosted?: () => void
}> = ({ card, api, inChannel, onPosted }) => {
  const t = useT()
  const report = card.dailyReport!
  const channel = `#${report.channel.replace(/^b:/, '')}`
  const [text, setText] = useState(() => readDraft(card.id) ?? report.text)
  const [posting, setPosting] = useState(false)
  const [posted, setPosted] = useState<string | null>(report.status === 'posted' ? report.text : null)
  const [error, setError] = useState<string | null>(null)
  const [ask, setAsk] = useState('')
  const [talk, setTalk] = useState<Exchange[]>([])
  const [open, setOpen] = useState(!inChannel)
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const headers = { 'content-type': 'application/json', 'x-session-token': api.sessionToken }

  // Posted from another device: show what went out.
  useEffect(() => {
    if (report.status === 'posted') { setPosted(report.text); writeDraft(card.id, null) }
  }, [report.status, report.text, card.id])
  // Changed on another device, and not being typed in here: take theirs.
  useEffect(() => {
    if (!dirty.current && report.status === 'draft') setText(readDraft(card.id) ?? report.text)
  }, [report.text, report.status, card.id])
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const save = (value: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void fetch(`${api.httpBase}/channels/daily-report/draft`, {
        method: 'PUT', headers, body: JSON.stringify({ orgId: api.orgId, cardId: card.id, text: value }),
      }).then((r) => { if (r.ok) { dirty.current = false; writeDraft(card.id, null) } }).catch(() => { /* kept in this browser */ })
    }, 900)
  }

  const change = (value: string) => {
    dirty.current = true
    setText(value)
    writeDraft(card.id, value)
    save(value)
  }

  const refine = async (request: string) => {
    const said = request.trim()
    if (!said || talk.some((x) => x.pending)) return
    setAsk(''); setError(null)
    setTalk((prev) => [...prev, { ask: said, note: null, pending: true }])
    if (saveTimer.current) clearTimeout(saveTimer.current)
    try {
      const res = await fetch(`${api.httpBase}/channels/daily-report/refine`, {
        method: 'POST', headers, body: JSON.stringify({ orgId: api.orgId, cardId: card.id, text, ask: said }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work. Try again.')); setTalk((prev) => prev.filter((x) => !x.pending)); return }
      dirty.current = false
      writeDraft(card.id, null)
      setText(data.text)
      setTalk((prev) => prev.map((x) => (x.pending ? { ask: x.ask, note: data.note || t('Done.') } : x)))
    } catch {
      setError(t('That did not work. Try again.'))
      setTalk((prev) => prev.filter((x) => !x.pending))
    }
  }

  const post = async () => {
    const body = text.trim()
    if (!body || posting) return
    setPosting(true); setError(null)
    try {
      const res = await fetch(`${api.httpBase}/channels/daily-report/post`, {
        method: 'POST', headers, body: JSON.stringify({ orgId: api.orgId, cardId: card.id, text: body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not post. Try again.')); return }
      if (saveTimer.current) clearTimeout(saveTimer.current)
      writeDraft(card.id, null)
      setPosted(data.card?.dailyReport?.text || body)
      onPosted?.()
    } catch {
      setError(t('That did not post. Try again.'))
    } finally {
      setPosting(false)
    }
  }

  if (report.status === 'expired') {
    if (inChannel) return null
    return (
      <div className="report daily-report">
        <div className="report-meta">{t('This draft was replaced by a newer one.')}</div>
        <div className="daily-posted">{report.text}</div>
      </div>
    )
  }

  if (posted !== null) {
    if (inChannel) return null
    return (
      <div className="report daily-report">
        <div className="report-meta">{t('Posted to {channel}', { channel })}</div>
        <div className="daily-posted">{posted}</div>
      </div>
    )
  }

  const over = text.length > MAX_CHARS
  // Posting is still the person's call; they are only told first.
  const unwritten = report.fillIn ? text.split(report.fillIn).length - 1 : 0
  const busy = talk.some((x) => x.pending)
  const SUGGEST = [t('Make it shorter'), t('More polite'), t('Tidy the bullets')]

  if (inChannel && !open) {
    return (
      <div className="daily-report daily-in-channel folded" data-daily-draft={card.id}>
        <button type="button" className="daily-fold" onClick={() => setOpen(true)}>
          <Icon name="edit" size={14} />
          <span><b>{card.title}</b> · {t('Your draft, only you can see it')}</span>
          <span className="daily-fold-open">{t('Review and post')}</span>
        </button>
      </div>
    )
  }

  return (
    <div className={`report daily-report${inChannel ? ' daily-in-channel' : ''}`} data-daily-draft={card.id}>
      <div className="report-meta">
        {inChannel
          ? <><Icon name="edit" size={13} /> <b>{card.title}</b> · {t('Your draft, only you can see it')}</>
          : t('Draft for {channel} — change anything, then post', { channel })}
        {inChannel && <button type="button" className="daily-fold-close" onClick={() => setOpen(false)} aria-label={t('Fold')}><Icon name="chevron-down" size={14} /></button>}
      </div>
      <textarea
        className="daily-text"
        value={text}
        rows={inChannel ? 10 : 16}
        onChange={(e) => change(e.target.value)}
        aria-label={t('Your daily report')}
        disabled={busy}
      />
      <div className="daily-ai">
        {talk.length > 0 && (
          <ol className="daily-talk" aria-live="polite">
            {talk.map((x, i) => (
              <li key={i}>
                <span className="daily-ask">{x.ask}</span>
                <span className="daily-note">{x.pending ? t('Your AI is rewriting it…') : x.note}</span>
              </li>
            ))}
          </ol>
        )}
        {talk.length === 0 && (
          <div className="daily-suggest">
            {SUGGEST.map((s) => <button key={s} type="button" className="daily-chip" disabled={busy} onClick={() => void refine(s)}>{s}</button>)}
          </div>
        )}
        <form className="daily-ask-form" onSubmit={(e) => { e.preventDefault(); void refine(ask) }}>
          <Icon name="sparkle" size={14} />
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder={t('Ask your AI to change it — “add that the cost sheet is done”')}
            aria-label={t('Ask your AI to change the draft')}
            disabled={busy}
            data-daily-ask="1"
          />
          <button type="submit" className="btn-text" disabled={busy || !ask.trim()}>{t('Ask')}</button>
        </form>
      </div>
      <div className="daily-actions">
        <span className={`daily-count${over ? ' over' : ''}`}>{text.length} / {MAX_CHARS}</span>
        <button type="button" className="pill-btn" disabled={posting || busy || !text.trim() || over} onClick={post} data-daily-post="1">
          {posting ? t('Posting…') : t('Post to {channel}', { channel })}
        </button>
      </div>
      {unwritten > 0 && (
        <p className="auto-hint daily-unwritten">{t('{count} lines still ask for your own words.', { count: unwritten })}</p>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  )
}
