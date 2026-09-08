import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, FileText, Send, Sparkles, X } from 'lucide-react'
import type { DecisionCard, CardType, CardPriority, Business } from '../types/card'
import { kindLabels, type Member } from './Workbench'
import { readResponse } from '../utils/api'
import './WorkspaceForms.css'

interface Draft { title: string; summary: string; context: string; type: CardType; priority: CardPriority; recipientUserID: string; business: string }
interface Props { open: boolean; onClose: () => void; userId: string; userName: string; members: Member[]; membersError?: string; businesses: Business[]; connected: boolean; onSend: (card: DecisionCard) => Promise<void>; httpBase?: string; orgId?: string; sessionToken?: string; sample?: boolean }
export function RequestComposer({ open, onClose, userId, userName, members, membersError, businesses, connected, onSend, httpBase, orgId, sessionToken, sample }: Props) {
  const [text, setText] = useState(''), [recipient, setRecipient] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState<'prepare' | 'send' | null>(null)
  const [error, setError] = useState(''), [preparation, setPreparation] = useState('')
  const generation = useRef(0), request = useRef<AbortController | null>(null), dialog = useRef<HTMLDivElement>(null)
  const cardId = useRef<string | null>(null)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => { setText(''); setRecipient(''); setDraft(null); setError(''); setPreparation(''); cardId.current = null }, [userId, orgId, sessionToken, httpBase])
  useEffect(() => { generation.current += 1; return () => { generation.current += 1; request.current?.abort() } }, [userId, orgId, sessionToken, httpBase, open])
  useEffect(() => {
    if (!open) { setBusy(null); return }
    const previous = document.activeElement as HTMLElement | null
    const background = document.querySelector<HTMLElement>('.workbench'); background?.setAttribute('inert', '')
    const node = dialog.current
    const controls = () => Array.from(node?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || []).filter((item) => item.getClientRects().length)
    controls()[0]?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close.current() }
      if (e.key === 'Tab') { const all = controls(), first = all[0], last = all[all.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() } }
    }
    document.addEventListener('keydown', key)
    return () => { background?.removeAttribute('inert'); document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus() }
  }, [open])
  const manual = (): Draft => ({ title: text.trim().split('\n')[0].slice(0, 120), summary: text.trim().slice(0, 2000), context: '', type: 'approval', priority: 'medium', recipientUserID: recipient, business: '' })
  const prepare = async (withAI: boolean) => {
    if (!recipient || !text.trim() || busy || !members.some((m) => m.id === recipient)) return
    setError(''); cardId.current = null
    if (!withAI || sample) { setDraft(manual()); setPreparation(sample ? 'Sample draft. Everything stays in this browser session.' : 'Manual draft. Review and edit every field before sending.'); return }
    const epoch = generation.current; request.current = new AbortController(); setBusy('prepare')
    try {
      const res = await fetch(`${httpBase}/ai/route`, { method: 'POST', signal: request.current.signal, headers: { 'content-type': 'application/json', 'x-session-token': sessionToken! }, body: JSON.stringify({ text: text.trim(), recipientUserID: recipient, sender: { id: userId, name: userName, role: 'member' }, organization: { orgId } }) })
      const route = await readResponse(res)
      if (generation.current !== epoch) return
      if (route.recipientUserID !== recipient) throw new Error('The recipient could not be confirmed. Review a manual draft instead.')
      const fallback = route.routedBy === 'fallback'
      const title = route.title && !/^(Approval needed|Decision needed|Notification|Task assigned|New request)$/i.test(route.title) ? route.title : manual().title
      setDraft({ title, summary: (route.summary || text.trim()).slice(0, 2000), context: fallback ? '' : (route.context || '').slice(0, 8000), type: Object.keys(kindLabels).includes(route.cardType) ? route.cardType : 'approval', priority: ['urgent', 'high', 'medium', 'low'].includes(route.priority) ? route.priority : 'medium', recipientUserID: recipient, business: route.business || '' })
      setPreparation(fallback ? 'Prepared without AI. Review and edit the draft before sending.' : 'AI-assisted draft. Check the details and recipient before sending.')
    } catch (e) { if (generation.current === epoch) setError(e instanceof Error ? e.message : 'Draft preparation is unavailable. You can continue manually.') }
    finally { if (generation.current === epoch) setBusy(null) }
  }
  const send = async () => {
    if (!draft || busy || !connected || !draft.title.trim() || !draft.summary.trim() || !members.some((m) => m.id === draft.recipientUserID)) return
    const epoch = generation.current; setBusy('send'); setError('')
    cardId.current ||= `card-${crypto.randomUUID()}`
    const card: DecisionCard = { id: cardId.current, senderUserID: userId, recipientUserID: draft.recipientUserID, type: draft.type, title: draft.title.trim(), summary: draft.summary.trim(), context: draft.context.trim(), priority: draft.priority, status: 'pending', createdAt: new Date().toISOString(), sourceInstruction: text.trim(), ...(draft.business ? { business: draft.business } : {}) }
    try { await onSend(card); if (generation.current !== epoch) return; setDraft(null); setText(''); setRecipient(''); cardId.current = null; onClose() }
    catch (e) { if (generation.current === epoch) setError(e instanceof Error ? e.message : 'Could not confirm delivery. Check Sent before retrying.') }
    finally { if (generation.current === epoch) setBusy(null) }
  }
  if (!open) return null
  const validRecipient = members.some((m) => m.id === (draft?.recipientUserID || recipient))
  const edit = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => current ? { ...current, [key]: value } : current)
  return <div className="composer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className="composer-panel" role="dialog" aria-modal="true" aria-labelledby="composer-title" ref={dialog}><header><div><span className="composer-icon"><FileText size={21} /></span><div><h2 id="composer-title">{draft ? 'Review your request' : 'New request'}</h2><p>{sample ? 'Sample workspace · local only' : 'One clear request, to the right person'}</p></div></div><button onClick={onClose} aria-label="Close composer"><X size={20} /></button></header><div className="composer-steps"><span className={!draft ? 'is-current' : ''}><span>{draft ? <Check size={12} /> : '1'}</span>Write request</span><span className={draft ? 'is-current' : ''}><span>2</span>Review & send</span></div><form onSubmit={(e) => { e.preventDefault(); draft ? send() : prepare(!sample) }}><div className="composer-body">{draft ? <><div className="form-note"><Check size={15} /><span>{preparation}{text.length > 2000 && ' The draft summary is limited to 2,000 characters. Your complete original request is retained.'}</span></div><label>Subject<input aria-label="Subject" maxLength={200} value={draft.title} onChange={(e) => edit('title', e.target.value)} disabled={!!busy} required /></label><div className="form-columns"><label>Recipient<select aria-label="Recipient" value={draft.recipientUserID} onChange={(e) => edit('recipientUserID', e.target.value)} disabled={!!busy} required>{!validRecipient && <option value={draft.recipientUserID}>Choose an available teammate</option>}{members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === userId ? ' (you)' : ''}</option>)}</select></label><label>Request type<select aria-label="Request type" value={draft.type} onChange={(e) => edit('type', e.target.value as CardType)} disabled={!!busy}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label>Request<textarea aria-label="Request" value={draft.summary} onChange={(e) => edit('summary', e.target.value)} rows={4} maxLength={2000} disabled={!!busy} required /></label><label>Background <span>Optional</span><textarea aria-label="Background" value={draft.context} onChange={(e) => edit('context', e.target.value)} rows={3} maxLength={8000} disabled={!!busy} placeholder="Useful context, constraints, or links" /></label><div className="form-columns"><label>Priority<select aria-label="Priority" value={draft.priority} onChange={(e) => edit('priority', e.target.value as CardPriority)} disabled={!!busy}>{['low', 'medium', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}</select></label><label>Business<select aria-label="Business" value={draft.business} onChange={(e) => edit('business', e.target.value)} disabled={!!busy}><option value="">No business tag</option>{businesses.map((b) => <option value={b.slug} key={b.slug}>{b.name}</option>)}{draft.business && !businesses.some((b) => b.slug === draft.business) && <option value={draft.business}>{draft.business}</option>}</select></label></div></> : <><label>Recipient<select aria-label="Recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} disabled={!!busy || !members.length} required><option value="">Choose a teammate</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === userId ? ' (you)' : ''}</option>)}</select></label>{membersError && <p className="form-error" role="alert">{membersError}</p>}<label>What needs to happen?<textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Explain what you need, why it matters, and any timing or constraints…" rows={7} maxLength={10000} disabled={!!busy} required /></label><p className="form-help">You’ll review and edit the subject, details, and recipient before anything is sent.</p></>}{error && <div className="form-error" role="alert">{error}{!draft && <span> You can continue with Review manually.</span>}</div>}{!connected && <div className="form-note">Your draft is kept here while we reconnect.</div>}</div><footer><span>{draft ? sample ? 'No messages leave this demo.' : 'Only sent after you confirm.' : 'Draft kept while you work.'}</span><div>{draft ? <><button type="button" disabled={!!busy} onClick={() => { setRecipient(draft.recipientUserID); setDraft(null) }}><ArrowLeft size={15} />Back</button><button className="primary-button" type="submit" disabled={!!busy || !connected || !validRecipient || !draft.title.trim() || !draft.summary.trim()}><Send size={15} />{busy === 'send' ? 'Confirming delivery…' : sample ? 'Create sample request' : 'Send request'}</button></> : <>{!sample && <button type="button" disabled={!!busy || !validRecipient || !text.trim()} onClick={() => prepare(false)}>Review manually</button>}<button className="primary-button" type="submit" disabled={!!busy || !validRecipient || !text.trim()}>{sample ? <ArrowRight size={15} /> : <Sparkles size={15} />}{busy === 'prepare' ? 'Preparing…' : sample ? 'Review request' : 'Prepare with AI'}</button></>}</div></footer></form></div></div>
}
