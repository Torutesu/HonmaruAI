import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import './Feed.css'

interface Props {
  cards: DecisionCard[]            // pending, for me, in the order to show
  userId: string
  businesses: Business[]
  focusCardId: string | null
  onDecide: (cardId: string, action: string, options?: { replyText?: string }) => void
}

const SWIPE_THRESHOLD = 96


function fromLine(card: DecisionCard, userId: string): string {
  const sender = card.senderUserID
  if (!sender || sender === userId || sender === 'deleted-user') return 'Your AI → you'
  return `${sender.replace(/^(u:|email:)/, '').split('@')[0]}'s AI → you`
}

function segments(context: string): string[] {
  return context.split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean)
}

/// One decision per screen. Scroll for the next one; swipe right to approve,
/// left to decline; or use the buttons. The keyboard works too: ↑ ↓ to move,
/// A to approve, D to decline, R to reply.
///
/// There is no filter and no folder. The business a card belongs to is a
/// label the AI put there, and the order is the order the AI chose.
export const Feed: React.FC<Props> = ({ cards, userId, businesses, focusCardId, onDecide }) => {
  const container = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const nameOf = useMemo(() => {
    const map = new Map(businesses.map((b) => [b.slug, b.name]))
    return (slug?: string) => (slug ? map.get(slug) || slug : '')
  }, [businesses])

  // Which page is in view, from the scroll position.
  useEffect(() => {
    const el = container.current
    if (!el) return
    const onScroll = () => setIndex(Math.round(el.scrollTop / el.clientHeight))
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const scrollTo = useCallback((i: number) => {
    const el = container.current
    if (!el) return
    const clamped = Math.max(0, Math.min(i, Math.max(cards.length - 1, 0)))
    el.scrollTo({ top: clamped * el.clientHeight, behavior: 'smooth' })
  }, [cards.length])

  // A notification tap names a card: go there.
  useEffect(() => {
    if (!focusCardId) return
    const i = cards.findIndex((c) => c.id === focusCardId)
    if (i >= 0) scrollTo(i)
  }, [focusCardId, cards, scrollTo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const card = cards[index]
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); scrollTo(index + 1) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); scrollTo(index - 1) }
      else if (card && (e.key === 'a' || e.key === 'A')) onDecide(card.id, 'approve')
      else if (card && (e.key === 'd' || e.key === 'D')) onDecide(card.id, 'decline')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cards, index, scrollTo, onDecide])

  return (
    <div className="feed" ref={container}>
      {cards.length === 0 && (
        <section className="page page-empty">
          <div className="empty-mark">✓</div>
          <h2>All clear</h2>
          <p>Nothing is waiting on you. Your AI will tell you when something is.</p>
        </section>
      )}
      {cards.map((card) => (
        <FeedPage
          key={card.id}
          card={card}
          userId={userId}
          businessName={nameOf(card.business)}
          onDecide={onDecide}
        />
      ))}
      {cards.length > 1 && (
        <div className="page-indicator" aria-live="polite">{Math.min(index + 1, cards.length)} / {cards.length}</div>
      )}
    </div>
  )
}

interface PageProps {
  card: DecisionCard
  userId: string
  businessName: string
  onDecide: Props['onDecide']
}

const FeedPage: React.FC<PageProps> = ({ card, userId, businessName, onDecide }) => {
  const [dx, setDx] = useState(0)
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const start = useRef<{ x: number; y: number } | null>(null)
  const localized = card.localized?.[getLocale()]
  const title = localized?.title || card.title
  const summary = localized?.summary || card.summary
  const context = localized?.context || card.context || ''

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, textarea, input, a')) return
    start.current = { x: e.clientX, y: e.clientY }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return
    const ddx = e.clientX - start.current.x
    const ddy = e.clientY - start.current.y
    // Mostly horizontal, or it is a scroll.
    if (Math.abs(ddx) > Math.abs(ddy)) setDx(ddx)
  }
  const onPointerUp = () => {
    if (!start.current) return
    start.current = null
    if (dx > SWIPE_THRESHOLD) onDecide(card.id, 'approve')
    else if (dx < -SWIPE_THRESHOLD) onDecide(card.id, 'decline')
    setDx(0)
  }

  const hint = dx > 24 ? 'approve' : dx < -24 ? 'decline' : null

  return (
    <section
      className={`page${hint ? ` hint-${hint}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="page-inner" style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 160ms ease' : 'none' }}>
        <header className="page-head">
          <span className={`kind kind-${card.type}`}>{card.type}</span>
          {businessName && <span className="business">{businessName}</span>}
          {(card.priority === 'urgent' || card.priority === 'high') && (
            <span className={`priority priority-${card.priority}`}>{card.priority}</span>
          )}
        </header>
        <div className="page-from">{fromLine(card, userId)}</div>

        <h1 className="page-title">{title}</h1>
        {summary && <p className="page-summary">{summary}</p>}

        {context && (
          <ul className="page-context">
            {segments(context).map((seg, i) => {
              const [label, ...rest] = seg.split(/[:：]/)
              const detail = rest.join(':').trim()
              return (
                <li key={i}>
                  {detail ? <><span className="ctx-label">{label.trim()}</span><span className="ctx-detail">{detail}</span></> : <span className="ctx-detail">{seg}</span>}
                </li>
              )
            })}
          </ul>
        )}

        {card.originalBody && card.originalLanguage && (
          <details className="page-original">
            <summary>Translated from {card.originalLanguage}</summary>
            <p>{card.originalBody}</p>
          </details>
        )}

        {card.sourceApp && (
          <div className="page-source">From {card.sourceApp}{card.sourceDetail ? ` · ${card.sourceDetail}` : ''}</div>
        )}

        <div className="page-spacer" />

        {replying ? (
          <form
            className="page-reply"
            onSubmit={(e) => { e.preventDefault(); if (reply.trim()) { onDecide(card.id, 'reply', { replyText: reply.trim() }); setReply(''); setReplying(false) } }}
          >
            <textarea autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Your reply goes back to the sender's AI" rows={3} />
            <div className="page-reply-actions">
              <button type="button" className="ghost" onClick={() => setReplying(false)}>Cancel</button>
              <button type="submit" className="primary" disabled={!reply.trim()}>Send reply</button>
            </div>
          </form>
        ) : (
          <div className="page-actions">
            <button className="decline" onClick={() => onDecide(card.id, 'decline')} aria-keyshortcuts="d">Decline</button>
            <button className="ghost" onClick={() => setReplying(true)} aria-keyshortcuts="r">Reply</button>
            {card.type === 'notification'
              ? <button className="primary" onClick={() => onDecide(card.id, 'acknowledge')}>Got it</button>
              : <button className="primary" onClick={() => onDecide(card.id, 'approve')} aria-keyshortcuts="a">Approve</button>}
          </div>
        )}
        <div className="page-swipe-hint">swipe → approve · ← decline</div>
      </div>
    </section>
  )
}
