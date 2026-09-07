import React, { useState, useEffect, useCallback, useRef } from 'react'
import { WebSocketClient } from '../services/WebSocketClient'
import { Feed } from './Feed'
import { DecisionCard } from './DecisionCard'
import { CreateDecision } from './CreateDecision'
import { YouSheet } from './YouSheet'
import { RecordSheet } from './RecordSheet'
import { NotificationsButton } from './NotificationsBanner'
import { notifyNewDecision, setTabBadge } from '../utils/notifications'
import { syncLocale } from '../utils/push'
import type { AppState, Business } from '../types/card'
import './Dashboard.css'

interface Props {
  userId: string
  orgId: string
  relayUrl: string
  sessionToken: string
  onLogout: () => void
}

type Panel = null | 'compose' | 'sent' | 'done' | 'more' | 'record'

/// The shell around the feed. The feed is the screen; everything else —
/// telling your AI something, what you sent, what you decided, the team —
/// is a sheet over it that closes back to the feed.
export const Dashboard: React.FC<Props> = ({ userId, orgId, relayUrl, sessionToken, onLogout }) => {
  const [state, setState] = useState<AppState>({ cardsById: {} })
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [debugLog, setDebugLog] = useState<Array<{ timestamp: string; message: string }>>([])
  const showDebug = import.meta.env.VITE_DEBUG === 'true' || (typeof location !== 'undefined' && location.search.includes('debug'))
  // Bumped when the language changes, so cards re-read their localized text.
  const [localeVersion, setLocaleVersion] = useState(0)
  // The card a notification tap (or a ?card= link) asked for.
  const [focusCardId, setFocusCardId] = useState<string | null>(() => {
    try { return new URL(window.location.href).searchParams.get('card') } catch { return null }
  })

  const wsClientRef = useRef<WebSocketClient | null>(null)
  if (wsClientRef.current === null) wsClientRef.current = new WebSocketClient()

  const addDebugLog = useCallback((message: string) => {
    setDebugLog((logs) => [...logs.slice(-199), { timestamp: new Date().toLocaleTimeString(), message }])
  }, [])

  const relayHttpUrl = relayUrl.replace(/^ws/, 'http')

  useEffect(() => {
    const cards = Object.values(state.cardsById || {})
    const pending = cards.filter((c) => c.status === 'pending' && c.recipientUserID === userId)
    setTabBadge(pending.length)
    return () => setTabBadge(0)
  }, [state, userId])

  useEffect(() => {
    const wsClient = wsClientRef.current!
    let ignore = false
    wsClient.onStateChange = (newState) => { if (!ignore) setState(newState) }
    wsClient.onCardCreated = (card) => {
      if (ignore) return
      addDebugLog(`Card created: ${card.id}`)
      if (card.recipientUserID === userId && card.status === 'pending') {
        notifyNewDecision(card.title || 'A decision is waiting', card.senderUserID || 'a teammate')
      }
    }
    wsClient.onCardUpdated = (card) => { if (!ignore) addDebugLog(`Card updated: ${card.id}`) }
    wsClient.onCardDeleted = (cardId) => { if (!ignore) addDebugLog(`Card deleted: ${cardId}`) }
    wsClient.onPresence = (who, status) => { if (!ignore) addDebugLog(`Presence: ${who} → ${status}`) }
    wsClient.onError = (message) => { if (!ignore) { setError(message); addDebugLog(`Error: ${message}`) } }
    wsClient.onToolCallResult = (toolCallId) => { if (!ignore) addDebugLog(`Tool result: ${toolCallId}`) }
    wsClient.onConnectionChange = (connected) => {
      if (ignore) return
      setIsConnected(connected)
      if (connected) setError(null)
      addDebugLog(connected ? `Connected to ${relayUrl}` : 'Disconnected — will retry')
    }
    wsClient.connect(relayUrl, userId, orgId, sessionToken).catch((err) => {
      if (ignore) return
      const message = err instanceof Error ? err.message : String(err)
      setError(`Failed to connect: ${message}`)
    })
    return () => { ignore = true; wsClient.disconnect() }
  }, [relayUrl, userId, orgId, sessionToken, addDebugLog])

  // A notification tapped while a tab is open: the service worker tells us
  // which card, rather than opening a second tab.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'open-card' && event.data.cardId) { setPanel(null); setFocusCardId(event.data.cardId) }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  // What language this browser reads, so every notification arrives in it.
  useEffect(() => { syncLocale(relayHttpUrl, sessionToken) }, [relayHttpUrl, sessionToken])

  // The org's businesses, for turning a slug on a card into its name. Nobody
  // picks one; the AI files every card in the background.
  const loadBusinesses = useCallback(async () => {
    try {
      const res = await fetch(`${relayHttpUrl}/businesses?orgId=${encodeURIComponent(orgId)}`, {
        headers: { 'x-session-token': sessionToken },
      })
      if (res.ok) setBusinesses((await res.json()).businesses || [])
    } catch { /* a label is a convenience */ }
  }, [relayHttpUrl, orgId, sessionToken])
  useEffect(() => { loadBusinesses() }, [loadBusinesses])
  useEffect(() => {
    const known = new Set(businesses.map((b) => b.slug))
    if (Object.values(state.cardsById || {}).some((c) => c.business && !known.has(c.business))) loadBusinesses()
  }, [state, businesses, loadBusinesses])

  // Escape closes whatever is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel(null)
      else if (e.key === 'n' && !panel && !(e.target as HTMLElement)?.matches('input, textarea')) setPanel('compose')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])

  const handleDecision = useCallback((cardId: string, action: string, options?: any) => {
    wsClientRef.current!.sendDecision(cardId, action, options)
    addDebugLog(`Sent decision: ${cardId} → ${action}`)
  }, [addDebugLog])
  const handleRollback = useCallback((cardId: string) => {
    wsClientRef.current!.sendRollback(cardId)
    addDebugLog(`Rolled back: ${cardId}`)
  }, [addDebugLog])
  const handleNudge = useCallback((cardId: string) => {
    wsClientRef.current!.sendNudge(cardId)
    addDebugLog(`Nudged: ${cardId}`)
  }, [addDebugLog])

  const cards = Object.values(state.cardsById || {})
  const byUrgency = { urgent: 0, high: 1, medium: 2, low: 3 } as Record<string, number>
  // What is waiting on me, most urgent first, then oldest first: the order
  // the AI would read them to you.
  const pendingCards = cards
    .filter((c) => c.status === 'pending' && c.recipientUserID === userId)
    .sort((a, b) => (byUrgency[a.priority] ?? 2) - (byUrgency[b.priority] ?? 2) || a.createdAt.localeCompare(b.createdAt))
  const decidedCards = cards
    .filter((c) => c.recipientUserID === userId && (c.status !== 'pending' || c.decision))
    .sort((a, b) => (b.decision?.decidedAt || b.createdAt).localeCompare(a.decision?.decidedAt || a.createdAt))
  const sentCards = cards
    .filter((c) => c.senderUserID === userId && c.recipientUserID !== userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const nameOf = (slug?: string) => businesses.find((b) => b.slug === slug)?.name

  return (
    <div className="shell">
      <Feed key={localeVersion} cards={pendingCards} userId={userId} businesses={businesses} focusCardId={focusCardId} onDecide={handleDecision} />

      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">Honmaru</span>
          <span className={`dot ${isConnected ? 'on' : 'off'}`} title={isConnected ? 'Connected' : 'Reconnecting…'} />
          {pendingCards.length > 0 && <span className="pending-count">{pendingCards.length}</span>}
        </div>
        <nav className="topbar-right">
          <NotificationsButton httpBase={relayHttpUrl} sessionToken={sessionToken} />
          <button className={panel === 'sent' ? 'active' : ''} onClick={() => setPanel(panel === 'sent' ? null : 'sent')}>
            Sent{sentCards.filter((c) => c.status === 'pending').length > 0 && <span className="mini">{sentCards.filter((c) => c.status === 'pending').length}</span>}
          </button>
          <button className={panel === 'done' ? 'active' : ''} onClick={() => setPanel(panel === 'done' ? null : 'done')}>Done</button>
          <button className={panel === 'more' ? 'active' : ''} onClick={() => setPanel(panel === 'more' ? null : 'more')} aria-label="More">⋯</button>
        </nav>
      </header>

      <div className="toasts">
        {error && <div className="toast error" onClick={() => setError(null)}>{error}</div>}
      </div>

      {panel === null && (
        <button className="compose-fab" onClick={() => setPanel('compose')} aria-keyshortcuts="n">
          <span className="ai-mark" />Tell your AI
        </button>
      )}

      {panel && <div className="scrim" onClick={() => setPanel(null)} />}

      {panel === 'compose' && (
        <div className="sheet sheet-bottom" role="dialog" aria-label="Tell your AI">
          <div className="sheet-title">Tell your AI</div>
          <p className="sheet-hint">Who it is for, what they decide, and by when. Your AI writes the card and routes it.</p>
          <CreateDecision
            relayHttpUrl={relayHttpUrl}
            orgId={orgId}
            userId={userId}
            sessionToken={sessionToken}
            autoFocus
            onSendCard={(card) => wsClientRef.current!.sendCardCreated(card)}
            onLog={addDebugLog}
            onDone={() => setPanel(null)}
          />
        </div>
      )}

      {panel === 'sent' && (
        <aside className="sheet sheet-side" role="dialog" aria-label="Sent by you">
          <div className="sheet-title">Sent by you <button className="close" onClick={() => setPanel(null)} aria-label="Close">×</button></div>
          {sentCards.length === 0 && <p className="sheet-empty">Nothing sent yet. Tell your AI something.</p>}
          {sentCards.map((card) => (
            <div key={card.id} className="sent-card">
              <div className="sent-card-head">
                <strong>{card.title}</strong>
                <span className={`sent-status ${card.status === 'pending' ? 'waiting' : 'done'}`}>
                  {card.status === 'pending'
                    ? `Waiting on ${card.recipientUserID.replace(/^(u:|email:)/, '').split('@')[0]}`
                    : (card.decision?.action || 'decided')}
                </span>
              </div>
              {card.business && <span className="business-tag">{nameOf(card.business) || card.business}</span>}
              <p className="sent-summary">{card.summary}</p>
              {card.decision?.replyText && <p className="sent-reply">“{card.decision.replyText}”</p>}
              {card.status === 'pending' && <button className="nudge-button" onClick={() => handleNudge(card.id)}>Nudge</button>}
            </div>
          ))}
        </aside>
      )}

      {panel === 'done' && (
        <aside className="sheet sheet-side" role="dialog" aria-label="Decided">
          <div className="sheet-title">Decided <button className="close" onClick={() => setPanel(null)} aria-label="Close">×</button></div>
          {decidedCards.length === 0 && <p className="sheet-empty">No decisions yet.</p>}
          {decidedCards.map((card) => (
            <DecisionCard
              key={card.id}
              card={card}
              currentUserId={userId}
              businessName={nameOf(card.business)}
              onApprove={() => {}} onDecline={() => {}} onChoose={() => {}} onReply={() => {}}
              onAcknowledge={() => {}} onDelegate={() => {}}
              onRollback={() => handleRollback(card.id)}
              isPending={false}
            />
          ))}
        </aside>
      )}

      {panel === 'more' && (
        <YouSheet
          httpBase={relayHttpUrl}
          orgId={orgId}
          userId={userId}
          sessionToken={sessionToken}
          businesses={businesses}
          onOpenRecord={() => setPanel('record')}
          onLogout={onLogout}
          onClose={() => setPanel(null)}
          onLocaleChange={() => setLocaleVersion((v) => v + 1)}
        />
      )}

      {panel === 'record' && (
        <RecordSheet httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={() => setPanel(null)} />
      )}

      {showDebug && (
        <div className="debug-log">
          <h3>Event log</h3>
          <div className="log-entries">
            {debugLog.map((entry, i) => (
              <div key={i} className="log-entry"><span className="log-time">{entry.timestamp}</span><span className="log-message">{entry.message}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
