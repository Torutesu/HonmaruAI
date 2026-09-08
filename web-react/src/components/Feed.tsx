import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronRight, FileVideo, Link2, MessageSquare, Mic, Plus, Send, Sparkles, UserRound, X } from 'lucide-react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
import { requestContext } from '../utils/cardPresentation'
import { useT, t } from '../utils/i18n'
import './Feed.css'
interface Props {
  cards: DecisionCard[]; userId: string; businesses: Business[]; focusCardId: string | null
  onDecide: (cardId: string, action: string, options?: { replyText?: string }) => boolean
  onAsk: (text: string, card: DecisionCard, videoURL?: string) => void
  connected: boolean; loaded: boolean; active: boolean; sample?: boolean
  onAttach?: (file: File) => Promise<string>
}
const KIND: Record<string, string> = { approval: 'Decisions', notification: 'Notification', task: 'Task', delegation: 'Delegation', revision: 'Revision' }
function ago(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (!Number.isFinite(mins)) return ''
  if (mins < 1) return t('just now')
  if (mins < 60) return t('{n}m ago', { n: mins })
  if (mins < 1440) return t('{n}h ago', { n: Math.floor(mins / 60) })
  if (mins <= 10080) return t('{n}d ago', { n: Math.floor(mins / 1440) })
  return new Date(iso).toLocaleDateString(getLocale())
}
function positive(card: DecisionCard) { return card.type === 'notification' || card.type === 'task' || card.type === 'revision' ? 'acknowledge' : 'approve' }
function positiveLabel(card: DecisionCard) { return card.type === 'notification' ? 'Acknowledge' : card.type === 'task' ? 'Complete task' : card.type === 'revision' ? 'Complete revision' : card.type === 'delegation' ? 'Accept handoff' : 'Approve' }
export const Feed: React.FC<Props> = ({ cards, userId, businesses, focusCardId, onDecide, onAsk, connected, loaded, active, sample, onAttach }) => {
  const t = useT(), container = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const businessNames = useMemo(() => new Map(businesses.map((b) => [b.slug, b.name])), [businesses])
  const scrollTo = useCallback((requested: number) => {
    const next = Math.max(0, Math.min(requested, cards.length - 1)), el = container.current
    if (el) el.scrollTo({ top: next * el.clientHeight, behavior: 'auto' })
    setIndex(next)
  }, [cards.length])
  useEffect(() => { if (index >= cards.length) scrollTo(Math.max(0, cards.length - 1)) }, [cards.length, index, scrollTo])
  useEffect(() => { const at = cards.findIndex((c) => c.id === focusCardId); if (at >= 0) scrollTo(at) }, [cards, focusCardId, scrollTo])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!active || e.repeat || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.closest('input, textarea, select, button, a, [role="dialog"], [contenteditable]')) return
      const card = cards[index]
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); scrollTo(index + 1) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); scrollTo(index - 1) }
      else if (connected && card && e.key.toLowerCase() === 'a') onDecide(card.id, positive(card))
      else if (connected && card && card.type !== 'notification' && e.key.toLowerCase() === 'd') onDecide(card.id, 'decline')
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [active, connected, cards, index, scrollTo, onDecide])
  return <div className="feed" ref={container} aria-label={t('Decision feed')} aria-busy={!loaded} onScroll={(e) => { const el = e.currentTarget; if (el.clientHeight) setIndex(Math.round(el.scrollTop / el.clientHeight)) }}>
    {!cards.length && <section className="page page-empty"><div className="empty-mark"><Check size={28} /></div><h2>{loaded ? t('All clear') : t('Opening your workspace…')}</h2><p>{loaded ? t('Nothing is waiting on you. Your AI will tell you when something is.') : t('Your requests will appear when the connection is ready.')}</p></section>}
    {cards.map((card, position) => <FeedPage isCurrent={position === index} key={card.id} card={card} userId={userId} businessName={businessNames.get(card.business || '') || card.business || ''} onDecide={onDecide} onAsk={onAsk} connected={connected && active} sample={sample} onAttach={onAttach} />)}
    {cards.length > 1 && <div className="page-indicator"><span aria-live="polite">{Math.min(index + 1, cards.length)} / {cards.length}</span><button className="feed-accessible-nav" disabled={index === 0} onClick={() => scrollTo(index - 1)}>{t('Previous request')}</button><button className="feed-accessible-nav" disabled={index === cards.length - 1} onClick={() => scrollTo(index + 1)}>{t('Next request')}</button></div>}
  </div>
}
interface PageProps { isCurrent:boolean; card: DecisionCard; userId: string; businessName: string; onDecide: Props['onDecide']; onAsk: Props['onAsk']; connected: boolean; sample?: boolean; onAttach?: Props['onAttach'] }
const FeedPage: React.FC<PageProps> = ({ isCurrent, card, businessName, onDecide, onAsk, connected, sample, onAttach }) => {
  const t = useT(), [dx, setDx] = useState(0), [ask, setAsk] = useState(''), [menu, setMenu] = useState(false), [replyMode, setReplyMode] = useState(false)
  const [voice, setVoice] = useState(false), [attachment, setAttachment] = useState<{ name: string; url: string } | null>(null), [uploading, setUploading] = useState(false), [error, setError] = useState('')
  const start = useRef<{ x: number; y: number; id: number } | null>(null), file = useRef<HTMLInputElement>(null), recognition = useRef<any>(null), alive = useRef(true)
  const localized = card.localized?.[getLocale()], who = card.requestedBy
  const whoName = who?.name || displayName(card.senderUserID)
  const quote = who?.quote || card.sourceInstruction || card.originalBody || ''
  const context = requestContext(card, localized?.context || card.context || '').join('\n')
  const sourceURL = who?.sourceUrl || card.githubIssueURL
  const safeSource = sourceURL && /^https?:\/\//.test(sourceURL) ? sourceURL : undefined
  const [fullQuote, setFullQuote] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; recognition.current?.abort() } }, [])
  const cancel = () => { start.current = null; setDx(0) }
  const dictate = () => {
    if (voice) { recognition.current?.stop(); return }
    const API = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!API) { setError(t('Voice input is unavailable in this browser. You can use your keyboard’s dictation.')); return }
    const speech = new API(); recognition.current = speech; speech.lang = getLocale(); speech.interimResults = false
    speech.onresult = (event: any) => { if (alive.current) setAsk((text) => `${text}${text ? ' ' : ''}${event.results[0][0].transcript}`) }
    speech.onerror = () => { if (alive.current) { setVoice(false); setError(t('Voice input stopped. You can keep typing.')) } }
    speech.onend = () => { if (alive.current) setVoice(false) }
    try { speech.start(); setVoice(true); setError('') } catch { setError(t('Voice input could not start.')) }
  }
  const submit = () => {
    if (!ask.trim() || !connected || uploading) return
    if (replyMode) { onDecide(card.id, 'reply', { replyText: ask.trim() }) }
    else { onAsk(ask.trim(), card, attachment?.url); setAsk(''); setAttachment(null) }
  }
  return <section ref={(element) => { if (element) element.inert = !isCurrent }} aria-hidden={!isCurrent || undefined} className={`page${dx > 24 ? ' hint-approve' : dx < -24 ? ' hint-decline' : ''}`}>
    <div className="page-inner">
      <article className="card" style={{ transform: `translateX(${dx}px)`, transition: dx ? 'none' : 'transform 160ms ease' }}
        onPointerDown={(e) => { if (connected && e.isPrimary && e.button === 0 && !(e.target as HTMLElement).closest('button, input, a, textarea, details')) start.current = { x: e.clientX, y: e.clientY, id: e.pointerId } }}
        onPointerMove={(e) => { if (!start.current || e.pointerId !== start.current.id) return; const x = e.clientX - start.current.x, y = e.clientY - start.current.y; if (Math.abs(y) > 20 && Math.abs(y) > Math.abs(x)) cancel(); else if (Math.abs(x) > Math.abs(y)) setDx(Math.max(-120, Math.min(120, x))) }}
        onPointerUp={(e) => { if (start.current && e.pointerId === start.current.id) { const x = e.clientX - start.current.x, y = e.clientY - start.current.y; if (connected && Math.abs(x) > 96 && Math.abs(x) > Math.abs(y)) { if (x > 0) onDecide(card.id, positive(card)); else if (card.type !== 'notification') onDecide(card.id, 'decline') } } cancel() }} onPointerCancel={cancel} onPointerLeave={cancel}>
        <header className="card-top"><span className="card-kind">{t(KIND[card.type] || card.type)}</span><span className="priority-legend" aria-label={`${t('Priority')}: ${t(card.priority[0].toUpperCase() + card.priority.slice(1))}`}>{['low', 'medium', 'high'].map((level) => <span key={level} className={`legend p-${level}${card.priority === level || card.priority === 'urgent' && level === 'high' ? ' on' : ''}`}><span />{t(level === 'high' && card.priority === 'urgent' ? 'Urgent' : level[0].toUpperCase() + level.slice(1))}</span>)}</span></header>
        <h1 className="card-title">{localized?.title || card.title}</h1>
        {(localized?.summary || card.summary) && <p className="card-summary">{localized?.summary || card.summary}</p>}
        <div className="card-sources">{safeSource ? <a className="source-chip" href={safeSource} target="_blank" rel="noreferrer"><Link2 size={16} />{(sample && card.sourceApp ? t(card.sourceApp) : card.sourceApp) || t('Original source')}<ArrowUpRight size={13} /></a> : <span className="source-chip"><MessageSquare size={15} />{(sample && card.sourceApp ? t(card.sourceApp) : card.sourceApp) || t('Direct request')}</span>}{businessName && <span className="source-business">{businessName}</span>}</div>
        {whoName && <section className="requested-by"><div className="rb-label">{t('Requested By')}</div><div className="rb-row">{who?.avatarUrl && /^https?:\/\//.test(who.avatarUrl) ? <img className="avatar" src={who.avatarUrl} alt="" /> : <span className="avatar" aria-hidden="true"><UserRound size={21} /></span>}<div className="rb-who"><strong>{whoName}</strong><span className="rb-meta">{ago(card.createdAt)}{who?.role && <> <span>·</span> {t(who.role)}</>}</span></div></div>{quote && <><blockquote className={`rb-quote${fullQuote ? ' expanded' : ''}`}>“{quote}”</blockquote>{quote.length > 180 && <button className="rb-expand" onClick={() => setFullQuote(!fullQuote)}>{t(fullQuote ? 'Show less' : 'Read full request')}</button>}</>}{safeSource && <a className="rb-link" href={safeSource} target="_blank" rel="noreferrer">{t('View original')}{card.sourceApp ? ` ${t('in')} ${card.sourceApp}` : ''}<ChevronRight size={15} /></a>}</section>}
        {context && context !== quote && context !== (localized?.summary || card.summary) && <details className="card-background"><summary>{t('Background')}</summary><p>{context}</p></details>}
        {card.videoURL && /^https?:\/\//.test(card.videoURL) && <video className="card-video" controls playsInline preload="metadata" src={card.videoURL} />}
        {card.recommendation && <section className="recommendation"><div className="rec-head"><Sparkles size={17} /><span>{t(sample ? 'Sample recommendation:' : 'Recommended:')} <strong>{t(card.recommendation.action === 'approve' ? 'Approve' : card.recommendation.action === 'decline' ? 'Decline' : 'Request revision')}</strong></span></div>{card.recommendation.reason && <p className="rec-reason">{card.recommendation.reason}</p>}</section>}
      </article>
      <div className="decide-row"><button className="decide decline" disabled={!connected || card.type === 'notification'} onClick={() => onDecide(card.id, 'decline')} aria-label={t('Decline')} title={t('Decline')}><X size={30} strokeWidth={1.8} /></button><button className="decide approve" disabled={!connected} onClick={() => onDecide(card.id, positive(card))} aria-label={t(positiveLabel(card))} title={t(positiveLabel(card))}><Check size={29} strokeWidth={1.9} /></button></div>
      <div className="ask-area">{(error || replyMode || attachment) && <div className="ask-status" role={error ? 'alert' : 'status'}><span>{error || (attachment ? attachment.name : t('Your response completes this request.'))}</span><button onClick={() => { setError(''); setReplyMode(false); setAttachment(null) }} aria-label={t('Dismiss')}><X size={13} /></button></div>}{menu && <div className="ask-menu"><button onClick={() => { setReplyMode(true); setMenu(false) }}><MessageSquare size={16} />{t('Respond to sender')}</button><button disabled={!onAttach} onClick={() => { file.current?.click(); setMenu(false) }}><FileVideo size={16} />{t('Attach a video')}</button><button onClick={() => { setAsk((text) => `${text}${text ? '\n' : ''}https://`); setMenu(false) }}><Link2 size={16} />{t('Add a link')}</button></div>}
        <input className="file-input" ref={file} type="file" accept="video/mp4,video/webm,video/quicktime" onChange={async (e) => { const selected = e.target.files?.[0]; if (!selected || !onAttach) return; e.target.value = ''; if (selected.size > 12 * 1024 * 1024) { setError(t('Choose a video smaller than 12 MB.')); return }; setUploading(true); setError(''); try { const url = await onAttach(selected); if (alive.current) setAttachment({ name: selected.name, url }) } catch { if (alive.current) setError(t('The video could not be attached. Try again.')) } finally { if (alive.current) setUploading(false) } }} />
        <form className="ask-bar" onSubmit={(e) => { e.preventDefault(); submit() }}><button type="button" className="ask-plus" aria-label={t('Add to request')} aria-expanded={menu} onClick={() => setMenu(!menu)}><Plus size={22} /></button><input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={t(replyMode ? 'Write your response…' : 'Ask anything...')} aria-label={t('Ask your AI about this decision')} maxLength={10000} disabled={uploading} /><button type="button" className={`ask-mic${voice ? ' recording' : ''}`} onClick={dictate} aria-label={t(voice ? 'Stop voice input' : 'Voice input')}><Mic size={20} /></button><button type="submit" className="ask-send" disabled={!ask.trim() || !connected || uploading} aria-label={t('Send')}><Send size={22} strokeWidth={1.6} /></button></form>
      </div>
    </div>
  </section>
}
