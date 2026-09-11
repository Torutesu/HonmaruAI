import React, { useMemo, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
import { useT } from '../utils/i18n'

interface Props {
  decided: DecisionCard[]
  sent: DecisionCard[]
  businesses: Business[]
  userId: string
  /// Take a decision back. Only the person who made it can, and only the
  /// relay knows whether it still stands — so this sends, and the row
  /// updates when the relay answers.
  onUndo: (cardId: string) => void
  onClose: () => void
}

type Filter = 'all' | 'yours' | 'sent'

// English keys, translated where they are read: a table built at module load
// would be frozen in whatever language the app started in.
const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred',
}
const ACTION_TONE: Record<string, string> = {
  approve: 'mint', decline: 'pink', revise: 'violet', delegate: 'blue',
}

function dayLabel(iso: string) {
  const then = new Date(iso)
  const today = new Date()
  const days = Math.floor((+new Date(today.toDateString()) - +new Date(then.toDateString())) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: 'long' })
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/// Everything already settled, newest first.
///
/// This is the personal view of the same truth the org-wide record holds: what
/// was decided, by whom, and when. It reads from the state the socket already
/// streams, so it is right the moment a decision lands rather than a refresh
/// later. A row opens to show the whole card — a settled decision is not in
/// the feed any more, so this is the only place to read it back — and, for a
/// decision you made, to take it back.
export const History: React.FC<Props> = ({ decided, sent, businesses, userId, onUndo, onClose }) => {
  const t = useT()
  const locale = getLocale()
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const nameOf = (slug?: string) => businesses.find((b) => b.slug === slug)?.name || slug

  const groups = useMemo(() => {
    const settled = filter === 'sent' ? [] : decided
    const mine = filter === 'yours' ? [] : sent.filter((c) => c.status !== 'pending')
    const all = [...settled, ...mine]
      .filter((c, i, list) => list.findIndex((o) => o.id === c.id) === i)
      .sort((a, b) => (b.decision?.decidedAt || b.createdAt).localeCompare(a.decision?.decidedAt || a.createdAt))
    const out: Array<{ day: string; cards: DecisionCard[] }> = []
    for (const card of all) {
      const day = dayLabel(card.decision?.decidedAt || card.createdAt)
      const last = out[out.length - 1]
      if (last && last.day === day) last.cards.push(card)
      else out.push({ day, cards: [card] })
    }
    return out
  }, [decided, sent, filter])

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('History')}</span>
      </div>
      <div className="screen-body">
        <div className="seg" role="tablist" aria-label={t('Filter')}>
          {(['all', 'yours', 'sent'] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f}
              className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? t('Everything') : f === 'yours' ? t('You decided') : t('You asked')}
            </button>
          ))}
        </div>

        {groups.length === 0 && (
          <div className="empty">
            {t('Nothing settled yet.')}<br />
            {t('history.blurb')}
          </div>
        )}

        {groups.map((group) => (
          <section key={group.day} className="hist-group">
            <div className="rows-title">{t(group.day)}</div>
            <div className="rows">
              {group.cards.map((card) => {
                const action = card.decision?.action || (card.status === 'pending' ? '' : card.status)
                const byYou = card.recipientUserID === userId
                const expanded = open === card.id
                const localized = card.localized?.[locale]
                const title = localized?.title || card.title
                const summary = localized?.summary || card.summary
                return (
                  <div key={card.id} className={`hist-row${expanded ? ' open' : ''}`} data-card={card.id}>
                    <button
                      className="row"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : card.id)}
                    >
                      <span className="row-main">
                        {title}
                        <span className="row-sub">
                          {byYou ? t('You') : displayName(card.recipientUserID)}
                          {card.business ? ` · ${nameOf(card.business)}` : ''}
                          {card.decision?.decidedAt
                            ? ` · ${new Date(card.decision.decidedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                            : ''}
                        </span>
                      </span>
                      {action && (
                        <span className={`pill-tag ${ACTION_TONE[action] || ''}`}>
                          {t(ACTION_WORD[action] || action)}
                        </span>
                      )}
                    </button>
                    {expanded && (
                      <div className="hist-detail">
                        {summary && <p className="hist-summary">{summary}</p>}
                        {card.decision?.replyText && <blockquote className="hist-quote">“{card.decision.replyText}”</blockquote>}
                        {card.decision?.note && <p className="hist-note">{card.decision.note}</p>}
                        {card.githubIssueURL && (
                          <a className="hist-link" href={card.githubIssueURL} target="_blank" rel="noopener noreferrer">
                            {t('GitHub issue #{n}', { n: card.githubIssueNumber ?? '' })} ›
                          </a>
                        )}
                        {byYou && card.decision && (
                          <button className="pill-btn hist-undo" onClick={() => { onUndo(card.id); setOpen(null) }}>
                            {t('Undo')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}
