import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { displayName } from '../utils/names'
import { getLocale } from '../utils/locale'
import { splitMentions, useMembers } from '../utils/mentions'
import { useMentionMenu } from './MentionMenu'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  cardId: string
  /// Who is reading, so their own actions say "You" rather than their login.
  userId?: string
  /// Anything that means "something happened to this card since": the
  /// decision's time, the status, the comment count. A change refetches.
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

export interface Comment {
  id: string
  cardId?: string
  author: string
  authorName?: string | null
  body: string
  mentions: string[]
  createdAt: string
}

interface Reaction { emoji: string; count: number; mine: boolean; names: string[] }

// What happened, as a word. English keys, translated where read.
const EVENT_WORD: Record<string, string> = {
  created: 'Created', updated: 'Updated', deleted: 'Deleted', rolled_back: 'Undone',
  nudged: 'Nudged', asked: 'Asked your AI', drafted: 'Reply drafted', replied: 'Reply sent', filed: 'Filed',
  feedback: 'Flagged as wrong', localized: 'Translated', commented: 'Commented',
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

/// A comment's text with every @Name drawn as one.
export const MentionText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {splitMentions(text).map((part, i) => part.mention
      ? <span key={i} className="mention">{part.text}</span>
      : <React.Fragment key={i}>{part.text}</React.Fragment>)}
  </>
)

type Row = { kind: 'event'; at: string; ev: CardEvent } | { kind: 'comment'; at: string; c: Comment }

/// The thread under a card: everything that happened to it and everything
/// anyone said about it, oldest first, with a box to say the next thing —
/// "@" offers the team's names — and the reactions along the top. A card
/// that was asked about twice, commented on and replied to reads like the
/// conversation it was.
export const CardThread: React.FC<Props> = ({ httpBase, orgId, sessionToken, cardId, userId, version, alwaysOpen }) => {
  const t = useT()
  const [open, setOpen] = useState(alwaysOpen)
  const [events, setEvents] = useState<CardEvent[] | null>(null)
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [reactions, setReactions] = useState<Reaction[]>([])
  const [available, setAvailable] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [picking, setPicking] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const members = useMembers(httpBase, orgId, sessionToken)
  const mention = useMentionMenu(box, draft, setDraft, members)
  const headers = { 'x-session-token': sessionToken }

  useEffect(() => { if (alwaysOpen) setOpen(true) }, [alwaysOpen])

  useEffect(() => {
    if (!open) return
    let ignore = false
    const org = encodeURIComponent(orgId)
    const id = encodeURIComponent(cardId)
    Promise.all([
      fetch(`${httpBase}/cards/${id}/events?orgId=${org}`, { headers }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || t('Could not load what happened.'))
        return r.json()
      }),
      fetch(`${httpBase}/cards/${id}/comments?orgId=${org}`, { headers }).then((r) => (r.ok ? r.json() : { comments: [], reactions: [], available: [] })),
    ])
      .then(([ev, th]) => {
        if (ignore) return
        // A comment is logged as an event too; the words are shown once.
        setEvents((ev.events || []).filter((e: CardEvent) => e.type !== 'commented'))
        setComments(th.comments || [])
        setReactions(th.reactions || [])
        setAvailable(th.available || [])
        setError(null)
      })
      .catch((err) => { if (!ignore) setError(err instanceof Error ? err.message : String(err)) })
    return () => { ignore = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, httpBase, orgId, sessionToken, cardId, version, t])

  // Somebody else's comment or reaction, as it lands.
  useEffect(() => {
    const onComment = (e: Event) => {
      const { cardId: id, comment } = (e as CustomEvent).detail || {}
      if (id !== cardId || !comment) return
      setComments((prev) => (prev && !prev.some((c) => c.id === comment.id) ? [...prev, comment] : prev))
    }
    const onReaction = (e: Event) => {
      const { cardId: id, emoji, on, by } = (e as CustomEvent).detail || {}
      if (id !== cardId || !emoji || by === userId) return
      setReactions((prev) => {
        const found = prev.find((r) => r.emoji === emoji)
        const name = displayName(by)
        if (!found) return on ? [...prev, { emoji, count: 1, mine: false, names: [name] }] : prev
        const next = { ...found, count: Math.max(0, found.count + (on ? 1 : -1)), names: on ? [...found.names, name] : found.names.filter((n) => n !== name) }
        return next.count === 0 ? prev.filter((r) => r.emoji !== emoji) : prev.map((r) => (r.emoji === emoji ? next : r))
      })
    }
    window.addEventListener('honmaru:comment', onComment)
    window.addEventListener('honmaru:reaction', onReaction)
    return () => { window.removeEventListener('honmaru:comment', onComment); window.removeEventListener('honmaru:reaction', onReaction) }
  }, [cardId, userId])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const res = await fetch(`${httpBase}/cards/${encodeURIComponent(cardId)}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ orgId, body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not send.')); return }
      setComments((prev) => (prev && !prev.some((c) => c.id === data.comment.id) ? [...prev, data.comment] : prev))
      setDraft('')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSending(false) }
  }

  const react = async (emoji: string) => {
    // Shown at once, settled by the reply.
    setReactions((prev) => {
      const found = prev.find((r) => r.emoji === emoji)
      if (!found) return [...prev, { emoji, count: 1, mine: true, names: [t('You')] }]
      const next = { ...found, mine: !found.mine, count: found.count + (found.mine ? -1 : 1) }
      return next.count === 0 ? prev.filter((r) => r.emoji !== emoji) : prev.map((r) => (r.emoji === emoji ? next : r))
    })
    try {
      const res = await fetch(`${httpBase}/cards/${encodeURIComponent(cardId)}/reactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ orgId, emoji }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && Array.isArray(data.reactions)) setReactions(data.reactions)
    } catch { /* the next fetch settles it */ }
  }

  if (!open) {
    return (
      <button type="button" className="thread-toggle" onClick={() => setOpen(true)}>
        {t('Thread')} ›
      </button>
    )
  }

  const rows: Row[] = [
    ...(events || []).map((ev): Row => ({ kind: 'event', at: ev.createdAt, ev })),
    ...(comments || []).map((c): Row => ({ kind: 'comment', at: c.createdAt, c })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const loading = events === null && comments === null && !error

  return (
    <section className="thread" aria-label={t('Thread')}>
      <div className="thread-title">{t('Thread')}</div>

      <div className="reactions" aria-label={t('Reactions')}>
        {reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            className={`reaction${r.mine ? ' mine' : ''}`}
            onClick={() => react(r.emoji)}
            title={r.names.join(', ')}
            aria-pressed={r.mine}
          >
            <span aria-hidden="true">{r.emoji}</span> {r.count}
          </button>
        ))}
        {available.length > 0 && (
          <span className="reaction-add">
            <button type="button" className="reaction-add-btn" aria-label={t('Add a reaction')} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>+</button>
            {picking && (
              <div className="reaction-choices" role="menu">
                {available.map((emoji) => (
                  <button key={emoji} type="button" role="menuitem" onClick={() => { setPicking(false); void react(emoji) }}>{emoji}</button>
                ))}
              </div>
            )}
          </span>
        )}
      </div>

      {error && <p className="thread-empty">{error}</p>}
      {loading && <p className="thread-empty">{t('Loading…')}</p>}
      {!loading && rows.length === 0 && <p className="thread-empty">{t('Nothing has happened to this card yet.')}</p>}
      {rows.length > 0 && (
        <ol className="thread-list">
          {rows.map((row) => row.kind === 'event' ? (
            <li key={row.ev.id} className={`thread-row t-${row.ev.type}`}>
              <span className="thread-when">{when(row.ev.createdAt)}</span>
              <span className="thread-body">
                <span className="thread-head">
                  {t(eventWord(row.ev))}
                  {row.ev.actorUserId && <span className="thread-who"> · {userId && row.ev.actorUserId === userId ? t('You') : displayName(row.ev.actorUserId)}</span>}
                </span>
                {row.ev.note && <span className="thread-note">{row.ev.type === 'feedback' ? t(REASON_WORD[row.ev.note] || row.ev.note) : `“${row.ev.note}”`}</span>}
              </span>
            </li>
          ) : (
            <li key={row.c.id} className={`thread-row t-comment${row.c.mentions.includes(userId || '') ? ' mentions-you' : ''}`}>
              <span className="thread-when">{when(row.c.createdAt)}</span>
              <span className="thread-body">
                <span className="thread-head">{userId && row.c.author === userId ? t('You') : (row.c.authorName || displayName(row.c.author))}</span>
                <span className="thread-comment"><MentionText text={row.c.body} /></span>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="thread-reply">
        <textarea
          ref={box}
          className="thread-box"
          value={draft}
          rows={1}
          maxLength={2000}
          placeholder={t('Reply in thread — @ to name someone')}
          aria-label={t('Reply in thread')}
          disabled={sending}
          onChange={(e) => { setDraft(e.target.value); mention.track() }}
          onKeyUp={mention.track}
          onClick={mention.track}
          onKeyDown={(e) => {
            if (mention.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
          }}
        />
        {mention.menu}
        <button type="button" className="thread-send" onClick={() => void send()} disabled={sending || !draft.trim()}>
          {sending ? t('Sending…') : t('Send')}
        </button>
      </div>
    </section>
  )
}
