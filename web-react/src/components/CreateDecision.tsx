import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Send, Mic, Pencil } from 'lucide-react'
import { readResponse } from '../utils/api'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import type { CardPriority, CardType } from '../types/card'
interface Member { id: string; name: string; role: string }
interface Draft { title: string; summary: string; context: string; type: CardType; priority: CardPriority; recipientUserID: string; business?: string; recommendation?: any }
interface Props {
  relayHttpUrl: string; orgId: string; userId: string; sessionToken: string; connected: boolean
  onSendCard: (card: any) => Promise<void>; onLog: (message: string) => void; onDone?: () => void; autoFocus?: boolean
  onTeam?: () => void; membersError?:boolean; onReloadMembers?:() => void
  members: Member[]; initialText?: string; initialRecipient?: string; videoURL?: string; sample?: boolean; open?: boolean
}
export const CreateDecision: React.FC<Props> = ({ relayHttpUrl, orgId, userId, sessionToken, onSendCard, onLog, onDone, autoFocus, connected, members, onTeam, membersError, onReloadMembers, initialText = '', initialRecipient = '', videoURL, sample, open = true }) => {
  const t = useT(), [text, setText] = useState(initialText), [recipient, setRecipient] = useState(initialRecipient), [draft, setDraft] = useState<Draft | null>(null)
  const [writing, setWriting] = useState(false), [voice, setVoice] = useState(false)
  const speechRef = useRef<any>(null), editor = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (!open) { speechRef.current?.abort(); speechRef.current = null; setVoice(false) }; return () => { speechRef.current?.abort(); speechRef.current = null } }, [open, orgId, sessionToken])
  const dictate = () => {
    if (voice) { speechRef.current?.stop(); return }
    setWriting(true)
    const API = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!API) { setError(t('Voice input is unavailable in this browser. You can use your keyboard’s dictation.')); return }
    const speech = new API(); speechRef.current = speech; speech.lang = getLocale(); speech.interimResults = false
    speech.onresult = (event: any) => { if (speechRef.current === speech) setText((value) => [value, event.results[0][0].transcript].filter(Boolean).join(' ')) }
    speech.onerror = () => { if (speechRef.current === speech) { setVoice(false); setError(t('Voice input stopped. You can keep typing.')) } }
    speech.onend = () => { if (speechRef.current === speech) setVoice(false) }
    try { speech.start(); setVoice(true); setError('') } catch { setError(t('Voice input could not start.')) }
  }
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const epoch = useRef(0), request = useRef<AbortController | null>(null), pendingId = useRef<string | null>(null)
  useEffect(() => { epoch.current++; return () => { epoch.current++; request.current?.abort() } }, [relayHttpUrl, orgId, userId, sessionToken, open])
  useEffect(() => { setText(initialText); setRecipient(initialRecipient); setDraft(null); setError(''); setNotice(''); pendingId.current = null }, [initialText, initialRecipient, relayHttpUrl, userId, sessionToken])
  useEffect(() => { if (!open) setBusy(false) }, [open])
  useEffect(() => { setRecipient(''); setDraft((value) => value ? { ...value, recipientUserID: '' } : value); pendingId.current = null }, [orgId])
  const known = (id: string) => members.some((member) => member.id === id)
  const manual = (): Draft => ({ title: text.trim().split('\n')[0].slice(0, 120), summary: text.trim().slice(0, 2000), context: '', type: 'approval', priority: 'medium', recipientUserID: recipient })
  const prepare = async (ai: boolean) => {
    if (!text.trim() || busy || voice) return
    setError(''); pendingId.current = null
    if (!ai || sample) { setDraft(manual()); setNotice(t(sample ? 'Sample draft. Nothing is sent outside this browser.' : 'Review and edit the request before sending.')); return }
    const current = epoch.current; request.current = new AbortController(); setBusy(true)
    try {
      const routed = await readResponse(await fetch(`${relayHttpUrl}/ai/route`, { method: 'POST', signal: request.current.signal, headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify({ text: text.trim(), ...(known(recipient) ? { recipientUserID: recipient } : {}), sender: { id: userId, role: 'member' }, readerLanguage: getLocale(), organization: { orgId } }) }))
      if (epoch.current !== current) return
      if (known(recipient) && routed.recipientUserID !== recipient) throw new Error(t('A recipient could not be confirmed.'))
      setDraft({ title: routed.title || manual().title, summary: (routed.summary || text.trim()).slice(0, 2000), context: routed.routedBy === 'fallback' ? '' : (routed.context || '').slice(0, 8000), type: routed.cardType || 'approval', priority: routed.priority || 'medium', recipientUserID: known(recipient) ? recipient : known(routed.recipientUserID) ? routed.recipientUserID : '', ...(routed.business ? { business: routed.business } : {}), ...(routed.recommendation ? { recommendation: routed.recommendation } : {}) })
      setNotice(t(routed.routedBy === 'fallback' ? 'Prepared without AI. Review and edit before sending.' : 'AI-assisted draft. Review the details before sending.'))
    } catch { if (epoch.current === current) { setDraft(manual()); setNotice(t('Prepared without AI. Review and edit before sending.')) } }
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
  return <form className="figma-compose simple-compose" onSubmit={(event) => { event.preventDefault(); draft ? send() : prepare(!sample) }}>
    {draft ? <>
      <article className="draft-preview"><h2>{draft.title}</h2><p>{draft.summary}</p></article>
      <div className="field"><label htmlFor="preview-recipient">{t('Send to')}</label><select id="preview-recipient" value={draft.recipientUserID} disabled={busy} onChange={(e) => update('recipientUserID', e.target.value)}><option value="">{t('Choose a teammate')}</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}{member.id === userId ? ` (${t('You')})` : ''}</option>)}</select></div>
      {(membersError || !members.some((m) => m.id !== userId)) && <p className="form-note">{t('Invite a teammate or join a team. Your draft stays here.')}</p>}
      {membersError && <button type="button" className="btn btn-quiet" onClick={onReloadMembers}>{t('Try again')}</button>}
      {onTeam && <button type="button" className="btn btn-quiet" onClick={onTeam}>{t('Set up team')}</button>}
      <details className="draft-edit"><summary>{t('Edit details')}</summary>
        <div className="field"><label htmlFor="request-subject">{t('Subject')}</label><input id="request-subject" value={draft.title} maxLength={200} disabled={busy} onChange={(e) => update('title', e.target.value)} /></div>
        <div className="field"><label htmlFor="request-summary">{t('Request')}</label><textarea id="request-summary" value={draft.summary} maxLength={2000} disabled={busy} rows={4} onChange={(e) => update('summary', e.target.value)} /></div>
        <div className="field"><label htmlFor="request-background">{t('Background')}</label><textarea id="request-background" value={draft.context} maxLength={8000} disabled={busy} onChange={(e) => update('context', e.target.value)} /></div>
        <div className="compose-fields"><div className="field"><label htmlFor="request-type">{t('Request type')}</label><select id="request-type" value={draft.type} disabled={busy} onChange={(e) => update('type', e.target.value as CardType)}>{['approval','notification','task','delegation','revision'].map((type) => <option key={type} value={type}>{t(type[0].toUpperCase()+type.slice(1))}</option>)}</select></div><div className="field"><label htmlFor="request-priority">{t('Priority')}</label><select id="request-priority" value={draft.priority} disabled={busy} onChange={(e) => update('priority',e.target.value as CardPriority)}>{['low','medium','high','urgent'].map((value) => <option key={value} value={value}>{t(value[0].toUpperCase()+value.slice(1))}</option>)}</select></div></div>
      </details><p className="form-note">{notice}</p>
    </> : <>
      <h2>{t('What’s on your mind?')}</h2>
      <div className="capture-choices"><button type="button" onClick={dictate} disabled={busy} aria-pressed={voice}><Mic size={32}/>{t(voice ? 'Stop recording' : 'Speak')}</button><button type="button" disabled={busy || voice} onClick={() => { setWriting(true); requestAnimationFrame(() => editor.current?.focus()) }}><Pencil size={32}/>{t('Write')}</button></div>
      {(writing || text) && <div className="field"><textarea ref={editor} id="new-request" aria-label={t('What needs your attention?')} value={text} onChange={(e) => setText(e.target.value)} maxLength={10000} rows={5} disabled={busy || voice} placeholder={t('What needs your attention?')} /></div>}
      <p className="form-note">{t('AI will turn your words into a card.')}</p>
    </>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {!connected && draft && <div className="form-note">{t('Reconnect to send. Your draft stays here.')}</div>}
    <div className="compose-actions">{draft ? <><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setRecipient(draft.recipientUserID); setDraft(null) }}><ArrowLeft size={16}/>{t('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy || !connected || !known(draft.recipientUserID) || !draft.title.trim() || !draft.summary.trim()}><Send size={16}/>{t(busy ? 'Confirming delivery…' : sample ? 'Create sample request' : 'Send request')}</button></> : <button type="submit" className="btn btn-primary" disabled={busy || voice || !text.trim()}>{t(busy ? 'Preparing…' : 'Review request')}<ArrowRight size={16}/></button>}</div>
  </form>
}
