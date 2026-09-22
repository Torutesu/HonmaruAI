import React, { useState, useEffect, useCallback, useRef } from 'react'
import { WebSocketClient } from '../services/WebSocketClient'
import { Feed } from './Feed'
import { ClassicList } from './ClassicList'
import { Inbox } from './Inbox'
import { Palette } from './Palette'
import type { PaletteAction } from './Palette'
import { Icon } from './Icon'
import { CreateDecision } from './CreateDecision'
import { RecordSheet } from './RecordSheet'
import { Team } from '../screens/Team'
import { Tools } from '../screens/Tools'
import { History } from '../screens/History'
import { NotificationSettings } from '../screens/NotificationSettings'
import { Plans } from '../screens/Plans'
import { Profile } from '../screens/Profile'
import { Insights } from '../screens/Insights'
import type { FlagReason, Answer } from './Feed'
import { NotificationsButton } from './NotificationsBanner'
import { notifyNewDecision, setTabBadge } from '../utils/notifications'
import { syncLocale } from '../utils/push'
import type { AppState, Business, DecisionCard } from '../types/card'
import './Dashboard.css'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
import { useRoute, useDesktop, hashForCard, hashForMode, hashForScreen } from '../utils/route'
import { loadCardCache, saveCardCache } from '../utils/cardCache'
import type { Screen, Mode } from '../utils/route'

interface Props {
  userId: string
  orgId: string
  relayUrl: string
  sessionToken: string
  onLogout: () => void
  onSwitchOrg: (orgId: string) => void
  /// This account is no longer in the workspace on screen. The shell finds
  /// them another one.
  onLeft: () => void
}

type Panel = null | 'compose' | 'record'
// A full screen over the feed, as opposed to a sheet. These are the design's
// own screens — Tools, History, Notifications, Plan, You — and each one owns
// the viewport while it is open. Which one is open, and which card the feed
// is on, live in the URL (utils/route.ts): a reload, the back button and a
// pasted link all mean what they say.

// What just happened, said back. English keys, translated where read.
const DECIDED_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', reply: 'Replied', revise: 'Revision asked',
  choose: 'Chose', acknowledge: 'Acknowledged', delegate: 'Delegated', later: 'Deferred',
}

/// The shell around the feed. The feed is the screen; everything else —
/// telling your AI something, what you sent, what you decided, the team —
/// is a sheet over it that closes back to the feed.
export const Dashboard: React.FC<Props> = ({ userId, orgId, relayUrl, sessionToken, onLogout, onSwitchOrg, onLeft }) => {
  const t = useT()
  // The last snapshot this browser saw, until the relay sends a new one —
  // and instead of nothing when it cannot.
  const [state, setState] = useState<AppState>(() => ({ cardsById: loadCardCache(orgId) }))
  const [isConnected, setIsConnected] = useState(false)
  // The relay has sent its snapshot at least once. Before that the feed says
  // it is opening, not that it is empty — "All clear" on a cold start, half a
  // second before three cards arrive, is a lie told to exactly the person who
  // opened the app to see what is waiting.
  const [synced, setSynced] = useState(false)
  // Messages this browser could not deliver yet — a decision made while the
  // relay was unreachable. Shown, so the person knows it is on its way.
  const [unsent, setUnsent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // The decision just made, for six seconds: long enough to take it back. A
  // swipe is fast and a card leaves the screen the moment it is decided, so
  // without this a slip of the thumb is an approval nobody meant.
  const [undo, setUndo] = useState<{ cardId: string; action: string; title: string } | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  // ⌘K: one box that goes anywhere and finds anything.
  const [palette, setPalette] = useState(false)
  const { route, navigate } = useRoute()
  const desktop = useDesktop()
  const screen: Screen | null = route.screen
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [debugLog, setDebugLog] = useState<Array<{ timestamp: string; message: string }>>([])
  const showDebug = import.meta.env.VITE_DEBUG === 'true' || (typeof location !== 'undefined' && location.search.includes('debug'))
  // Bumped when the language changes, so cards re-read their localized text.
  const [localeVersion, setLocaleVersion] = useState(0)
  // Cards is one decision per screen; Classic is the same decisions as a list
  // you can scan. Remembered, because it is a way of working, not a detour.
  const storedMode: Mode = (() => {
    try { return localStorage.getItem('mode') === 'classic' ? 'classic' : 'cards' } catch { return 'cards' }
  })()
  const mode: Mode = route.mode ?? storedMode
  const switchMode = (next: Mode) => {
    try { localStorage.setItem('mode', next) } catch {}
    navigate(hashForMode(next))
  }
  const setScreen = useCallback((next: Screen | null) => {
    navigate(next ? hashForScreen(next) : hashForMode(mode))
  }, [navigate, mode])
  // The card the URL names — from a notification tap, a pasted link, or a
  // row picked in the inbox.
  const focusCardId = route.cardId
  // A `?card=` link from before the hash routes: turned into one, once.
  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      const legacy = url.searchParams.get('card')
      if (!legacy) return
      url.searchParams.delete('card')
      history.replaceState(null, '', url.pathname + url.search + hashForCard(legacy))
      navigate(hashForCard(legacy), true)
    } catch { /* nothing to translate */ }
  }, [navigate])

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
    if (synced) saveCardCache(orgId, state.cardsById || {})
  }, [state, synced, orgId])

  useEffect(() => {
    const wsClient = wsClientRef.current!
    let ignore = false
    wsClient.onStateChange = (newState) => { if (!ignore) setState(newState) }
    wsClient.onSynced = () => { if (!ignore) setSynced(true) }
    wsClient.onOutboxChange = (n) => { if (!ignore) setUnsent(n) }
    wsClient.onCardCreated = (card) => {
      if (ignore) return
      addDebugLog(`Card created: ${card.id}`)
      if (card.recipientUserID === userId && card.status === 'pending') {
        notifyNewDecision(card.localized?.[getLocale()]?.title || card.title || t('A decision is waiting'), card.requestedBy?.name || displayName(card.senderUserID) || t('a teammate'))
      }
    }
    wsClient.onCardUpdated = (card) => { if (!ignore) addDebugLog(`Card updated: ${card.id}`) }
    wsClient.onCardDeleted = (cardId) => { if (!ignore) addDebugLog(`Card deleted: ${cardId}`) }
    wsClient.onPresence = (who, status) => { if (!ignore) addDebugLog(`Presence: ${who} → ${status}`) }
    wsClient.onError = (message) => { if (!ignore) { setError(message); addDebugLog(`Error: ${message}`) } }
    // The relay will not have this socket, and will not have the next one
    // either. Retrying is not the answer to any of these — where the answer is
    // "you belong somewhere else now", go there; otherwise say so and stop.
    wsClient.onRefused = (message, code) => {
      if (ignore) return
      setError(message)
      addDebugLog(`Refused: ${code || 'no code'} — ${message}`)
      if (code === 'not-a-member' || code === 'sign-in-required') onLeft()
    }
    wsClient.onToolCallResult = (toolCallId) => { if (!ignore) addDebugLog(`Tool result: ${toolCallId}`) }
    wsClient.onConnectionChange = (connected) => {
      if (ignore) return
      setIsConnected(connected)
      if (connected) setError(null)
      addDebugLog(connected ? `Connected to ${relayUrl}` : 'Disconnected — will retry')
    }
    setSynced(false)
    wsClient.connect(relayUrl, userId, orgId, sessionToken).catch((err) => {
      if (ignore) return
      // A socket that fails hands back an Event, not an Error, and "[object
      // Event]" tells nobody anything. Offline is the usual reason, and has
      // its own sentence.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      const message = err instanceof Error ? err.message : ''
      setError(offline
        ? t('You are offline. What you decide will be sent when you are back.')
        : (message ? t('Could not connect: {why}', { why: message }) : t('Could not connect. Retrying.')))
    })
    return () => { ignore = true; wsClient.disconnect() }
  }, [relayUrl, userId, orgId, sessionToken, addDebugLog, onLeft])

  // A notification tapped while a tab is open: the service worker tells us
  // which card, rather than opening a second tab.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'open-card' && event.data.cardId) { setPanel(null); navigate(hashForCard(event.data.cardId)) }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [navigate])

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
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPalette((p) => !p); return }
      if (palette) return
      if (e.key === 'Escape') { setPanel(null); if (screen) setScreen(null) }
      else if (e.key === 'n' && !panel && !screen && !(e.target as HTMLElement)?.matches('input, textarea')) setPanel('compose')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, screen, setScreen, palette])
  const pickFromPalette = useCallback((action: PaletteAction) => {
    setPalette(false)
    setPanel(null)
    if (action.kind === 'card') { try { localStorage.setItem('mode', 'cards') } catch {}; navigate(hashForCard(action.cardId)) }
    else if (action.kind === 'screen') navigate(hashForScreen(action.screen))
    else if (action.kind === 'feed') { try { localStorage.setItem('mode', 'cards') } catch {}; navigate(hashForMode('cards')) }
    else if (action.kind === 'list') { try { localStorage.setItem('mode', 'classic') } catch {}; navigate(hashForMode('classic')) }
    else if (action.kind === 'compose') { navigate(hashForMode('cards')); setPanel('compose') }
  }, [navigate])

  // A toast that stays until clicked is a banner. Errors clear themselves.
  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => setError(null), 8000)
    return () => clearTimeout(id)
  }, [error])
  useEffect(() => {
    if (!undo) return
    const id = setTimeout(() => setUndo(null), 6000)
    return () => clearTimeout(id)
  }, [undo])

  /// "Ask anything" on a card: a question, answered from the card and what
  /// the team decided before — not routed to somebody as a new card. The
  /// answer lands under the card; nothing is created.
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const handleAsk = useCallback(async (text: string, card: DecisionCard) => {
    setAnswers((prev) => ({ ...prev, [card.id]: { question: text, answer: null, related: [], busy: true } }))
    try {
      const res = await fetch(`${relayHttpUrl}/ai/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, cardId: card.id, question: text, readerLanguage: getLocale() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const why = res.status === 503
          ? t('Your AI has no model to answer with on this deployment.')
          : res.status === 429
            ? t("You have used today's AI answers.")
            : (data.message || t('Your AI could not answer that just now.'))
        setAnswers((prev) => ({ ...prev, [card.id]: { question: text, answer: null, related: [], busy: false, error: why } }))
        return
      }
      setAnswers((prev) => ({ ...prev, [card.id]: { question: text, answer: data.answer, related: data.related || [], busy: false } }))
      addDebugLog(`Asked about ${card.id}`)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      setAnswers((prev) => ({ ...prev, [card.id]: { question: text, answer: null, related: [], busy: false, error: why } }))
    }
  }, [relayHttpUrl, orgId, sessionToken, addDebugLog, t])

  const handleDecision = useCallback((cardId: string, action: string, options?: any) => {
    wsClientRef.current!.sendDecision(cardId, action, options)
    addDebugLog(`Sent decision: ${cardId} → ${action}`)
    const card = wsClientRef.current!.getCard(cardId)
    const title = card?.localized?.[getLocale()]?.title || card?.title || ''
    setUndo({ cardId, action, title })
  }, [addDebugLog])
  const handleRollback = useCallback((cardId: string) => {
    wsClientRef.current!.sendRollback(cardId)
    addDebugLog(`Rolled back: ${cardId}`)
    setUndo(null)
  }, [addDebugLog])
  /// A verdict on a card. Sent straight to the Worker — it is a row, not a
  /// relay event — and answered with one line so the person knows it landed.
  const handleFlag = useCallback(async (cardId: string, reason: FlagReason) => {
    try {
      const res = await fetch(`${relayHttpUrl}/cards/${encodeURIComponent(cardId)}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, verdict: 'wrong', reason }),
      })
      if (!res.ok) setError((await res.json().catch(() => ({}))).message || t('That did not save.'))
      addDebugLog(`Flagged ${cardId}: ${reason}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [relayHttpUrl, orgId, sessionToken, addDebugLog, t])
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

  // The laptop workbench: the inbox on the left, one card on the right. The
  // URL names the card; with none named, the first thing waiting.
  const workbench = desktop && mode === 'cards'
  const inboxCards = [...pendingCards, ...decidedCards]
  const selectedId = focusCardId && inboxCards.some((c) => c.id === focusCardId)
    ? focusCardId
    : (pendingCards[0]?.id ?? null)
  const selected = selectedId ? inboxCards.find((c) => c.id === selectedId) ?? null : null
  useEffect(() => {
    if (!workbench || panel || screen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && target.closest('input, textarea, select, [contenteditable]')) return
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const i = inboxCards.findIndex((c) => c.id === selectedId)
      const next = inboxCards[i + ((e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1)]
      if (next) { e.preventDefault(); navigate(hashForCard(next.id)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workbench, panel, screen, inboxCards, selectedId, navigate])
  const api = { httpBase: relayHttpUrl, orgId, sessionToken }

  return (
    // `screen-open` is what lets the rail stay on a laptop while a screen is
    // open: on a phone a screen owns the viewport and the tab bar goes away,
    // on a laptop navigation is a place on the page and disappearing would be
    // the app losing its own chrome.
    <div className={`shell${screen ? ' screen-open' : ''}`}>
      {workbench ? (
        <div className="workbench">
          <Inbox
            key={`inbox-${localeVersion}`}
            pending={pendingCards}
            decided={decidedCards}
            businesses={businesses}
            selectedId={selectedId}
            onSelect={(id) => navigate(hashForCard(id))}
          />
          <Feed
            key={localeVersion}
            cards={selected ? [selected] : []}
            userId={userId}
            businesses={businesses}
            focusCardId={null}
            ready={synced || cards.length > 0}
            active={!panel && !screen}
            onDecide={handleDecision}
            onAsk={handleAsk}
            onFlag={handleFlag}
            answers={answers}
            onUndo={handleRollback}
            api={api}
            layout="desk"
          />
        </div>
      ) : mode === 'cards' ? (
        <Feed
          key={localeVersion}
          cards={pendingCards}
          userId={userId}
          businesses={businesses}
          focusCardId={focusCardId}
          ready={synced || cards.length > 0}
          active={!panel && !screen}
          onDecide={handleDecision}
          onAsk={handleAsk}
          onFlag={handleFlag}
          answers={answers}
          onUndo={handleRollback}
          api={api}
          layout="phone"
        />
      ) : (
        <ClassicList
          key={localeVersion}
          pending={pendingCards}
          sent={sentCards}
          decided={decidedCards}
          businesses={businesses}
          onOpen={(id) => { try { localStorage.setItem('mode', 'cards') } catch {}; navigate(hashForCard(id)) }}
          onNudge={handleNudge}
        />
      )}

      <header className="topbar">
        <div className="mode-switch" role="tablist" aria-label={t('View')}>
          <button
            role="tab"
            aria-selected={mode === 'cards'}
            className={mode === 'cards' ? 'on' : ''}
            onClick={() => switchMode('cards')}
          >
            {t('Cards')}{pendingCards.length > 0 && <span className="mode-count">{pendingCards.length}</span>}
          </button>
          <button
            role="tab"
            aria-selected={mode === 'classic'}
            className={mode === 'classic' ? 'on' : ''}
            onClick={() => switchMode('classic')}
          >
            {t('Classic')}
          </button>
        </div>
        <div className="topbar-right">
          {(!isConnected || unsent > 0) && synced && (
            <span className="link-state" role="status">
              {unsent > 0 ? t('{n} waiting to send', { n: unsent }) : t('Reconnecting…')}
            </span>
          )}
          <span className={`dot ${isConnected ? 'on' : 'off'}`} title={isConnected ? t('Connected') : t('Reconnecting…')} aria-hidden="true" />
          <button className="palette-button" onClick={() => setPalette(true)} aria-label={t('Search or jump to')} title="⌘K" aria-keyshortcuts="Meta+K Control+K">
            <Icon name="search" size={18} />
          </button>
          <NotificationsButton httpBase={relayHttpUrl} sessionToken={sessionToken} />
          <button className="avatar-button" onClick={() => setScreen('profile')} aria-label={t('You')}>
            {(userId.replace(/^(u:|email:)/, '')[0] || '?').toUpperCase()}
          </button>
        </div>
      </header>

      <div className="toasts">
        {error && <div className="toast error" role="alert" onClick={() => setError(null)}>{error}</div>}
        {undo && !error && (
          <div className="toast undo" role="status">
            <span className="undo-text">{t(DECIDED_WORD[undo.action] || 'Done')}{undo.title ? ` · ${undo.title}` : ''}</span>
            <button className="undo-button" onClick={() => handleRollback(undo.cardId)}>{t('Undo')}</button>
          </div>
        )}
      </div>

      {panel === null && (
        <nav className="tabbar" aria-label={t('Main')}>
          <button
            className={mode === 'cards' ? 'tab on' : 'tab'}
            onClick={() => switchMode('cards')}
            data-tab="feed"
            aria-label={t('Feed')}
          ><Icon name="home" /></button>
          <button className="tab" data-tab="history" onClick={() => setScreen('history')} aria-label={t('History')}><Icon name="history" /></button>
          <button className="tab compose" data-tab="compose" onClick={() => setPanel('compose')} aria-label={t('Tell your AI')} aria-keyshortcuts="n">
            <span className="fab-face"><Icon name="plus" /></span>
          </button>
          <button className="tab" data-tab="tools" onClick={() => setScreen('tools')} aria-label={t('Tools')}><Icon name="tools" /></button>
          <button className="tab" data-tab="you" onClick={() => setScreen('profile')} aria-label={t('You')}><Icon name="you" /></button>
        </nav>
      )}

      {panel && <div className="scrim" onClick={() => setPanel(null)} />}

      {palette && (
        <Palette
          httpBase={relayHttpUrl}
          orgId={orgId}
          sessionToken={sessionToken}
          cards={[...pendingCards, ...decidedCards, ...sentCards]}
          onPick={pickFromPalette}
          onClose={() => setPalette(false)}
        />
      )}

      {panel === 'compose' && (
        <div className="sheet sheet-bottom" role="dialog" aria-modal="true" aria-label={t('Tell your AI')}>
          <div className="sheet-title">{t('Tell your AI')}</div>
          <p className="sheet-hint">{t('compose.hint')}</p>
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

      {panel === 'record' && (
        <RecordSheet httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={() => setPanel(null)} />
      )}

      {/* The design's own screens. Each takes the viewport while it is open,
          which is what makes them screens and not sheets. */}
      {screen === 'team' && (
        <Team
          httpBase={relayHttpUrl}
          orgId={orgId}
          sessionToken={sessionToken}
          // They just walked out of this workspace, so there is nothing left
          // here to show them. Asking the server where they still belong is
          // the same question a sign-in asks.
          onLeft={() => { setScreen(null); onLeft() }}
          onClose={() => setScreen(null)}
        />
      )}
      {screen === 'tools' && (
        <Tools httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={() => setScreen(null)} />
      )}
      {screen === 'history' && (
        <History
          decided={decidedCards}
          sent={sentCards}
          businesses={businesses}
          userId={userId}
          onUndo={handleRollback}
          onClose={() => setScreen(null)}
          httpBase={relayHttpUrl}
          orgId={orgId}
          sessionToken={sessionToken}
        />
      )}
      {screen === 'notifications' && (
        <NotificationSettings httpBase={relayHttpUrl} sessionToken={sessionToken} onClose={() => setScreen(null)} />
      )}
      {screen === 'insights' && (
        <Insights httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={() => setScreen(null)} />
      )}
      {screen === 'plans' && (
        <Plans httpBase={relayHttpUrl} sessionToken={sessionToken} onClose={() => setScreen(null)} />
      )}
      {screen === 'profile' && (
        <Profile
          httpBase={relayHttpUrl}
          orgId={orgId}
          userId={userId}
          sessionToken={sessionToken}
          businesses={businesses}
          pendingCount={pendingCards.length}
          decidedCount={decidedCards.length}
          onOpen={(where) => {
            if (where === 'record') { setScreen(null); setPanel('record') }
            else setScreen(where)
          }}
          onLocaleChange={() => setLocaleVersion((v) => v + 1)}
          onSwitchOrg={(next) => { setScreen(null); onSwitchOrg(next) }}
          onLogout={onLogout}
          onClose={() => setScreen(null)}
        />
      )}

      {showDebug && (
        <div className="debug-log">
          <h3>{t('Event log')}</h3>
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
