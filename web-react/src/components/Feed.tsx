import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import './Feed.css'
import { displayName } from '../utils/names'
import { useT } from '../utils/i18n'
import { ReplyDraft } from './ReplyDraft'
import { CardThread } from './CardThread'
import { ReportDoc, ProposalNote } from './Report'
import { DailyReportDraft } from './DailyReport'
import { awaitsPost } from '../utils/automation'
import { ago } from '../utils/ago'
import { sourceLabel } from '../utils/automation'
import { Icon } from './Icon'

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
  /// "This card is wrong" — and why. The one signal the router learns from.
  onFlag: (cardId: string, reason: FlagReason) => void
  /// What your AI answered under each card, by card id.
  answers: Record<string, Answer>
  /// Take a decision back. Shown on a decided card, for the person who made it.
  onUndo: (cardId: string) => void
  /// The Worker, for what a card carries beyond the relay's snapshot: its
  /// thread, and the reply draft. Absent in tests that have no Worker.
  api?: { httpBase: string; orgId: string; sessionToken: string }
  /// On a laptop the thread is open under the card; on a phone it is a line
  /// the person taps, because the card is the screen there.
  layout?: 'phone' | 'desk'
}

export interface Answer {
  question: string
  answer: string | null
  related: Array<{ title: string; status: string; decidedAt: string | null; recipient: string }>
  /// Pages and issues from the person's connected tools the answer drew on.
  sources?: Array<{ app: string; title: string; url: string | null }>
  busy: boolean
  error?: string
}

export type FlagReason = 'wrong-person' | 'not-a-decision' | 'wrong-priority' | 'wrong-words'
const FLAG_REASONS: Array<{ id: FlagReason; label: string }> = [
  { id: 'wrong-person', label: 'Wrong person' },
  { id: 'not-a-decision', label: 'Not a decision' },
  { id: 'wrong-priority', label: 'Wrong priority' },
  { id: 'wrong-words', label: 'Badly written' },
]

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

function segments(context: string): Array<{ label: string; detail: string }> {
  return context.split(/\s+·\s+/).map((seg) => {
    const [label, ...rest] = seg.split(/[:：]/)
    const detail = rest.join(':').trim()
    return detail ? { label: label.trim(), detail } : { label: '', detail: seg.trim() }
  }).filter((s) => s.detail)
}

/// A card that asks nothing — a report, an FYI — is read and put away, not
/// approved or declined: one button, "Got it", and a swipe right. Approving
/// a report was a decision nobody had been asked for.
const isFyi = (card: DecisionCard) => Boolean(card.report) || card.format === 'fyi'

/// One decision per screen. Scroll for the next; swipe right to approve, left
/// to decline; or use the two buttons. The keyboard works too: ↑ ↓ to move,
/// A to approve, D to decline.
export const Feed: React.FC<Props> = ({ cards, userId, businesses, focusCardId, ready, active, onDecide, onAsk, onFlag, answers, onUndo, api, layout = 'phone' }) => {
  const t = useT()
  const container = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  // Each card on screen registers how it leaves: a decision from the
  // keyboard flies the card off the same way a swipe does, instead of the
  // card vanishing under the finger that did not touch it.
  const flingers = useRef(new Map<string, (action: string) => void>())
  const fling = useCallback((card: DecisionCard, action: string) => {
    const go = flingers.current.get(card.id)
    if (go) go(action)
    else onDecide(card.id, action)
  }, [onDecide])
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
      // A daily report's draft is posted, not put away: A does nothing to it.
      else if (card && card.status === 'pending' && !awaitsPost(card) && (e.key === 'a' || e.key === 'A' || e.key === 'ArrowRight')) { e.preventDefault(); fling(card, isFyi(card) ? 'acknowledge' : 'approve') }
      else if (card && card.status === 'pending' && !isFyi(card) && (e.key === 'd' || e.key === 'D' || e.key === 'ArrowLeft')) { e.preventDefault(); fling(card, 'decline') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, cards, index, scrollTo, fling])

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
          onFlag={onFlag}
          answer={answers[card.id]}
          onUndo={onUndo}
          api={api}
          layout={layout}
          flingers={flingers.current}
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
  onFlag: Props['onFlag']
  answer?: Answer
  onUndo: Props['onUndo']
  api?: Props['api']
  layout: 'phone' | 'desk'
  flingers: Map<string, (action: string) => void>
}

// What was done, as a word. English keys, translated where read.
const DONE_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred',
}

const FeedPage: React.FC<PageProps> = ({ card, userId, businessName, onDecide, onAsk, onFlag, answer, onUndo, api, layout, flingers }) => {
  const t = useT()
  const [dx, setDx] = useState(0)
  const [ask, setAsk] = useState('')
  // Closed → open (the reasons) → sent (thanks). Never blocks the decision.
  const [flag, setFlag] = useState<'closed' | 'open' | 'sent'>('closed')
  const start = useRef<{ x: number; y: number } | null>(null)
  const localized = card.localized?.[getLocale()]
  const title = localized?.title || card.title
  // Without a model the title is the person's own words, and so was the
  // summary under it — the same sentence twice, then a third time as the
  // quote. Each is said once.
  const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim())
  const rawSummary = localized?.summary || card.summary
  const summary = same(rawSummary, title) ? '' : rawSummary
  const context = localized?.context || card.context || ''
  const who = card.requestedBy
  const whoName = who?.name || displayName(card.senderUserID)
  const rawQuote = who?.quote || card.sourceInstruction || card.originalBody || ''
  const quote = same(rawQuote, title) || same(rawQuote, rawSummary) ? '' : rawQuote
  const sources = card.sourceApp ? [sourceLabel(card, t)] : []
  // The legend draws three levels. "urgent" is the fourth the API can send,
  // and it used to light nothing at all — the one priority that most needed
  // to be seen was the one with no mark. It lights the top of the scale and
  // says so.
  const level = card.priority === 'urgent' ? 'high' : card.priority
  // A decided card is read, not swiped: the decision is shown where the two
  // buttons were, with the way back and the reply that follows it.
  const decided = card.status !== 'pending' || Boolean(card.decision)
  const onThisCard = card.recipientUserID === userId || card.senderUserID === userId

  // The card leaves the way it was decided: off to the right for yes, to
  // the left for no, turning as it goes — then the decision is sent. Every
  // way of deciding goes through here: a drag, a flick, a trackpad swipe,
  // a button, a key.
  const [flying, setFlying] = useState<'approve' | 'decline' | null>(null)
  const decide = useCallback((action: string) => {
    if (decided || flying) return
    const direction = action === 'decline' ? 'decline' : 'approve'
    setFlying(direction)
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    setTimeout(() => onDecide(card.id, action), reduced ? 0 : 230)
  }, [decided, flying, onDecide, card.id])
  useEffect(() => {
    flingers.set(card.id, decide)
    return () => { if (flingers.get(card.id) === decide) flingers.delete(card.id) }
  }, [flingers, card.id, decide])
  const yes = isFyi(card) ? 'acknowledge' : 'approve'
  const release = (distance: number, speed: number) => {
    // Far enough, or a quick flick that meant it.
    const meant = Math.abs(distance) > SWIPE_THRESHOLD || (Math.abs(speed) > 0.55 && Math.abs(distance) > 36)
    if (meant && distance > 0) decide(yes)
    else if (meant && distance < 0 && !isFyi(card)) decide('decline')
    setDx(0)
  }

  const last = useRef<{ x: number; t: number }[]>([])
  // A draft that has to be posted cannot be swiped away.
  const mustPost = awaitsPost(card)
  const onPointerDown = (e: React.PointerEvent) => {
    if (decided || flying || mustPost) return
    // A report is read, and its words can be selected; dragging across one
    // must not decide the card.
    if ((e.target as HTMLElement).closest('button, textarea, input, select, a, .report-body, .thread')) return
    start.current = { x: e.clientX, y: e.clientY }
    last.current = [{ x: e.clientX, t: e.timeStamp }]
    // Keep receiving moves after the pointer leaves the page, or a fast swipe
    // that ends off the card ends with no pointerup and a card stuck mid-drag.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* not every pointer can be captured */ }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return
    const ddx = e.clientX - start.current.x
    const ddy = e.clientY - start.current.y
    last.current = [...last.current.slice(-4), { x: e.clientX, t: e.timeStamp }]
    if (Math.abs(ddx) > Math.abs(ddy)) setDx(ddx)
  }
  const onPointerUp = () => {
    if (!start.current) return
    start.current = null
    const pts = last.current
    const speed = pts.length > 1 ? (pts[pts.length - 1].x - pts[0].x) / Math.max(1, pts[pts.length - 1].t - pts[0].t) : 0
    release(dx, speed)
  }

  // A trackpad's two-finger swipe, on a laptop: the same gesture as a
  // finger on a phone. Sideways only — scrolling the card still scrolls.
  const wheel = useRef<{ acc: number; timer: ReturnType<typeof setTimeout> | null }>({ acc: 0, timer: null })
  const onWheel = (e: React.WheelEvent) => {
    if (decided || flying) return
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 1) return
    const w = wheel.current
    w.acc = Math.max(-SWIPE_THRESHOLD * 2, Math.min(SWIPE_THRESHOLD * 2, w.acc - e.deltaX))
    setDx(w.acc)
    if (w.timer) clearTimeout(w.timer)
    w.timer = setTimeout(() => { const acc = w.acc; w.acc = 0; w.timer = null; release(acc, 0) }, 140)
  }
  useEffect(() => () => { if (wheel.current.timer) clearTimeout(wheel.current.timer) }, [])

  const hint = flying || (dx > 24 ? 'approve' : dx < -24 ? 'decline' : null)
  // How sure the gesture looks, 0 to 1: the stamp's ink.
  const certainty = flying ? 1 : Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD)
  const cardStyle: React.CSSProperties = flying
    ? { transform: `translateX(${flying === 'approve' ? 130 : -130}%) rotate(${flying === 'approve' ? 16 : -16}deg)`, opacity: 0, transition: 'transform 240ms cubic-bezier(.4,0,1,1), opacity 240ms ease-in' }
    : { transform: `translateX(${dx}px) rotate(${dx / 22}deg)`, transition: dx === 0 ? 'transform 200ms cubic-bezier(.2,.9,.3,1.2)' : 'none' }

  return (
    <section
      className={`page${hint ? ` hint-${hint}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div className="page-inner">
        <article
          className={`card${decided || mustPost ? '' : ' swipeable'}`}
          aria-label={title}
          style={cardStyle}
        >
          {!decided && !mustPost && (
            <>
              <span className="swipe-stamp yes" aria-hidden="true" style={{ opacity: hint === 'approve' ? certainty : 0 }}>
                {isFyi(card) ? t('Got it') : t('Approve')}
              </span>
              {!isFyi(card) && (
                <span className="swipe-stamp no" aria-hidden="true" style={{ opacity: hint === 'decline' ? certainty : 0 }}>
                  {t('Decline')}
                </span>
              )}
            </>
          )}
          <header className="card-top">
            <span className="card-kind">{card.report ? t('Report') : t(KIND[card.type] || card.type)}</span>
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

          {(sources.length > 0 || businessName || card.proposal) && (
            <div className="card-sources">
              {card.proposal && <span className="source-chip proposal-chip">{t('Automation proposal')}</span>}
              {businessName && <span className="source-chip business">{businessName}</span>}
              {sources.map((s) => <span key={s} className="source-chip">{s}</span>)}
            </div>
          )}

          {card.dailyReport && api
            ? <DailyReportDraft card={card} api={api} />
            : card.report?.markdown && <ReportDoc report={card.report} title={title} />}
          {card.proposal && <ProposalNote proposal={card.proposal} />}

          {/* A proposal's context repeats its evidence as a sentence; the
              note under it says the same thing as a list you can open. */}
          {context && !card.proposal && (
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
                <span className="ai-spark" aria-hidden="true"><Icon name="sparkle" size={14} /></span>
                {t('Recommended:')} <strong>{t(card.recommendation.action)}</strong>
              </div>
              {card.recommendation.reason && <p className="rec-reason">{card.recommendation.reason}</p>}
            </section>
          )}
        </article>

        {decided ? (
          <div className="decided-block">
            <div className="decided-line" role="status">
              <span className={`pill-tag ${card.decision?.action === 'approve' ? 'mint' : card.decision?.action === 'decline' ? 'pink' : ''}`}>
                {t(DONE_WORD[card.decision?.action || ''] || card.status)}
              </span>
              <span className="decided-when">
                {card.decision?.decidedAt ? ago(card.decision.decidedAt) : ''}
                {card.decision?.actorUserID ? ` · ${card.decision.actorUserID === userId ? t('you') : displayName(card.decision.actorUserID)}` : ''}
              </span>
              {card.recipientUserID === userId && card.decision && (
                <button type="button" className="pill-btn decided-undo" onClick={() => onUndo(card.id)}>{t('Undo')}</button>
              )}
            </div>
            {card.decision?.replyText && <blockquote className="hist-quote">“{card.decision.replyText}”</blockquote>}
            {api && onThisCard && card.decision && (
              <ReplyDraft httpBase={api.httpBase} orgId={api.orgId} sessionToken={api.sessionToken} card={card} />
            )}
          </div>
        ) : (
          // Its Post button is the draft's own; there is nothing else to press.
          mustPost ? null : isFyi(card) ? (
            <div className="decide-row">
              <button className="decide approve" onClick={() => decide('acknowledge')} aria-label={t('Got it')} aria-keyshortcuts="a"><Icon name="check" size={22} /></button>
            </div>
          ) : (
            <div className="decide-row">
              <button className="decide decline" onClick={() => decide('decline')} aria-label={t('Decline')} aria-keyshortcuts="d"><Icon name="x" size={22} /></button>
              <button className="decide approve" onClick={() => decide('approve')} aria-label={t('Approve')} aria-keyshortcuts="a"><Icon name="check" size={22} /></button>
              {layout === 'desk' && <span className="swipe-hint-desk" aria-hidden="true">{t('Swipe, drag, or ← →')}</span>}
            </div>
          )
        )}

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
          <button type="submit" className="ask-send" aria-label={t('Send')} disabled={!ask.trim()}><Icon name="send" size={16} /></button>
        </form>

        {answer && (
          <div className="answer" aria-live="polite">
            <div className="answer-q">{answer.question}</div>
            {answer.busy && <div className="answer-a answer-busy">{t('Your AI is looking…')}</div>}
            {answer.error && <div className="answer-a answer-error">{answer.error}</div>}
            {answer.answer && <div className="answer-a">{answer.answer}</div>}
            {(answer.sources?.length || 0) > 0 && (
              <ul className="answer-sources" aria-label={t('From your tools')}>
                {answer.sources!.map((r) => (
                  <li key={`${r.app}-${r.title}`}>
                    <span className="answer-when">{r.app}</span>
                    {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}
                  </li>
                ))}
              </ul>
            )}
            {answer.related.length > 0 && (
              <ul className="answer-related">
                {answer.related.map((r) => (
                  <li key={`${r.title}-${r.decidedAt}`}>
                    <span className="answer-when">{r.decidedAt ? r.decidedAt.slice(0, 10) : t('Waiting')}</span>
                    {r.title}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {api && (
          <CardThread
            httpBase={api.httpBase}
            orgId={api.orgId}
            sessionToken={api.sessionToken}
            cardId={card.id}
            userId={userId}
            version={`${card.status}|${card.decision?.decidedAt || ''}|${answer?.busy ? 'asking' : (answer?.answer || '')}|${card.commentCount || 0}|${card.lastCommentAt || ''}`}
            alwaysOpen={layout === 'desk'}
          />
        )}

        {/* Quiet, under everything: a card that is wrong is still decided
            above, and saying so costs one tap. What is said here becomes a
            row the router is measured against. */}
        <div className="card-flag" aria-live="polite">
          {flag === 'closed' && (
            <button type="button" className="flag-link" onClick={() => setFlag('open')}>{t('Is this card wrong?')}</button>
          )}
          {flag === 'open' && (
            <div className="flag-row" role="group" aria-label={t('What is wrong with it?')}>
              {FLAG_REASONS.map((r) => (
                <button key={r.id} type="button" className="flag-chip" onClick={() => { onFlag(card.id, r.id); setFlag('sent') }}>
                  {t(r.label)}
                </button>
              ))}
              <button type="button" className="flag-link" onClick={() => setFlag('closed')}>{t('Never mind')}</button>
            </div>
          )}
          {flag === 'sent' && <span className="flag-thanks">{t('Noted. Your AI will do better.')}</span>}
        </div>
      </div>
    </section>
  )
}
