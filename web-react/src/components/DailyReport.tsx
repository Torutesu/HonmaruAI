import React, { useEffect, useState } from 'react'
import type { DecisionCard } from '../types/card'
import { useT } from '../utils/i18n'

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

/// Your daily report, drafted by your AI in your voice: read it, change any
/// of it, and post it to the channel under your name. Nothing reaches the
/// channel until you press Post. What you type is kept in this browser, so
/// closing the tab does not lose an edit.
export const DailyReportDraft: React.FC<{
  card: DecisionCard
  api: { httpBase: string; orgId: string; sessionToken: string }
}> = ({ card, api }) => {
  const t = useT()
  const report = card.dailyReport!
  const channel = `#${report.channel.replace(/^b:/, '')}`
  const [text, setText] = useState(() => readDraft(card.id) ?? report.text)
  const [posting, setPosting] = useState(false)
  const [posted, setPosted] = useState<string | null>(report.status === 'posted' ? report.text : null)
  const [error, setError] = useState<string | null>(null)

  // Posted from another device: show what went out.
  useEffect(() => {
    if (report.status === 'posted') { setPosted(report.text); writeDraft(card.id, null) }
  }, [report.status, report.text, card.id])

  const change = (value: string) => {
    setText(value)
    writeDraft(card.id, value === report.text ? null : value)
  }

  const post = async () => {
    const body = text.trim()
    if (!body || posting) return
    setPosting(true); setError(null)
    try {
      const res = await fetch(`${api.httpBase}/channels/daily-report/post`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': api.sessionToken },
        body: JSON.stringify({ orgId: api.orgId, cardId: card.id, text: body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not post. Try again.')); return }
      writeDraft(card.id, null)
      setPosted(data.card?.dailyReport?.text || body)
    } catch {
      setError(t('That did not post. Try again.'))
    } finally {
      setPosting(false)
    }
  }

  if (report.status === 'expired') {
    return (
      <div className="report daily-report">
        <div className="report-meta">{t('This draft was replaced by a newer one.')}</div>
        <div className="daily-posted">{report.text}</div>
      </div>
    )
  }

  if (posted !== null) {
    return (
      <div className="report daily-report">
        <div className="report-meta">{t('Posted to {channel}', { channel })}</div>
        <div className="daily-posted">{posted}</div>
      </div>
    )
  }

  const edited = text !== report.text
  const over = text.length > MAX_CHARS
  // Posting is still the person's call; they are only told first.
  const unwritten = report.fillIn ? text.split(report.fillIn).length - 1 : 0
  return (
    <div className="report daily-report">
      <div className="report-meta">{t('Draft for {channel} — change anything, then post', { channel })}</div>
      <textarea
        className="daily-text"
        value={text}
        rows={16}
        onChange={(e) => change(e.target.value)}
        aria-label={t('Your daily report')}
      />
      <div className="daily-actions">
        <span className={`daily-count${over ? ' over' : ''}`}>{text.length} / {MAX_CHARS}</span>
        {edited && (
          <button type="button" className="btn-text" disabled={posting} onClick={() => change(report.text)}>
            {t('Back to your AI’s draft')}
          </button>
        )}
        <button type="button" className="pill-btn" disabled={posting || !text.trim() || over} onClick={post}>
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
