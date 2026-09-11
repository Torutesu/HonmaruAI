import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import './Feed.css'
import { displayName } from '../utils/names'
import { useT, t } from '../utils/i18n'

interface Props {
  cards: DecisionCard[]            // pending, for me, in the order to show
  userId: string
  businesses: Business[]
  focusCardId: string | null
  /// The relay has sent what it knows. Before that, the feed is not empty —
  /// it is not here yet, and the two look nothing alike to the person who
  /// opened the app to see what is waiting on them.
  ready: boolean
  /// Whether the feed is the thing on screen. A sheet or a screen over it
  /// takes the keyboard: A and D must not decide a card nobody is looking at.
  active: boolean
  onDecide: (cardId: string, action: string, options?: { replyText?: string }) => void
  onAsk: (text: string, card: DecisionCard) => void
}

const SWIPE_THRESHOLD = 96

/// What kind of thing this card is. English keys, translated where they are
/// read — the card wore the raw type ("notification") in any language before.
const KIND: Record<string, string> = {
  approval: 'Decisions',
  notification: 'Notification',
  task: 'Task',
  delegation: 'Delegation',
  revision: 'Revision',
}

function initials(name: string): string {
  const clean = name.trim()
  if (!clean) return '?'
  // One character is enough at 40px, and it is right in every script.
  return [...clean][0].toUpperCase()
}

/// "12m ago", the way the design writes it. Anything past a week is a date,
/// because "63d ago" is not something anyone reads as a duration.
function ago(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return t('just now')
  if (mins < 60) return t('{n}m ago', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t('{n}h ago', { n: hours })
  const days = Math.round(hours / 24)
  if (days <= 7) return t('{n}d ago', { n: days })
  return new Date(then).toLocaleDateString()
}

function segments(context: string): Array<{ label: string; detail: string }> {
  return context.split(/\s+·\s+/).map((seg) => {
    const [label, ...rest] = seg.split(/[:：]/)
    const detail = rest.join(':').trim()
    return detail ? { label: label.trim(), detail } : { label: '', detail: seg.trim() }
  }).filter((s) => s.detail)
}

/// One decision per screen. Scroll for the next; swipe right to approve, left
/// to decline; or use the two buttons. The keyboard works too: ↑ ↓ to move,
/// A to approve, D to decline.
export const Feed: React.FC<Props> = ({ cards, userId, businesses, focusCardId, ready, active, onDecide, onAsk }) => {
  const t = useT()
  const container = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const nameOf = useMemo(() => {
    const map = new Map(businesses.map((b) => [b.slug, b.name]))
    return (slug?: string) => (slug ? map.get(slug) || slug : '')
  }, [businesses])

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

  useEffect(() => {
    if (!focusCardId) return
    const i = cards.findIndex((c) => c.id === focusCardId)
    if (i >= 0) scrollTo(i)
  }, [focusCardId, cards, scrollTo])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && target.closest('input, textarea, select, [contenteditable]')) return
      const card = cards[index]
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); scrollTo(index + 1) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); scrollTo(index - 1) }
      else if (card && (e.key === 'a' || e.key === 'A')) onDecide(card.id, 'approve')
      else if (card && (e.key === 'd' || e.key === 'D')) onDecide(card.id, 'decline')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, cards, index, scrollTo, onDecide])

  return (
    <div className="feed" ref={container}>
      {!ready && (
        <section className="page page-empty page-loading" aria-busy="true" aria-live="polite">
          <div className="empty-mark loading-mark" aria-hidden="true" />
          <h2>{t('Opening your feed…')}</h2>
          <p>{t('Asking your AI what is waiting on you.')}</p>
        </section>
      )}
      {ready && cards.length === 0 && (
        <section className="page page-empty">
          <div className="empty-mark">✓</div>
          <h2>{t('All clear')}</h2>
          <p>{t('Nothing is waiting on you. Your AI will tell you when something is.')}</p>
        </section>
      )}
      {ready && cards.map((card) => (
        <FeedPage
          key={card.id}
          card={card}
          userId={userId}
          businessName={nameOf(card.business)}
          onDecide={onDecide}
          onAsk={onAsk}
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
  onAsk: Props['onAsk']
}

const FeedPage: React.FC<PageProps> = ({ card, businessName, onDecide, onAsk }) => {
  const t = useT()
  const [dx, setDx] = useState(0)
  const [ask, setAsk] = useState('')
  const start = useRef<{ x: number; y: number } | null>(null)
  const localized = card.localized?.[getLocale()]
  const title = localized?.title || card.title
  const summary = localized?.summary || card.summary
  const context = localized?.context || card.context || ''
  const who = card.requestedBy
  const whoName = who?.name || displayName(card.senderUserID)
  const quote = who?.quote || card.sourceInstruction || card.originalBody || ''
  const sources = card.sourceApp ? [card.sourceApp] : []
  // The legend draws three levels. "urgent" is the fourth the API can send,
  // and it used to light nothing at all — the one priority that most needed
  // to be seen was the one with no mark. It lights the top of the scale and
  // says so.
  const level = card.priority === 'urgent' ? 'high' : card.priority

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, textarea, input, a')) return
    start.current = { x: e.clientX, y: e.clientY }
    // Keep receiving moves after the pointer leaves the page, or a fast swipe
    // that ends off the card ends with no pointerup and a card stuck mid-drag.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* not every pointer can be captured */ }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return
    const ddx = e.clientX - start.current.x
    const ddy = e.clientY - start.current.y
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
      <div className="page-inner">
        <article
          className="card"
          aria-label={title}
          style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 160ms ease' : 'none' }}
        >
          <header className="card-top">
            <span className="card-kind">{t(KIND[card.type] || card.type)}</span>
            <span className="priority-legend" aria-label={t('Priority')}>
              {(['low', 'medium', 'high'] as const).map((step) => (
                <span key={step} className={`legend ${level === step ? 'on' : ''} p-${step}${card.priority === 'urgent' && step === 'high' ? ' urgent' : ''}`}>
                  <i /> {card.priority === 'urgent' && step === 'high' ? t('Urgent') : t(step[0].toUpperCase() + step.slice(1))}
                </span>
              ))}
            </span>
          </header>

          <h1 className="card-title">{title}</h1>
          {summary && <p className="card-summary">{summary}</p>}

          {(sources.length > 0 || businessName) && (
            <div className="card-sources">
              {businessName && <span className="source-chip business">{businessName}</span>}
              {sources.map((s) => <span key={s} className="source-chip">{s}</span>)}
            </div>
          )}

          {context && (
            <ul className="card-context">
              {segments(context).map((seg, i) => (
                <li key={i}>
                  {seg.label && <span className="ctx-label">{seg.label}</span>}
                  <span className="ctx-detail">{seg.detail}</span>
                </li>
              ))}
            </ul>
          )}

          {whoName && (
            <section className="requested-by">
              <div className="rb-label">{t('Requested By')}</div>
              <div className="rb-row">
                <span className="avatar" aria-hidden="true">{initials(whoName)}</span>
                <div className="rb-who">
                  <strong>{whoName}</strong>
                  <span className="rb-meta">
                    {ago(card.createdAt)}{who?.role ? ` · ${t(who.role)}` : ''}
                  </span>
                </div>
              </div>
              {quote && <blockquote className="rb-quote">“{quote}”</blockquote>}
              {who?.sourceUrl && (
                <a className="rb-link" href={who.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {card.sourceApp ? t('View original in {app}', { app: card.sourceApp }) : t('View original')} ›
                </a>
              )}
            </section>
          )}

          {card.recommendation && (
            <section className={`recommendation rec-${card.recommendation.action}`}>
              <div className="rec-head">
                <span className="ai-spark" aria-hidden="true">✦</span>
                {t('Recommended:')} <strong>{t(card.recommendation.action)}</strong>
              </div>
              {card.recommendation.reason && <p className="rec-reason">{card.recommendation.reason}</p>}
            </section>
          )}
        </article>

        <div className="decide-row">
          <button className="decide decline" onClick={() => onDecide(card.id, 'decline')} aria-label={t('Decline')} aria-keyshortcuts="d">✕</button>
          <button className="decide approve" onClick={() => onDecide(card.id, 'approve')} aria-label={t('Approve')} aria-keyshortcuts="a">✓</button>
        </div>

        <form
          className="ask-bar"
          onSubmit={(e) => { e.preventDefault(); if (ask.trim()) { onAsk(ask.trim(), card); setAsk('') } }}
        >
          <button type="button" className="ask-plus" aria-label={t('Reply with a note')} title={t('Reply with a note')} disabled={!ask.trim()} onClick={() => {
            if (ask.trim()) { onDecide(card.id, 'reply', { replyText: ask.trim() }); setAsk('') }
          }}>+</button>
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder={t('Ask anything...')}
            aria-label={t('Ask your AI about this decision')}
            enterKeyHint="send"
          />
          <button type="submit" className="ask-send" aria-label={t('Send')} disabled={!ask.trim()}>➤</button>
        </form>
      </div>
    </section>
  )
}
