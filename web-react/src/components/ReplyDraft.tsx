import React, { useEffect, useState } from 'react'
import type { DecisionCard } from '../types/card'
import { getLocale } from '../utils/locale'
import { useT } from '../utils/i18n'
import { aiHeaders } from '../utils/aiKey'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  card: DecisionCard
}

interface Draft { busy: boolean; text?: string; original?: string; error?: string; sending?: boolean; sent?: string; sendError?: string; remembering?: boolean; remembered?: boolean; rememberError?: string; queueing?: boolean; queued?: boolean; queueError?: string }

/// The apps a reply can go back through, from here. The Worker knows which
/// thread; the client only knows whether to offer the button.
const SENDABLE = new Set(['Gmail', 'Slack'])

/// The message back to whoever asked, drafted from the decision. A draft:
/// it is shown to be read, changed and sent by the person. When the card
/// came from Gmail or Slack it can go back on that thread from here;
/// otherwise Copy, and the person's own mail client.
///
/// One component, used under a decided card in the feed and in a History
/// row, so the two never drift.
export const ReplyDraft: React.FC<Props> = ({ httpBase, orgId, sessionToken, card }) => {
  const t = useT()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!card.sourceAgentId) return
    let active = true
    fetch(`${httpBase}/ai/draft-edits?orgId=${encodeURIComponent(orgId)}&cardId=${encodeURIComponent(card.id)}`, {
      headers: { 'x-session-token': sessionToken },
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}))
      if (active && res.ok && data.queued) setDraft((prev) => ({ ...(prev || { busy: false }), queued: true }))
    }).catch(() => {})
    return () => { active = false }
  }, [httpBase, orgId, sessionToken, card.id, card.sourceAgentId])

  const queueEdits = async (original: string, revised: string) => {
    if (!card.sourceAgentId || !original || original === revised) return
    setDraft((prev) => ({ ...(prev || { busy: false }), queueing: true, queueError: undefined }))
    try {
      const res = await fetch(`${httpBase}/ai/draft-edits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, cardId: card.id, original, revised }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || t('Could not share the edits with the Agent.'))
      setDraft((prev) => ({ ...(prev || { busy: false }), queueing: false, queued: Boolean(data.queued) }))
    } catch (err) {
      setDraft((prev) => ({ ...(prev || { busy: false }), queueing: false, queueError: err instanceof Error ? err.message : String(err) }))
    }
  }

  const discardQueuedEdits = async () => {
    try {
      const res = await fetch(`${httpBase}/ai/draft-edits?orgId=${encodeURIComponent(orgId)}&cardId=${encodeURIComponent(card.id)}`, {
        method: 'DELETE', headers: { 'x-session-token': sessionToken },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || t('Could not discard the queued edits.'))
      setDraft((prev) => ({ ...(prev || { busy: false }), queued: false, queueError: undefined }))
    } catch (err) {
      setDraft((prev) => ({ ...(prev || { busy: false }), queueError: err instanceof Error ? err.message : String(err) }))
    }
  }

  const requestDraft = async () => {
    setDraft({ busy: true })
    try {
      const res = await fetch(`${httpBase}/ai/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken, ...aiHeaders() },
        body: JSON.stringify({ orgId, cardId: card.id, readerLanguage: getLocale() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const why = res.status === 503
          ? t('Your AI has no model to draft with on this deployment.')
          : res.status === 429
            ? t("You have used today's AI answers.")
            : (data.message || t('Your AI could not draft that just now.'))
        setDraft({ busy: false, error: why })
        return
      }
      setDraft({ busy: false, text: data.draft, original: data.draft })
    } catch (err) {
      setDraft({ busy: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const rememberEdits = async () => {
    if (!draft?.original || !draft.text || draft.text === draft.original) return
    setDraft((prev) => ({ ...(prev || { busy: false }), remembering: true, rememberError: undefined }))
    try {
      const res = await fetch(`${httpBase}/ai/draft-preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, cardId: card.id, original: draft.original, revised: draft.text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || t('Could not remember that edit.'))
      setDraft((prev) => ({ ...(prev || { busy: false }), remembering: false, remembered: data.learned?.length > 0, rememberError: data.unchanged ? t('That edit did not reveal a reusable style preference.') : undefined }))
    } catch (err) {
      setDraft((prev) => ({ ...(prev || { busy: false }), remembering: false, rememberError: err instanceof Error ? err.message : String(err) }))
    }
  }

  /// Back the way it came: on the Gmail thread, in the Slack thread. The
  /// text is whatever is in the box by then — the draft, read and changed.
  const sendReply = async (text: string) => {
    if (draft?.original && card.sourceAgentId && text !== draft.original) await queueEdits(draft.original, text)
    setDraft((prev) => ({ ...(prev || { busy: false }), busy: false, sending: true, sendError: undefined }))
    try {
      const res = await fetch(`${httpBase}/cards/${encodeURIComponent(card.id)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDraft((prev) => ({ ...(prev || { busy: false }), sending: false, sendError: data.message || t('Could not send.') }))
        return
      }
      setDraft((prev) => ({ ...(prev || { busy: false }), sending: false, sent: data.via }))
    } catch (err) {
      setDraft((prev) => ({ ...(prev || { busy: false }), sending: false, sendError: err instanceof Error ? err.message : String(err) }))
    }
  }

  const copy = async (text: string) => {
    if (draft?.original && card.sourceAgentId && text !== draft.original) await queueEdits(draft.original, text)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* no clipboard here; the text is on screen to select */ }
  }

  return (
    <div className="reply-draft">
      {/* A refusal leaves the button in place, so a second try is one tap. */}
      {!draft?.busy && !draft?.text && (
        <button className="pill-btn hist-draft" onClick={requestDraft}>{t('Draft the reply')}</button>
      )}
      {draft && (
        <div className="hist-draft-box" aria-live="polite">
          {draft.busy && <p className="hist-draft-hint">{t('Your AI is writing…')}</p>}
          {draft.error && <p className="hist-draft-error">{draft.error}</p>}
          {draft.text !== undefined && (
            <>
              <p className="hist-draft-hint">{t('A draft, in the language the request came in. Read it, change it, send it yourself.')}</p>
              <textarea
                className="hist-draft-text"
                rows={6}
                aria-label={t('The draft')}
                value={draft.text}
                readOnly={Boolean(draft.sent) || draft.sending}
                onBlur={() => {
                  if (!draft.original) return
                  if (draft.text !== draft.original) void queueEdits(draft.original, draft.text || '')
                  else if (draft.queued) void discardQueuedEdits()
                }}
                onChange={(e) => setDraft((prev) => ({ ...(prev || { busy: false }), text: e.target.value, remembered: false, rememberError: undefined, queued: false }))}
              />
              {draft.sent ? (
                <p className="hist-sent">{t('Sent via {app}.', { app: draft.sent || '' })}</p>
              ) : (
                <div className="hist-draft-actions">
                  {draft.text !== draft.original && !draft.remembered && (
                    !card.sourceAgentId && <button className="pill-btn" disabled={draft.remembering || draft.sending} onClick={rememberEdits}>
                      {draft.remembering ? t('Remembering…') : t('Remember my edits')}
                    </button>
                  )}
                  {card.sourceApp && SENDABLE.has(card.sourceApp) && (
                    <button
                      className="pill-btn hist-send"
                      disabled={draft.sending || !(draft.text || '').trim()}
                      onClick={() => sendReply(draft.text || '')}
                    >
                      {draft.sending ? t('Sending…') : t('Send via {app}', { app: card.sourceApp })}
                    </button>
                  )}
                  <button className="pill-btn hist-copy" onClick={() => copy(draft.text || '')}>
                    {copied ? t('Copied') : t('Copy')}
                  </button>
                </div>
              )}
              {card.sourceAgentId && draft.text !== draft.original && (
                <p className="hist-draft-hint" role="status">
                  {draft.queueing ? t('Sharing your edits with the Agent…') : draft.queued ? t('Your next message to {agent} will include these edits. The reply draft has not been sent.', { agent: card.sourceDetail || t('the Agent') }) : t('Your edits will be shared with {agent} with your next message to them.', { agent: card.sourceDetail || t('the Agent') })}
                  {draft.queued && <button className="pill-btn" disabled={draft.queueing} onClick={discardQueuedEdits}>{t('Discard queued edits')}</button>}
                </p>
              )}
              {draft.remembered && <p className="hist-draft-hint" role="status">{t('Style preference saved for your drafts in this workspace. The draft was not sent.')}</p>}
              {draft.rememberError && <p className="hist-draft-error">{draft.rememberError}</p>}
              {draft.queueError && <p className="hist-draft-error">{draft.queueError}</p>}
              {draft.sendError && <p className="hist-draft-error">{draft.sendError}</p>}
            </>
          )}
        </div>
      )}
      {card.sourceAgentId && draft?.queued && (!draft.text || draft.text === draft.original) && (
        <p className="hist-draft-hint" role="status">
          {t('Your next message to {agent} will include these edits. The reply draft has not been sent.', { agent: card.sourceDetail || t('the Agent') })}
          <button className="pill-btn" disabled={draft.queueing} onClick={discardQueuedEdits}>{t('Discard queued edits')}</button>
        </p>
      )}
    </div>
  )
}






