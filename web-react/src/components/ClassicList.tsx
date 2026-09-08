import React from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'

interface Props {
  pending: DecisionCard[]
  sent: DecisionCard[]
  decided: DecisionCard[]
  businesses: Business[]
  onOpen: (cardId: string) => void
  onNudge: (cardId: string) => void
}

function when(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/// The same decisions, as a list you scan rather than a stack you swipe.
///
/// It is deliberately the same data as the card feed: everything here can be
/// opened as a card, and nothing here exists that the feed does not know
/// about. The channels and direct messages in the design are a separate
/// feature with no backend yet, and inventing them here would be a screen
/// that lies about what the product does.
export const ClassicList: React.FC<Props> = ({ pending, sent, decided, businesses, onOpen, onNudge }) => {
  const locale = getLocale()
  const nameOf = (slug?: string) => businesses.find((b) => b.slug === slug)?.name || slug || ''
  const titleOf = (c: DecisionCard) => c.localized?.[locale]?.title || c.title

  const Row: React.FC<{ card: DecisionCard; meta: string; badge?: string; action?: React.ReactNode }> = ({ card, meta, badge, action }) => (
    <li className="cl-row">
      <button className="cl-open" onClick={() => onOpen(card.id)}>
        <span className="cl-mark" aria-hidden="true">{(nameOf(card.business)[0] || '#').toUpperCase()}</span>
        <span className="cl-text">
          <span className="cl-title">{titleOf(card)}</span>
          <span className="cl-meta">{meta}</span>
        </span>
        <span className="cl-right">
          <span className="cl-when">{when(card.decision?.decidedAt || card.createdAt)}</span>
          {badge && <span className="cl-badge">{badge}</span>}
        </span>
      </button>
      {action}
    </li>
  )

  return (
    <div className="classic">
      <div className="classic-inner">
        <section className="cl-section">
          <h2>Waiting on you<span>{pending.length}</span></h2>
          {pending.length === 0 && <p className="cl-empty">Nothing is waiting on you.</p>}
          <ul>
            {pending.map((c) => (
              <Row
                key={c.id}
                card={c}
                meta={`${displayName(c.requestedBy?.name || c.senderUserID)}${nameOf(c.business) ? ` · ${nameOf(c.business)}` : ''}`}
                badge={c.priority === 'urgent' || c.priority === 'high' ? c.priority : undefined}
              />
            ))}
          </ul>
        </section>

        <section className="cl-section">
          <h2>Sent by you<span>{sent.length}</span></h2>
          {sent.length === 0 && <p className="cl-empty">You have not sent anything yet.</p>}
          <ul>
            {sent.map((c) => (
              <Row
                key={c.id}
                card={c}
                meta={c.status === 'pending'
                  ? `Waiting on ${displayName(c.recipientUserID)}`
                  : `${displayName(c.recipientUserID)} · ${c.decision?.action || c.status}`}
                action={c.status === 'pending'
                  ? <button className="cl-nudge" onClick={() => onNudge(c.id)}>Nudge</button>
                  : undefined}
              />
            ))}
          </ul>
        </section>

        <section className="cl-section">
          <h2>Decided<span>{decided.length}</span></h2>
          {decided.length === 0 && <p className="cl-empty">No decisions yet.</p>}
          <ul>
            {decided.map((c) => (
              <Row key={c.id} card={c} meta={`${c.decision?.action || c.status}${nameOf(c.business) ? ` · ${nameOf(c.business)}` : ''}`} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
