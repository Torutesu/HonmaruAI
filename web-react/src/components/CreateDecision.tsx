import React, { useEffect, useRef, useState } from 'react'
import { properName } from '../utils/names'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'

interface Props {
  relayHttpUrl: string
  orgId: string
  userId: string
  sessionToken: string
  onSendCard: (card: any) => void
  onLog: (message: string) => void
  // Called once the card is on its way, so a sheet can close.
  onDone?: () => void
  autoFocus?: boolean
}

export const CreateDecision: React.FC<Props> = ({ relayHttpUrl, orgId, userId, sessionToken, onSendCard, onLog, onDone, autoFocus }) => {
  const t = useT()
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)

  // Grow to fit what is in it, up to a point, so a long instruction is
  // readable without becoming a page of its own.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [text])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${relayHttpUrl}/ai/route`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': sessionToken,
        },
        body: JSON.stringify({
          text: text.trim(),
          // No name: the Worker knows this person's from the session and the
          // membership row, and a name derived here from the account id is
          // exactly what put "E2e-1788842127274" on a card.
          sender: { id: userId, role: 'member' },
          // The Worker writes its own words on a card — the title, the routing
          // line — and without this it writes them in English.
          readerLanguage: getLocale(),
          organization: {
            orgId,
            // The router reads members from `nodes` (kind: "person"). Sending
            // the real org member here makes it route to a real user instead of
            // falling back to a demo identity like user-toru.
            nodes: [
              { id: userId, kind: 'person', label: `${properName(userId)} · member` },
            ],
          },
        }),
      })
      const routed = await res.json()
      if (!res.ok) {
        setError(routed.message || t('Routing failed'))
        return
      }

      const card = {
        id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: routed.cardType || 'notification',
        status: 'pending',
        recipientUserID: routed.recipientUserID,
        title: routed.title || t('Decision needed'),
        summary: routed.summary || '',
        context: routed.context || '',
        priority: routed.priority || 'medium',
        routingReason: routed.routingReason || '',
        agentRoute: routed.agentRoute || '',
        createdAt: new Date().toISOString(),
        // The business the AI filed this under. Absent, the relay files it
        // in the background; nobody picks one by hand.
        ...(routed.business ? { business: routed.business } : {}),
      }

      onSendCard(card)
      onLog(`Created decision: ${card.title} → ${card.recipientUserID}`)
      setText('')
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="create-decision">
      {/* A sentence, not a search box. On one line anything longer than the
          field scrolled out of sight, so you could not read what you were
          about to send — which is the whole interaction. Enter still sends;
          shift-Enter is a new line. */}
      <textarea
        ref={box}
        value={text}
        rows={1}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('Tell your AI — e.g. ask Yuki to approve the spring menu by Friday')}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreate() }
        }}
      />
      <button onClick={handleCreate} disabled={busy || !text.trim()}>
        {busy ? t('Routing…') : t('Send')}
      </button>
      {error && <div className="create-error">{error}</div>}
    </div>
  )
}