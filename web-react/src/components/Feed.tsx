import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { requestContext } from '../utils/cardPresentation'
import { Icon } from './Icon'
import './Feed.css'

interface Props {
  cards: DecisionCard[]
  userId: string
  businesses: Business[]
  focusCardId: string | null
  onDecide: (cardId: string, action: string, options?: { replyText?: string }) => boolean
  active: boolean
  connected: boolean
  loaded: boolean
  onCompose: () => void
}

function fromLine(card: DecisionCard, userId: string): string {
  if (!card.senderUserID || card.senderUserID === userId || card.senderUserID === 'deleted-user') return 'Your AI'
  return `${card.senderUserID.replace(/^(u:|email:)/, '').split('@')[0]}'s AI`
}

export const Feed: React.FC<Props> = ({ cards, userId, businesses, focusCardId, onDecide, active, connected, loaded, onCompose }) => {
  const container = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [replyCardId, setReplyCardId] = useState<string | null>(null)
  const nameOf = useMemo(() => new Map(businesses.map((business) => [business.slug, business.name])), [businesses])
  const scrollTo = useCallback((requested: number) => {
    const el = container.current
    if (!el) return
    const next = Math.max(0, Math.min(requested, cards.length - 1))
    el.scrollTo({ top: next * el.clientHeight, behavior: 'auto' })
    setIndex(next)
  }, [cards.length])

  useEffect(() => { if (index >= cards.length) scrollTo(Math.max(0, cards.length - 1)) }, [cards.length, index, scrollTo])
  useEffect(() => {
    if (!focusCardId) return
    const target = cards.findIndex((card) => card.id === focusCardId)
    if (target >= 0) scrollTo(target)
  }, [focusCardId, cards, scrollTo])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.target as HTMLElement)?.closest('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]')) return
      const key = event.key.toLowerCase()
      const card = cards[index]
      if (key === 'arrowdown' || key === 'j') { event.preventDefault(); scrollTo(index + 1) }
      else if (key === 'arrowup' || key === 'k') { event.preventDefault(); scrollTo(index - 1) }
      else if (card && connected && key === 'r') { event.preventDefault(); setReplyCardId(card.id) }
      else if (card && connected && key === 'a') onDecide(card.id, card.type === 'notification' ? 'acknowledge' : 'approve')
      else if (card && connected && card.type !== 'notification' && key === 'd') onDecide(card.id, 'decline')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, connected, cards, index, onDecide, scrollTo])

  return <div className="feed-region">
    <div className="feed" ref={container} onScroll={(event) => { const el = event.currentTarget; if (el.clientHeight) setIndex(Math.round(el.scrollTop / el.clientHeight)) }} aria-label="Decision feed" aria-busy={!loaded}>
      {cards.length === 0 && <section className="page page-empty"><div className={`empty-mark ${!loaded ? 'empty-loading' : ''}`}><Icon name={loaded ? 'check' : 'inbox'} size={29} /></div><span className="eyebrow">{loaded ? 'A little breathing room' : 'Getting everything ready'}</span><h2>{loaded ? 'You’re all caught up.' : 'Opening your workspace…'}</h2><p>{loaded ? 'Your next decision will appear here. In the meantime, put something in motion for your team.' : 'Your decisions will appear once we connect. If this takes a moment, check your internet connection.'}</p>{loaded && <button className="empty-compose" onClick={onCompose}><Icon name="plus" size={16} />Create a request</button>}<div className="empty-footnote"><span className={`dot ${connected ? 'on' : 'off'}`} />{connected ? 'Listening for new decisions' : 'Reconnecting to live updates'}</div></section>}
      {cards.map((card) => <FeedPage key={card.id} card={card} userId={userId} businessName={nameOf.get(card.business || '') || card.business || ''} onDecide={onDecide} connected={connected && active} requestReply={replyCardId === card.id} onReplyOpened={() => setReplyCardId(null)} />)}
    </div>
    {cards.length > 0 && <div className="page-navigation"><span>{Math.min(index + 1, cards.length)} <span>of {cards.length} decisions</span></span><div><button onClick={() => scrollTo(index - 1)} disabled={index === 0} aria-label="Previous decision"><Icon name="up" size={17} /></button><button onClick={() => scrollTo(index + 1)} disabled={index >= cards.length - 1} aria-label="Next decision"><Icon name="down" size={17} /></button></div></div>}
  </div>
}

interface PageProps {
  card: DecisionCard
  userId: string
  businessName: string
  onDecide: Props['onDecide']
  connected: boolean
  requestReply: boolean
  onReplyOpened: () => void
}

const FeedPage: React.FC<PageProps> = ({ card, userId, businessName, onDecide, connected, requestReply, onReplyOpened }) => {
  const [dx, setDx] = useState(0)
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const localized = card.localized?.[getLocale()]
  const context = localized?.context || card.context || ''
  const contextItems = requestContext(card, context)
  const acknowledge = card.type === 'notification'
  useEffect(() => { if (requestReply) { setReplying(true); onReplyOpened() } }, [requestReply, onReplyOpened])

  const cancelGesture = () => { start.current = null; setDx(0) }
  const onPointerDown = (event: React.PointerEvent) => {
    if (!connected || replying || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest('button, textarea, input, a, details')) return
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
  }
  const onPointerMove = (event: React.PointerEvent) => {
    if (!start.current || start.current.id !== event.pointerId) return
    const horizontal = event.clientX - start.current.x, vertical = event.clientY - start.current.y
    if (Math.abs(vertical) > 20 && Math.abs(vertical) > Math.abs(horizontal)) { cancelGesture(); return }
    if (Math.abs(horizontal) > Math.abs(vertical)) setDx(Math.max(-150, Math.min(150, horizontal)))
  }
  const onPointerUp = (event: React.PointerEvent) => {
    if (!start.current || start.current.id !== event.pointerId) return
    const horizontal = event.clientX - start.current.x, vertical = event.clientY - start.current.y
    if (connected && Math.abs(horizontal) > 96 && Math.abs(horizontal) > Math.abs(vertical)) {
      if (horizontal > 0) onDecide(card.id, acknowledge ? 'acknowledge' : 'approve')
      else if (!acknowledge) onDecide(card.id, 'decline')
    }
    cancelGesture()
  }
  const hint = dx > 24 ? 'approve' : dx < -24 && !acknowledge ? 'decline' : null

  return <section className={`page${hint ? ` hint-${hint}` : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancelGesture} onPointerLeave={cancelGesture}>
    <article className="page-inner" style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 160ms ease' : 'none' }}>
      <header className="page-head"><span className={`kind kind-${card.type}`}>{acknowledge ? 'FYI' : card.type}</span>{businessName && <span className="business">{businessName}</span>}{['urgent', 'high'].includes(card.priority) && <span className={`priority priority-${card.priority}`}><span />{card.priority} priority</span>}</header>
      <div className="page-body"><div className="page-from"><span className="sender-mark"><Icon name="sparkle" size={15} /></span><span>{fromLine(card, userId)} <span>sent you a request</span></span></div><h2 className="page-title">{localized?.title || card.title}</h2>{(localized?.summary || card.summary) && <p className="page-summary">{localized?.summary || card.summary}</p>}
        {contextItems.length > 0 && <ul className="page-context">{contextItems.map((segment, i) => { const [label, ...rest] = segment.split(/[:：]/); const detail = rest.join(':').trim(); return <li key={i}>{detail ? <><span className="ctx-label">{label.trim()}</span><span className="ctx-detail">{detail}</span></> : <span className="ctx-detail">{segment}</span>}</li> })}</ul>}
        {card.sourceInstruction && card.sourceInstruction !== (localized?.summary || card.summary) && <details className="page-original"><summary>View full request</summary><p>{card.sourceInstruction}</p></details>}
        {card.routingReason && <div className="routing-note"><Icon name="sparkle" size={14} /><span>{card.routingReason}</span></div>}
        {card.originalBody && card.originalLanguage && <details className="page-original"><summary>Translated from {card.originalLanguage}</summary><p>{card.originalBody}</p></details>}
        {card.sourceApp && <div className="page-source">From {card.sourceApp}{card.sourceDetail ? ` · ${card.sourceDetail}` : ''}</div>}
      </div>
      <div className="page-action-area">{replying ? <form className="page-reply" onSubmit={(event) => { event.preventDefault(); if (reply.trim() && onDecide(card.id, 'reply', { replyText: reply.trim() })) { setReply(''); setReplying(false) } }}><label className="reply-label" htmlFor={`reply-${card.id}`}>Your reply</label><textarea id={`reply-${card.id}`} autoFocus value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Share an answer or ask for more context…" rows={3} maxLength={10000} /><div className="page-reply-actions"><button type="button" className="ghost" onClick={() => setReplying(false)}>Cancel</button><button type="submit" className="primary" disabled={!reply.trim() || !connected}>Send reply<Icon name="arrow" size={16} /></button></div></form> : <div className="page-actions">{!acknowledge && <button className="decline" disabled={!connected} onClick={() => onDecide(card.id, 'decline')} aria-keyshortcuts="d">Decline</button>}<button className="ghost" disabled={!connected} onClick={() => setReplying(true)} aria-keyshortcuts="r">Reply</button><button className="primary" disabled={!connected} onClick={() => onDecide(card.id, acknowledge ? 'acknowledge' : 'approve')} aria-keyshortcuts="a"><Icon name="check" size={17} />{acknowledge ? 'Got it' : 'Approve'}</button></div>}<div className="page-swipe-hint">{!connected ? 'Reconnect to save your decision' : acknowledge ? 'Swipe right to acknowledge' : 'Swipe right to approve · left to decline'}</div></div>
    </article>
  </section>
}
