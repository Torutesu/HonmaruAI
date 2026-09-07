import React, { useState } from 'react'
import type { Business } from '../types/card'

interface Props {
  relayHttpUrl: string
  orgId: string
  userId: string
  sessionToken: string
  onSendCard: (card: any) => void
  onLog: (message: string) => void
  businesses?: Business[]
  // The chip the feed is filtered to, which is what a new decision is most
  // likely about. Empty means let the AI decide from the instruction.
  defaultBusiness?: string | null
}

export const CreateDecision: React.FC<Props> = ({ relayHttpUrl, orgId, userId, sessionToken, onSendCard, onLog, businesses = [], defaultBusiness = null }) => {
  const [text, setText] = useState('')
  const [business, setBusiness] = useState<string>('')
  const [lastDefault, setLastDefault] = useState<string | null>(null)
  if (defaultBusiness !== lastDefault) {
    setLastDefault(defaultBusiness)
    setBusiness(defaultBusiness || '')
  }
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
          sender: { name: userId, id: userId, role: 'member' },
                  organization: {
            orgId,
            // The router reads members from `nodes` (kind: "person"). Sending
            // the real org member here makes it route to a real user instead of
            // falling back to a demo identity like user-toru.
            nodes: [
              { id: userId, kind: 'person', label: `${userId} · member` },
            ],
          },
        }),
      })
      const routed = await res.json()
      if (!res.ok) {
        setError(routed.message || 'Routing failed')
        return
      }

      const card = {
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
        // Yours if you picked one; the AI's when the instruction made it
        // clear; nothing otherwise — it can be filed later from the card.
        ...(business || routed.business ? { business: business || routed.business } : {}),
      }

      onSendCard(card)
      onLog(`Created decision: ${card.title} → ${card.recipientUserID}`)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="create-decision">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. ask devuser to review the deploy before Friday"
        disabled={busy}
        onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
      />
      <select
        value={business}
        aria-label="Business"
        disabled={busy}
        onChange={(e) => setBusiness(e.target.value)}
        className="create-business"
      >
        <option value="">Business: auto</option>
        {businesses.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
      </select>
      <button onClick={handleCreate} disabled={busy || !text.trim()}>
        {busy ? 'Creating…' : 'Create decision'}
      </button>
      {error && <div className="create-error">{error}</div>}
    </div>
  )
}