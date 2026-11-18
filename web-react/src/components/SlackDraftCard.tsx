import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

export interface SlackDraftRecord {
  id: string
  text: string
  revision: number
  status: 'pending' | 'draft' | 'sending' | 'sent' | 'failed' | 'unknown' | 'discarded'
  agent?: { id: string; name: string }
  target?: { channelId?: string; label?: string; channelName?: string; name?: string; threadTs?: string | null }
}
interface SlackDraftTarget { channelId: string; name: string; type: string; private: boolean; groupDm: boolean }

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  draftId: string
  /** Honmaru conversation scope only (for example ag:agent-id). Never a Slack target. */
  conversation: string
}

const headers = (sessionToken: string) => ({ 'content-type': 'application/json', 'x-session-token': sessionToken })

export function SlackDraftCard({ httpBase, orgId, sessionToken, draftId, conversation }: Props) {
  const t = useT()
  const [draft, setDraft] = useState<SlackDraftRecord | null>(null)
  const [text, setText] = useState('')
  const [targets, setTargets] = useState<SlackDraftTarget[] | null>(null)
  const [targetId, setTargetId] = useState('')
  const [targetError, setTargetError] = useState('')
  const [busy, setBusy] = useState<'load' | 'save' | 'send' | 'discard' | null>('load')
  const [error, setError] = useState('')
  const [dlpWarning, setDlpWarning] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const path = `${httpBase}/channels/slack-drafts/${encodeURIComponent(draftId)}`
  const query = new URLSearchParams({ orgId, conversation }).toString()

  const load = async () => {
    setError('')
    const response = await fetch(`${path}?${query}`, { headers: { 'x-session-token': sessionToken } })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.draft) throw new Error(body?.message || t('Could not load this Slack draft.'))
    setDraft(body.draft)
    setText(body.draft.text)
    setTargetId(body.draft.target?.channelId || '')
    if (body.draft.status === 'pending' || body.draft.status === 'draft') {
      const targetResponse = await fetch(`${httpBase}/channels/slack-draft-targets?${query}`, { headers: { 'x-session-token': sessionToken } })
      const targetBody = await targetResponse.json().catch(() => null)
      if (!targetResponse.ok || !Array.isArray(targetBody?.targets)) {
        setTargets(null)
        setTargetError(targetBody?.message || t('Could not verify Slack destinations.'))
      } else {
        setTargets(targetBody.targets)
        setTargetError('')
      }
    } else { setTargets([]); setTargetError('') }
  }

  useEffect(() => {
    let active = true
    setBusy('load')
    setError('')
    fetch(`${path}?${query}`, { headers: { 'x-session-token': sessionToken } })
      .then(async response => {
        const body = await response.json().catch(() => null)
        if (!response.ok || !body?.draft) throw new Error(body?.message || t('Could not load this Slack draft.'))
        if (active) { setDraft(body.draft); setText(body.draft.text); setTargetId(body.draft.target?.channelId || '') }
        if (body.draft.status === 'pending' || body.draft.status === 'draft') {
          const targetResponse = await fetch(`${httpBase}/channels/slack-draft-targets?${query}`, { headers: { 'x-session-token': sessionToken } })
          const targetBody = await targetResponse.json().catch(() => null)
          if (!targetResponse.ok || !Array.isArray(targetBody?.targets)) {
            if (active) { setTargets(null); setTargetError(targetBody?.message || t('Could not verify Slack destinations.')) }
          } else if (active) { setTargets(targetBody.targets); setTargetError('') }
        } else if (active) { setTargets([]); setTargetError('') }
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : t('Could not load this Slack draft.')) })
      .finally(() => { if (active) setBusy(null) })
    return () => { active = false }
  }, [path, query, sessionToken, t])

  const act = async (action: 'save' | 'send' | 'discard', dlpAck = false) => {
    if (!draft || busy || !['pending', 'draft'].includes(draft.status)) return
    setBusy(action)
    setError('')
    if (action !== 'send' || dlpAck) setDlpWarning('')
    try {
      const response = await fetch(action === 'send' ? `${path}/send` : path, {
        method: action === 'save' ? 'PUT' : action === 'discard' ? 'DELETE' : 'POST',
        headers: headers(sessionToken),
        body: JSON.stringify({ orgId, conversation, revision: draft.revision,
          ...(action === 'save' ? { text, ...(targetId !== draft.target?.channelId ? { targetChannelId: targetId } : {}) } : {}),
          ...(dlpAck ? { dlpAck: true } : {}) }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body?.draft) {
        if (action === 'send' && body?.code === 'dlp-warning' && typeof body.message === 'string') {
          setDlpWarning(body.message)
          return
        }
        throw new Error(body?.message || t('The Slack draft could not be updated. Reload to check its status.'))
      }
      setDraft(body.draft)
      setText(body.draft.text)
      setTargetId(body.draft.target?.channelId || '')
      setConfirmDiscard(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('The Slack draft could not be updated. Reload to check its status.'))
      // A failed Send response can be ambiguous. Reload the authoritative state;
      // if the server recorded `unknown`, the UI will not offer another Send.
      if (action === 'send') {
        try { await load() } catch { /* Keep the explicit error if the reload also failed. */ }
      }
    } finally { setBusy(null) }
  }

  const status = draft?.status
  const editable = status === 'pending' || status === 'draft'
  const selectedTarget = targets?.find(item => item.channelId === targetId)
  const channelName = selectedTarget?.name || draft?.target?.name || draft?.target?.channelName || draft?.target?.label || t('Slack channel ID')
  const destination = draft?.target?.channelId ? `${channelName} (${targetId || draft.target.channelId})` : channelName
  const target = destination ? t('Slack destination: {destination}', { destination }) : t('Connected Slack destination')
  const targetChanged = Boolean(draft && targetId && targetId !== draft.target?.channelId)
  const textChanged = Boolean(draft && text !== draft.text)
  const canSend = Boolean(targets && selectedTarget && !targetChanged && !textChanged && text.trim())

  return <section className="hx-message-visual hx-slack-draft" aria-label={t('Slack draft')} data-slack-draft={draftId}>
    <header className="hx-message-visual-head"><div>
      <h3>{t('Slack draft')}</h3>
      <p>{draft ? t('To {destination}', { destination: target }) : t('Loading…')}{draft?.target?.threadTs ? ` · ${t('Thread reply')}` : ''}</p>
    </div></header>
    {busy === 'load' && !draft ? <p role="status">{t('Loading…')}</p> : null}
    {draft && <>
      {editable && <textarea aria-label={t('Slack draft text')} value={text} maxLength={4000} rows={Math.max(3, Math.min(10, text.split('\n').length + 1))} disabled={busy !== null} onChange={event => setText(event.currentTarget.value)} />}
      {!editable && <p className="hx-slack-draft-text">{draft.text}</p>}
      {editable && <label className="hx-slack-draft-destination">{t('Send to')}
        <select aria-label={t('Verified Slack destination')} value={targetId} disabled={busy !== null || !targets?.length} onChange={event => setTargetId(event.currentTarget.value)}>
          {draft.target?.channelId && !targets?.some(item => item.channelId === draft.target?.channelId) && <option value={draft.target.channelId}>{`${draft.target.name || t('Saved Slack destination')} (${draft.target.channelId}) · ${t('Unavailable')}`}</option>}
          {(targets || []).map(item => <option key={item.channelId} value={item.channelId}>{`${item.name} (${item.channelId})`}</option>)}
        </select>
      </label>}
      {editable && targetError && <p role="alert">{targetError}</p>}
      {status === 'sent' && <p role="status">{t('Sent to Slack.')}</p>}
      {status === 'sending' && <p role="status">{t('Sending to Slack…')}</p>}
      {status === 'unknown' && <p role="alert">{t('Slack did not confirm whether this message was sent. Check Slack before creating another draft.')}</p>}
      {status === 'failed' && <p role="alert">{t('Slack could not send this draft.')}</p>}
      {status === 'discarded' && <p role="status">{t('Draft discarded.')}</p>}
      {editable && <div className="hx-slack-draft-actions">
        <button type="button" disabled={busy !== null || (!textChanged && !targetChanged) || !text.trim() || !targetId || !selectedTarget} onClick={() => void act('save')}>{busy === 'save' ? t('Saving…') : t('Save draft')}</button>
        {!confirmDiscard
          ? <button type="button" disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>{t('Discard')}</button>
          : <><span>{t('Discard this draft?')}</span><button type="button" disabled={busy !== null} onClick={() => void act('discard')}>{busy === 'discard' ? t('Discarding…') : t('Confirm discard')}</button><button type="button" disabled={busy !== null} onClick={() => setConfirmDiscard(false)}>{t('Keep draft')}</button></>}
        <button type="button" className="primary" disabled={busy !== null || !canSend} onClick={() => void act('send')}>{busy === 'send' ? t('Sending…') : t('Send')}</button>
      </div>}
      {editable && dlpWarning && <div className="hx-slack-draft-warning" role="alert"><p>{dlpWarning}</p><button type="button" disabled={busy !== null || !text.trim() || text !== draft.text} onClick={() => void act('send', true)}>{t('Send anyway')}</button></div>}
    </>}
    {error && <p role="alert">{error} <button type="button" disabled={busy !== null} onClick={() => { setBusy('load'); void load().catch(reason => setError(reason instanceof Error ? reason.message : t('Could not load this Slack draft.'))).finally(() => setBusy(null)) }}>{t('Reload')}</button></p>}
  </section>
}
