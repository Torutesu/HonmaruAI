import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Send } from 'lucide-react'
import { readResponse } from '../utils/api'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import type { CardPriority, CardType } from '../types/card'
interface Member { id: string; name: string; role: string }
interface Draft { title: string; summary: string; context: string; type: CardType; priority: CardPriority; recipientUserID: string; business?: string; recommendation?: any }
interface Props {
  relayHttpUrl: string; orgId: string; userId: string; sessionToken: string; connected: boolean
  onSendCard: (card: any) => Promise<void>; onLog: (message: string) => void; onDone?: () => void; autoFocus?: boolean
  membersError?:boolean; onReloadMembers?:() => void
  members: Member[]; initialText?: string; initialRecipient?: string; videoURL?: string; sample?: boolean; open?: boolean
}
export const CreateDecision: React.FC<Props> = ({ relayHttpUrl, orgId, userId, sessionToken, onSendCard, onLog, onDone, autoFocus, connected, members, membersError, onReloadMembers, initialText = '', initialRecipient = '', videoURL, sample, open = true }) => {
  const t = useT(), [text, setText] = useState(initialText), [recipient, setRecipient] = useState(initialRecipient), [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const epoch = useRef(0), request = useRef<AbortController | null>(null), pendingId = useRef<string | null>(null)
  useEffect(() => { epoch.current++; return () => { epoch.current++; request.current?.abort() } }, [relayHttpUrl, orgId, userId, sessionToken, open])
  useEffect(() => { setText(initialText); setRecipient(initialRecipient); setDraft(null); setError(''); setNotice(''); pendingId.current = null }, [initialText, initialRecipient, relayHttpUrl, orgId, userId, sessionToken])
  useEffect(() => { if (!open) setBusy(false) }, [open])
  const known = (id: string) => members.some((member) => member.id === id)
  const manual = (): Draft => ({ title: text.trim().split('\n')[0].slice(0, 120), summary: text.trim().slice(0, 2000), context: '', type: 'approval', priority: 'medium', recipientUserID: recipient })
  const prepare = async (ai: boolean) => {
    if (!text.trim() || !known(recipient) || busy) return
    setError(''); pendingId.current = null
    if (!ai || sample) { setDraft(manual()); setNotice(t(sample ? 'Sample draft. Nothing is sent outside this browser.' : 'Review and edit the request before sending.')); return }
    const current = epoch.current; request.current = new AbortController(); setBusy(true)
    try {
      const routed = await readResponse(await fetch(`${relayHttpUrl}/ai/route`, { method: 'POST', signal: request.current.signal, headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify({ text: text.trim(), recipientUserID: recipient, sender: { id: userId, role: 'member' }, readerLanguage: getLocale(), organization: { orgId } }) }))
      if (epoch.current !== current) return
      if (routed.recipientUserID !== recipient) throw new Error(t('A recipient could not be confirmed.'))
      setDraft({ title: routed.title || manual().title, summary: (routed.summary || text.trim()).slice(0, 2000), context: routed.routedBy === 'fallback' ? '' : (routed.context || '').slice(0, 8000), type: routed.cardType || 'approval', priority: routed.priority || 'medium', recipientUserID: recipient, ...(routed.business ? { business: routed.business } : {}), ...(routed.recommendation ? { recommendation: routed.recommendation } : {}) })
      setNotice(t(routed.routedBy === 'fallback' ? 'Prepared without AI. Review and edit before sending.' : 'AI-assisted draft. Review the details before sending.'))
    } catch (e) { if (epoch.current === current) setError(e instanceof Error ? e.message : t('Your AI could not route that.')) }
    finally { if (epoch.current === current) setBusy(false) }
  }
  const send = async () => {
    if (!draft || busy || !connected || !known(draft.recipientUserID) || !draft.title.trim() || !draft.summary.trim()) return
    const current = epoch.current; setBusy(true); setError(''); pendingId.current ||= `card-${crypto.randomUUID()}`
    try {
      await onSendCard({ ...draft, title: draft.title.trim(), summary: draft.summary.trim(), id: pendingId.current, status: 'pending', createdAt: new Date().toISOString(), sourceInstruction: text.trim(), ...(videoURL ? { videoURL } : {}) })
      if (epoch.current !== current) return
      onLog(`Created decision: ${pendingId.current}`); pendingId.current = null; setText(''); setRecipient(''); setDraft(null); onDone?.()
    } catch (e) { if (epoch.current === current) setError(e instanceof Error ? e.message : t('Could not confirm delivery. Check Sent before retrying.')) }
    finally { if (epoch.current === current) setBusy(false) }
  }
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => d ? { ...d, [key]: value } : d)
  return <form className="figma-compose" onSubmit={(event) => { event.preventDefault(); draft ? send() : prepare(!sample) }}>
    {draft ? <><div className="form-note">{notice}{text.length > 2000 && <p>{t('The complete original request is retained with this summary.')}</p>}</div><div className="field"><label htmlFor="request-subject">{t('Subject')}</label><input id="request-subject" value={draft.title} maxLength={200} disabled={busy} required onChange={(e) => update('title', e.target.value)} /></div><div className="field"><label htmlFor="preview-recipient">{t('Recipient')}</label><select id="preview-recipient" value={draft.recipientUserID} disabled={busy} onChange={(e) => update('recipientUserID', e.target.value)}>{!known(draft.recipientUserID) && <option value="">{t('Choose a teammate')}</option>}{members.map((member) => <option key={member.id} value={member.id}>{member.name}{member.id === userId ? ` (${t('You')})` : ''}</option>)}</select></div><div className="field"><label htmlFor="request-summary">{t('Request')}</label><textarea id="request-summary" value={draft.summary} maxLength={2000} rows={4} required disabled={busy} onChange={(e) => update('summary', e.target.value)} /></div><div className="field"><label htmlFor="request-background">{t('Background')}</label><textarea id="request-background" value={draft.context} maxLength={8000} rows={2} disabled={busy} onChange={(e) => update('context', e.target.value)} /></div><div className="compose-fields"><div className="field"><label htmlFor="request-type">{t('Request type')}</label><select id="request-type" value={draft.type} disabled={busy} onChange={(e) => update('type', e.target.value as CardType)}>{['approval', 'notification', 'task', 'delegation', 'revision'].map((type) => <option key={type} value={type}>{t(type[0].toUpperCase() + type.slice(1))}</option>)}</select></div><div className="field"><label htmlFor="request-priority">{t('Priority')}</label><select id="request-priority" value={draft.priority} disabled={busy} onChange={(e) => update('priority', e.target.value as CardPriority)}>{['low', 'medium', 'high', 'urgent'].map((p) => <option key={p} value={p}>{t(p[0].toUpperCase() + p.slice(1))}</option>)}</select></div></div></> : <><div className="field"><label htmlFor="new-recipient">{t('Recipient')}</label><select id="new-recipient" value={recipient} disabled={busy} onChange={(e) => setRecipient(e.target.value)} required><option value="">{t('Choose a teammate')}</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}{member.id === userId ? ` (${t('You')})` : ''}</option>)}</select>{membersError ? <p className="form-error" role="alert">{t('Your team could not be loaded.')} <button type="button" className="btn btn-quiet" onClick={onReloadMembers}>{t('Try again')}</button></p> : !members.length && <p className="hint">{t('Your team is loading. Try again in a moment.')}</p>}</div><div className="field"><label htmlFor="new-request">{t('What needs your attention?')}</label><textarea id="new-request" autoFocus={autoFocus} value={text} onChange={(e) => setText(e.target.value)} maxLength={10000} rows={4} disabled={busy} required placeholder={t('Tell your AI — e.g. ask Yuki to approve the spring menu by Friday')} /></div></>}
    {error && <div className="form-error" role="alert">{error}{!draft && <p>{t('You can continue by reviewing manually.')}</p>}</div>}
    {!connected && <div className="form-note">{t('Reconnect to send. Your draft stays here.')}</div>}
    <div className="compose-actions">{draft ? <><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setRecipient(draft.recipientUserID); setDraft(null) }}><ArrowLeft size={16} />{t('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy || !connected || !known(draft.recipientUserID) || !draft.title.trim() || !draft.summary.trim()}><Send size={16} />{t(busy ? 'Confirming delivery…' : sample ? 'Create sample request' : 'Send request')}</button></> : <>{!sample && <button type="button" className="btn btn-ghost" disabled={busy || !known(recipient) || !text.trim()} onClick={() => prepare(false)}>{t('Review manually')}</button>}<button type="submit" className="btn btn-primary" disabled={busy || !known(recipient) || !text.trim()}>{t(busy ? 'Preparing…' : 'Review request')}<ArrowRight size={16} /></button></>}</div>
  </form>
}
