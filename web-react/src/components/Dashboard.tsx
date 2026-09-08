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
import { BrandMark, Icon } from './Icon'
import type { AppState, Business } from '../types/card'
import './Dashboard.css'

interface Props {
  userId: string
  orgId: string
  relayUrl: string
  sessionToken: string
  onLogout: (reason?: string) => void
}

type Panel = null | 'compose' | 'sent' | 'done' | 'more' | 'record'

/// The shell around the feed. The feed is the screen; everything else —
/// telling your AI something, what you sent, what you decided, the team —
/// is a sheet over it that closes back to the feed.
export const Dashboard: React.FC<Props> = ({ userId, orgId, relayUrl, sessionToken, onLogout }) => {
  const [state, setState] = useState<AppState>({ cardsById: {} })
  const [isConnected, setIsConnected] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [displayName, setDisplayName] = useState(userId.replace(/^(u:|email:)/, '').split('@')[0])
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
    wsClient.onStateChange = (newState) => { if (!ignore) { setState(newState); setHasLoaded(true) } }
    wsClient.onAccessDenied = (message) => { if (!ignore) onLogout(message) }
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

  useEffect(() => {
    const request = new AbortController()
    fetch(`${relayHttpUrl}/me`, { headers: { 'x-session-token': sessionToken }, signal: request.signal })
      .then(async (response) => { if (!response.ok) return; const profile = await response.json(); if (!request.signal.aborted && profile.name) setDisplayName(profile.name) })
      .catch(() => {})
    return () => request.abort()
  }, [relayHttpUrl, sessionToken])

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
      else if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !panel && !(e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) setPanel('compose')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])

  // Sheets behave as modal dialogs for keyboard and assistive technology.
  useEffect(() => {
    if (!panel) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('tabindex', '-1')
    const background = document.querySelectorAll<HTMLElement>('[data-workspace]')
    background.forEach((el) => el.setAttribute('inert', ''))
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')).filter((el) => el.getClientRects().length > 0)
    if (!dialog.contains(document.activeElement)) (controls()[0] || dialog).focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0], last = items[items.length - 1]
      if (!first) { event.preventDefault(); dialog.focus() }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); background.forEach((el) => el.removeAttribute('inert')); if (previous?.isConnected) previous.focus() }
  }, [panel])

  const handleDecision = useCallback((cardId: string, action: string, options?: any) => {
    const sent = wsClientRef.current!.sendDecision(cardId, action, options)
    if (!sent) setError('You are offline. Reconnect before saving a decision.')
    else addDebugLog(`Sent decision: ${cardId} → ${action}`)
    return sent
  }, [addDebugLog])
  const handleRollback = useCallback((cardId: string) => {
    if (!wsClientRef.current!.sendRollback(cardId)) setError('You are offline. Reconnect before undoing a decision.')
    else addDebugLog(`Undo requested: ${cardId}`)
  }, [addDebugLog])
  const handleNudge = useCallback((cardId: string) => {
    if (!wsClientRef.current!.sendNudge(cardId)) setError('You are offline. Reconnect before sending a reminder.')
    else addDebugLog(`Nudge requested: ${cardId}`)
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
      <aside className="workspace-sidebar" data-workspace aria-label="Workspace">
        <a className="wordmark" href="/" aria-label="Honmaru home"><BrandMark /><span>Honmaru<span className="wordmark-ai">AI</span></span></a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="workspace-nav" aria-label="Main navigation">
          <button className={panel === null ? 'selected' : ''} onClick={() => setPanel(null)}><Icon name="inbox" />Inbox<span className="nav-count">{pendingCards.length}</span></button>
          <button className={panel === 'sent' ? 'selected' : ''} onClick={() => setPanel('sent')}><Icon name="send" />Sent<span className="nav-count">{sentCards.filter((card) => card.status === 'pending').length}</span></button>
          <button className={panel === 'done' ? 'selected' : ''} onClick={() => setPanel('done')}><Icon name="check" />Done</button>
          <button className={panel === 'record' ? 'selected' : ''} onClick={() => setPanel('record')}><Icon name="clock" />Decision record</button>
        </nav>
        <div className="sidebar-note"><span className="ai-orbit"><Icon name="sparkle" size={18} /></span><strong>One decision at a time.</strong><p>A little less noise.<br />A little more progress.</p></div>
        <div className="sidebar-bottom"><span className={`connection-label ${isConnected ? 'online' : ''}`} role="status"><span className={`dot ${isConnected ? 'on' : 'off'}`} />{isConnected ? 'Live updates connected' : 'Reconnecting…'}</span><button className="account-button" onClick={() => setPanel('more')}><span className="user-avatar">{displayName.slice(0, 1).toUpperCase()}</span><span><strong>{displayName}</strong><small>Workspace settings</small></span><Icon name="settings" size={18} /></button></div>
      </aside>
      <main className="workspace-main" data-workspace>
        <header className="topbar">
          <div className="topbar-left"><span className="mobile-brand"><BrandMark /></span><span className="breadcrumb">Workspace <span>/</span></span><strong>Inbox</strong><span className="topbar-live"><span className={`dot ${isConnected ? 'on' : 'off'}`} />{isConnected ? 'Live' : 'Connecting'}</span></div>
          <nav className="topbar-right" aria-label="Workspace tools"><NotificationsButton httpBase={relayHttpUrl} sessionToken={sessionToken} /><button className="mobile-nav-button" onClick={() => setPanel('sent')}>Sent</button><button className="mobile-nav-button" onClick={() => setPanel('done')}>Done</button><button className="mobile-nav-button" onClick={() => setPanel('more')} aria-label="Workspace settings"><Icon name="settings" size={18} /></button><button className="topbar-compose" onClick={() => setPanel('compose')}><Icon name="plus" size={17} />New request</button></nav>
        </header>
        <div className="inbox-heading"><div><span className="eyebrow">MAKE SPACE FOR WHAT MATTERS</span><h1>Your decisions.</h1><p>{!hasLoaded ? 'Connecting to your workspace…' : pendingCards.length ? `${pendingCards.length} ${pendingCards.length === 1 ? 'request needs' : 'requests need'} your attention. Take them one at a time.` : 'You’re up to date. Keep the good work moving.'}</p></div><div className="inbox-summary"><span><strong>{hasLoaded ? pendingCards.length : '—'}</strong>To review</span><span><strong>{hasLoaded ? decidedCards.length : '—'}</strong>Decided</span></div></div>
        <div className="feed-toolbar"><span><Icon name="inbox" size={15} />For you <span className="toolbar-count">{pendingCards.length}</span></span><span>Priority first<Icon name="down" size={13} /></span></div>
        <Feed key={localeVersion} cards={pendingCards} userId={userId} businesses={businesses} focusCardId={focusCardId} onDecide={handleDecision} active={!panel} connected={isConnected} loaded={hasLoaded} onCompose={() => setPanel('compose')} />
        <footer className="workspace-footer"><span><Icon name="sparkle" size={13} /> Less coordination. More momentum.</span><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>N</kbd> new request</span></footer>
      </main>
      <div className="toasts">{error && <div className="toast error" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}</div>
      {panel === null && <button className="compose-fab" onClick={() => setPanel('compose')} aria-keyshortcuts="n"><Icon name="plus" size={19} />Tell your AI</button>}

      {panel && <div className="scrim" onClick={() => setPanel(null)} />}

      {panel === 'compose' && (
        <div className="sheet sheet-bottom" role="dialog" aria-label="Tell your AI">
          <div className="sheet-title">Tell your AI<button className="close" onClick={() => setPanel(null)} aria-label="Close">×</button></div>
          <p className="sheet-hint">Who it is for, what they decide, and by when. Your AI writes the card and routes it.</p>
          <CreateDecision
            relayHttpUrl={relayHttpUrl}
            orgId={orgId}
            userId={userId}
            userName={displayName}
            sessionToken={sessionToken}
            autoFocus
            connected={isConnected}
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
              {card.status === 'pending' && <button className="nudge-button" disabled={!isConnected} onClick={() => handleNudge(card.id)}>Nudge</button>}
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
              disabled={!isConnected}
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
          onLogout={() => onLogout()}
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
