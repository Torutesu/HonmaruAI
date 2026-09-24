import React, { useEffect, useMemo, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
import { useT } from '../utils/i18n'
import { ReplyDraft } from '../components/ReplyDraft'

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
  /// For the reply draft: the Worker, the org, and who is asking.
  httpBase: string
  orgId: string
  sessionToken: string
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

/// A laptop wide enough for the list and the decision side by side. Below
/// it a row opens in place, as it always has on a phone.
const WIDE = '(min-width: 1024px)'
function useWide() {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE)
    if (!mq) return
    const on = () => setWide(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return wide
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
export const History: React.FC<Props> = ({ decided, sent, businesses, userId, onUndo, onClose, httpBase, orgId, sessionToken }) => {
  const t = useT()
  const locale = getLocale()
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const wide = useWide()
  const nameOf = (slug?: string) => businesses.find((b) => b.slug === slug)?.name || slug

  const groups = useMemo(() => {
    const settled = filter === 'sent' ? [] : decided
    const mine = filter === 'yours' ? [] : sent.filter((c) => c.status !== 'pending')
    const q = query.trim().toLowerCase()
    const all = [...settled, ...mine]
      .filter((c, i, list) => list.findIndex((o) => o.id === c.id) === i)
      .filter((c) => !q || [c.localized?.[locale]?.title, c.title, c.summary, c.business && nameOf(c.business), c.decision?.note, c.decision?.replyText]
        .some((v) => (v || '').toLowerCase().includes(q)))
      .sort((a, b) => (b.decision?.decidedAt || b.createdAt).localeCompare(a.decision?.decidedAt || a.createdAt))
    const out: Array<{ day: string; cards: DecisionCard[] }> = []
    for (const card of all) {
      const day = dayLabel(card.decision?.decidedAt || card.createdAt)
      const last = out[out.length - 1]
      if (last && last.day === day) last.cards.push(card)
      else out.push({ day, cards: [card] })
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decided, sent, filter, query, locale])
  const shown = useMemo(() => groups.flatMap((g) => g.cards), [groups])
  // On a laptop something is always open: the newest, until another is picked.
  const selected = wide ? (shown.find((c) => c.id === open) || shown[0] || null) : null
  const tally = useMemo(() => {
    const n: Record<string, number> = {}
    for (const c of shown) { const a = c.decision?.action || c.status; n[a] = (n[a] || 0) + 1 }
    return n
  }, [shown])

  const detail = (card: DecisionCard, byYou: boolean, summary?: string) => (
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
      {card.decision && (byYou || card.senderUserID === userId) && (
        <ReplyDraft httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} card={card} />
      )}
    </div>
  )

  return (
    <div className="screen screen-wide hist-screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('History')}</span>
      </div>
      <div className="screen-body">
        <div className="hist-tools">
        <div className="seg" role="tablist" aria-label={t('Filter')}>
            {(['all', 'yours', 'sent'] as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f}
                className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? t('Everything') : f === 'yours' ? t('You decided') : t('You asked')}
              </button>
            ))}
          </div>
          <input
            className="hist-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search what was decided')}
            aria-label={t('Search what was decided')}
          />
          {shown.length > 0 && (
            <p className="hist-tally" role="status">
              {t('{n} settled', { n: shown.length })}
              {Object.entries(tally).filter(([a]) => ACTION_WORD[a]).map(([a, n]) => ` · ${t(ACTION_WORD[a])} ${n}`).join('')}
            </p>
          )}
        </div>
        <div className="hist-split">
        <div className="hist-list">
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
                const expanded = wide ? selected?.id === card.id : open === card.id
                const localized = card.localized?.[locale]
                const title = localized?.title || card.title
                const summary = localized?.summary || card.summary
                return (
                  <div key={card.id} className={`hist-row${expanded ? ' open' : ''}`} data-card={card.id}>
                    <button
                      className="row"
                      aria-expanded={expanded}
                      onClick={() => setOpen(wide ? card.id : (expanded ? null : card.id))}
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
                    {expanded && !wide && detail(card, byYou, summary)}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
        <div style={{ height: 24 }} />
        </div>
        {wide && selected && (() => {
          const card = selected
          const action = card.decision?.action || card.status
          const byYou = card.recipientUserID === userId
          const localized = card.localized?.[locale]
          const context = localized?.context || card.context
          const when = card.decision?.decidedAt || card.createdAt
          return (
            <aside className="hist-pane" aria-label={t('Decision')} data-card={card.id}>
              <div className="hist-pane-head">
                {action && action !== 'pending' && (
                  <span className={`pill-tag ${ACTION_TONE[action] || ''}`}>{t(ACTION_WORD[action] || action)}</span>
                )}
                <h2>{localized?.title || card.title}</h2>
                <dl className="hist-facts">
                  <div><dt>{t('Decided by')}</dt><dd>{byYou ? t('You') : displayName(card.recipientUserID)}</dd></div>
                  <div><dt>{t('Asked by')}</dt><dd>{card.senderUserID === userId ? t('You') : (card.requestedBy?.name || displayName(card.senderUserID))}</dd></div>
                  {card.business && <div><dt>{t('Business')}</dt><dd>{nameOf(card.business)}</dd></div>}
                  <div><dt>{t('When')}</dt><dd>{new Date(when).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd></div>
                </dl>
              </div>
              {detail(card, byYou, localized?.summary || card.summary)}
              {context && (
                <section className="hist-context">
                  <div className="rows-title">{t('Context')}</div>
                  <p>{context}</p>
                </section>
              )}
            </aside>
          )
        })()}
        </div>
      </div>
    </div>
  )
}
