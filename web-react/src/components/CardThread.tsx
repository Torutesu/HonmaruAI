import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { displayName } from '../utils/names'
import { getLocale } from '../utils/locale'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  cardId: string
  /// Who is reading, so their own actions say "You" rather than their login.
  userId?: string
  /// Anything that means "something happened to this card since": the
  /// decision's time, the status. A change refetches.
  version: string
  /// Open from the start (a laptop, where there is room) or behind a line
  /// the person taps (a phone, where the card is the screen).
  alwaysOpen: boolean
}

export interface CardEvent {
  id: string
  cardId: string
  type: string
  action?: string | null
  actorUserId?: string | null
  note?: string | null
  createdAt: string
}

// What happened, as a word. English keys, translated where read.
const EVENT_WORD: Record<string, string> = {
  created: 'Created', updated: 'Updated', deleted: 'Deleted', rolled_back: 'Undone',
  nudged: 'Nudged', asked: 'Asked your AI', drafted: 'Reply drafted', replied: 'Reply sent', filed: 'Filed',
  feedback: 'Flagged as wrong', localized: 'Translated',
}
// A flag's note is the reason's wire name; the person wrote none of it.
const REASON_WORD: Record<string, string> = {
  'wrong-person': 'Wrong person', 'not-a-decision': 'Not a decision',
  'wrong-priority': 'Wrong priority', 'wrong-words': 'Badly written', other: 'Other',
}
const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred',
}
export function eventWord(ev: { type: string; action?: string | null }): string {
  if (ev.type === 'decided') return ACTION_WORD[ev.action || ''] || 'Decided'
  return EVENT_WORD[ev.type] || ev.type
}

function when(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const sameDay = d.toDateString() === new Date().toDateString()
  // The app's own language for the clock, not the browser's: a Japanese
  // interface showed "6:07 AM" between 作成 and 却下.
  const locale = getLocale()
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

/// Everything that happened to one card, oldest first: made, nudged, asked
/// about, decided, drafted, sent, undone. The relay logs all of it and
/// nothing on the web showed it — a card that had been asked about twice
/// and replied to looked exactly like one nobody had touched.
export const CardThread: React.FC<Props> = ({ httpBase, orgId, sessionToken, cardId, userId, version, alwaysOpen }) => {
  const t = useT()
  const [open, setOpen] = useState(alwaysOpen)
  const [events, setEvents] = useState<CardEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (alwaysOpen) setOpen(true) }, [alwaysOpen])

  useEffect(() => {
    if (!open) return
    let ignore = false
    fetch(`${httpBase}/cards/${encodeURIComponent(cardId)}/events?orgId=${encodeURIComponent(orgId)}`, {
      headers: { 'x-session-token': sessionToken },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || t('Could not load what happened.'))
        return r.json()
      })
      .then((data) => { if (!ignore) { setEvents(data.events || []); setError(null) } })
      .catch((err) => { if (!ignore) setError(err instanceof Error ? err.message : String(err)) })
    return () => { ignore = true }
  }, [open, httpBase, orgId, sessionToken, cardId, version, t])

  if (!open) {
    return (
      <button type="button" className="thread-toggle" onClick={() => setOpen(true)}>
        {t('What happened to this card')} ›
      </button>
    )
  }

  return (
    <section className="thread" aria-label={t('What happened to this card')}>
      <div className="thread-title">{t('What happened')}</div>
      {error && <p className="thread-empty">{error}</p>}
      {!error && events === null && <p className="thread-empty">{t('Loading…')}</p>}
      {events && events.length === 0 && <p className="thread-empty">{t('Nothing has happened to this card yet.')}</p>}
      {events && events.length > 0 && (
        <ol className="thread-list">
          {events.map((ev) => (
            <li key={ev.id} className={`thread-row t-${ev.type}`}>
              <span className="thread-when">{when(ev.createdAt)}</span>
              <span className="thread-body">
                <span className="thread-head">
                  {t(eventWord(ev))}
                  {ev.actorUserId && <span className="thread-who"> · {userId && ev.actorUserId === userId ? t('You') : displayName(ev.actorUserId)}</span>}
                </span>
                {ev.note && <span className="thread-note">{ev.type === 'feedback' ? t(REASON_WORD[ev.note] || ev.note) : `“${ev.note}”`}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
