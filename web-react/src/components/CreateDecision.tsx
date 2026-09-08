import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { readResponse } from '../utils/api'

interface Props {
  relayHttpUrl: string
  orgId: string
  userId: string
  userName: string
  sessionToken: string
  onSendCard: (card: any) => Promise<void>
  connected: boolean
  onLog: (message: string) => void
  // Called once the card is on its way, so a sheet can close.
  onDone?: () => void
  autoFocus?: boolean
}

export const CreateDecision: React.FC<Props> = ({ relayHttpUrl, orgId, userId, userName, sessionToken, onSendCard, onLog, onDone, autoFocus, connected }) => {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => { epoch.current += 1; return () => { epoch.current += 1; request.current?.abort() } }, [relayHttpUrl, orgId, userId, sessionToken])
  const draft = useRef<{ text: string; card: Record<string, any> } | null>(null)

  const handleCreate = async () => {
    if (!text.trim() || busy || !connected) return
    const generation = epoch.current
    request.current = new AbortController()
    setBusy(true)
    setError(null)
    try {
      let card = draft.current?.text === text.trim() ? draft.current.card : null
      if (!card) {
      const res = await fetch(`${relayHttpUrl}/ai/route`, {
        method: 'POST',
        signal: request.current.signal,
        headers: {
          'content-type': 'application/json',
          'x-session-token': sessionToken,
        },
        body: JSON.stringify({
          text: text.trim(),
          sender: { name: userName, id: userId, role: 'member' },
                  organization: {
            orgId,
            // The router reads members from `nodes` (kind: "person"). Sending
            // the real org member here makes it route to a real user instead of
            // falling back to a demo identity like user-toru.
            nodes: [
              { id: userId, kind: 'person', label: `${userName} · member` },
            ],
          },
        }),
      })
      const routed = await readResponse(res)
      if (epoch.current !== generation) return
      if (!routed.recipientUserID) throw new Error('A recipient could not be found. Include a teammate’s name and try again.')

      card = {
        id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: routed.cardType || 'notification',
        status: 'pending',
        recipientUserID: routed.recipientUserID,
        title: routed.title || 'Decision needed',
        summary: routed.summary || '',
        context: routed.context || '',
        priority: routed.priority || 'medium',
        routingReason: routed.routingReason || '',
        agentRoute: routed.agentRoute || '',
        createdAt: new Date().toISOString(),
        sourceInstruction: text.trim(),
        // The business the AI filed this under. Absent, the relay files it
        // in the background; nobody picks one by hand.
        ...(routed.business ? { business: routed.business } : {}),
      }

      draft.current = { text: text.trim(), card }
      }
      if (epoch.current !== generation) return
      await onSendCard(card)
      if (epoch.current !== generation) return
      draft.current = null
      onLog(`Created decision: ${card.title} → ${card.recipientUserID}`)
      setText('')
      onDone?.()
    } catch (err) {
      if (epoch.current !== generation) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (epoch.current === generation) setBusy(false)
    }
  }

  return (
    <form className="create-decision" onSubmit={(event) => { event.preventDefault(); handleCreate() }}>
      <label htmlFor="new-request">What needs to happen?</label>
      <textarea id="new-request" value={text} autoFocus={autoFocus} onChange={(event) => setText(event.target.value)} placeholder="Ask Yuki to approve the spring menu by Friday. The updated proposal is ready for review…" disabled={busy} maxLength={10000} rows={5} />
      {!connected && <p className="compose-status" role="status">You’re offline. Your draft will stay here while we reconnect.</p>}
      {error && <div className="create-error" role="alert">{error}</div>}
      <button type="submit" disabled={busy || !text.trim() || !connected}>{busy ? 'Sending request…' : 'Send request'}{!busy && <Icon name="arrow" size={16} />}</button>
    </form>
  )
}
