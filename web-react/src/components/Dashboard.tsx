import React, { useState, useEffect, useCallback, useRef } from 'react'
import { WebSocketClient } from '../services/WebSocketClient'
import { Feed } from './Feed'
import { ClassicList, type Presence } from './ClassicList'
import { WorkspaceSwitcher, type Workspace } from './WorkspaceSwitcher'
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
import { Automations } from '../screens/Automations'
import { Playbook } from '../screens/Playbook'
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
import { needsLocalizing } from '../utils/language'
import { aiHeaders } from '../utils/aiKey'
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
  // Who is here right now, by login — the relay's word, shown as a dot.
  const [presence, setPresence] = useState<Presence>({})
  // The team's name, for the list's header. From /members, which is the one
  // read that carries it and is already membership-checked.
  const [orgName, setOrgName] = useState('')
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
  // Where a screen's back button goes: to You when You opened it — the
  // chevron on Automations used to drop you on the feed, two steps from
  // where you were — and to the feed otherwise.
  // Words written in the list's "Your AI" conversation, sent through the
  // same composer everything else is.
  // A conversation open on a phone takes the whole screen, as a chat app's
  // does: no mode switch above it, no tab bar under its composer.
  const [immersive, setImmersive] = useState(false)
  const [composeSeed, setComposeSeed] = useState<{ id: string; text: string } | null>(null)
  const returnTo = useRef<Screen | null>(null)
  const setScreen = useCallback((next: Screen | null, from: Screen | null = null) => {
    returnTo.current = from
    navigate(next ? hashForScreen(next) : hashForMode(mode))
  }, [navigate, mode])
  const closeScreen = useCallback(() => {
    const back = returnTo.current
    setScreen(back && back !== screen ? back : null)
  }, [setScreen, screen])
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
    wsClient.onPresence = (who, status) => {
      if (ignore) return
      addDebugLog(`Presence: ${who} → ${status}`)
      setPresence((prev) => ({ ...prev, [who]: status === 'online' ? 'online' : 'offline' }))
    }
    // A comment or a reaction: the thread under the open card listens for
    // its own card; the counts ride in on the card update that follows.
    wsClient.onComment = (cardId, comment) => {
      if (ignore) return
      window.dispatchEvent(new CustomEvent('honmaru:comment', { detail: { cardId, comment } }))
    }
    wsClient.onBusinesses = (list) => { if (!ignore) setBusinesses(list) }
    // Something said in a channel: the list listens for its own.
    wsClient.onChannelMessage = (message) => {
      if (ignore) return
      window.dispatchEvent(new CustomEvent('honmaru:channel-message', { detail: message }))
    }
    wsClient.onReaction = (cardId, emoji, on, by, reactions) => {
      if (ignore) return
      window.dispatchEvent(new CustomEvent('honmaru:reaction', { detail: { cardId, emoji, on, by, reactions } }))
    }
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
  // Every workspace this person is in, with its name and mark, for the
  // switcher at the top of the rail. Re-read when the team screen changes
  // a name or a logo (it says so through a window event).
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch(`${relayHttpUrl}/me`, { headers: { 'x-session-token': sessionToken } })
      if (!res.ok) return
      const me = await res.json()
      if (Array.isArray(me.orgs)) setWorkspaces(me.orgs)
    } catch { /* the switcher shows what it last knew */ }
  }, [relayHttpUrl, sessionToken])
  useEffect(() => { void loadWorkspaces() }, [loadWorkspaces])
  useEffect(() => {
    const onChange = () => { void loadWorkspaces() }
    window.addEventListener('honmaru:workspace', onChange)
    return () => window.removeEventListener('honmaru:workspace', onChange)
  }, [loadWorkspaces])
  // A channel made, renamed or deleted: the reply carries the whole list,
  // and the room hears it as well (below), so every open list agrees.
  const channelCall = useCallback(async (method: 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown>): Promise<string | null> => {
    try {
      const res = await fetch(`${relayHttpUrl}/businesses`, {
        method,
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, ...body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return data.message || t('That did not save.')
      if (Array.isArray(data.businesses)) setBusinesses(data.businesses)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, [relayHttpUrl, orgId, sessionToken, t])
  useEffect(() => {
    let ignore = false
    fetch(`${relayHttpUrl}/members?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!ignore && data && typeof data.name === 'string') setOrgName(data.name) })
      .catch(() => { /* the header falls back to a generic name */ })
    return () => { ignore = true }
  }, [relayHttpUrl, orgId, sessionToken])
  useEffect(() => {
    const known = new Set(businesses.map((b) => b.slug))
    if (Object.values(state.cardsById || {}).some((c) => c.business && !known.has(c.business))) loadBusinesses()
  }, [state, businesses, loadBusinesses])

  // Escape closes whatever is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPalette((p) => !p); return }
      if (palette) return
      if (e.key === 'Escape') { setPanel(null); if (screen) closeScreen() }
      else if (e.key === 'n' && !panel && !screen && !(e.target as HTMLElement)?.matches('input, textarea')) { e.preventDefault(); setPanel('compose') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, screen, setScreen, closeScreen, palette])
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
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken, ...aiHeaders() },
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
      setAnswers((prev) => ({ ...prev, [card.id]: { question: text, answer: data.answer, related: data.related || [], sources: data.sources || [], busy: false } }))
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

  // Cards in this reader's language. The relay translates for the recipient
  // when a card is made; for everyone else — a teammate, the sender after a
  // language switch — the Worker is asked here, once per card and language,
  // and the words are kept on the card for the next reader. A deployment
  // with no model says so once, and is not asked again this session.
  const [translations, setTranslations] = useState<Record<string, Record<string, { title: string; summary?: string; context?: string }>>>({})
  // A card the URL names that the socket never sent — a search hit from
  // months ago. Fetched once; `card: null` remembers a miss.
  const [fetched, setFetched] = useState<{ id: string; card: DecisionCard | null } | null>(null)
  const askedFor = useRef(new Set<string>())
  const noTranslator = useRef(false)
  const locale = getLocale()
  const rawCards = Object.values(state.cardsById || {})
  useEffect(() => {
    if (noTranslator.current) return
    // Only what is on screen, and the card in front first: a workspace full
    // of cards in another language must not spend a metered day's allowance
    // before the person has typed anything. The Worker keeps the last call
    // of a metered day for them regardless.
    const mine = rawCards.filter((c) => c.recipientUserID === userId || c.senderUserID === userId)
    const inFront = focusCardId ? mine.filter((c) => c.id === focusCardId) : []
    const wanted = [...inFront, ...mine.filter((c) => c.status === 'pending' && c.recipientUserID === userId && c.id !== focusCardId)]
      .filter((c) => needsLocalizing(c, locale) && !translations[c.id]?.[locale] && !askedFor.current.has(`${c.id}|${locale}`))
      .slice(0, 2)
    for (const card of wanted) {
      askedFor.current.add(`${card.id}|${locale}`)
      fetch(`${relayHttpUrl}/cards/${encodeURIComponent(card.id)}/localize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken, ...aiHeaders() },
        body: JSON.stringify({ orgId, locale }),
      })
        .then(async (r) => {
          if (r.status === 503 || r.status === 429) { noTranslator.current = true; return }
          if (!r.ok) return
          const data = await r.json().catch(() => ({}))
          if (data.localized?.title) setTranslations((prev) => ({ ...prev, [card.id]: { ...(prev[card.id] || {}), [locale]: data.localized } }))
        })
        .catch(() => { /* the card reads in its own language */ })
    }
  }, [rawCards, locale, userId, relayHttpUrl, orgId, sessionToken, translations, localeVersion, focusCardId])
  const cards = rawCards.map((c) => (translations[c.id] ? { ...c, localized: { ...(c.localized || {}), ...translations[c.id] } } : c))
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
  // A card the URL names opens whatever list it is on — sent, decided by
  // someone else, or older than the socket's snapshot and fetched below.
  // Only with no card named does the pane fall back to the first thing
  // waiting: a "Decided before" hit must not silently show something else.
  const named = focusCardId ? cards.find((c) => c.id === focusCardId) ?? (fetched?.id === focusCardId ? fetched.card : null) : null
  const selectedId = named ? named.id : (pendingCards[0]?.id ?? null)
  const selected = named ?? (selectedId ? inboxCards.find((c) => c.id === selectedId) ?? null : null)
  useEffect(() => {
    if (!focusCardId || cards.some((c) => c.id === focusCardId) || fetched?.id === focusCardId) return
    let ignore = false
    fetch(`${relayHttpUrl}/cards/${encodeURIComponent(focusCardId)}?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then(async (r) => {
        if (ignore) return
        const data = r.ok ? await r.json().catch(() => ({})) : {}
        setFetched({ id: focusCardId, card: data.card ?? null })
        if (!r.ok) setError(t('That card is not in this workspace.'))
      })
      .catch(() => { /* offline: the card the URL names is not here */ })
    return () => { ignore = true }
  }, [focusCardId, cards, fetched, relayHttpUrl, orgId, sessionToken, t])
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
  const workspaceSwitcher = (variant: 'rail' | 'header') => (
    <WorkspaceSwitcher
      variant={variant}
      workspaces={workspaces.length ? workspaces : [{ id: orgId, name: orgName || null, role: 'member' }]}
      currentId={orgId}
      onSwitch={onSwitchOrg}
      onSettings={() => setScreen('team')}
      onCreate={() => setScreen('profile')}
      onJoin={() => setScreen('profile')}
      onLogout={onLogout}
    />
  )

  return (
    // `screen-open` is what lets the rail stay on a laptop while a screen is
    // open: on a phone a screen owns the viewport and the tab bar goes away,
    // on a laptop navigation is a place on the page and disappearing would be
    // the app losing its own chrome.
    <div className={`shell${screen ? ' screen-open' : ''}${immersive && mode === 'classic' && !screen ? ' immersive' : ''}`}>
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
          cards={named && !pendingCards.some((c) => c.id === named.id) ? [...pendingCards, named] : pendingCards}
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
          userId={userId}
          orgName={orgName}
          pending={pendingCards}
          sent={sentCards}
          decided={decidedCards}
          businesses={businesses}
          presence={presence}
          onOpen={(id) => { try { localStorage.setItem('mode', 'cards') } catch {}; navigate(hashForCard(id)) }}
          onNudge={handleNudge}
          onDecide={(id, action) => handleDecision(id, action)}
          api={api}
          onSearch={() => setPalette(true)}
          onCompose={() => setPanel('compose')}
          onTellAI={(text) => { setComposeSeed({ id: String(Date.now()), text }); setPanel('compose') }}
          onImmersive={setImmersive}
          // The whole card — its thread, Ask, the reply draft — drawn in the
          // list's own pane, so opening a decision never leaves the list.
          renderCard={(card) => (
            <Feed
              key={`${card.id}-${card.status}-${localeVersion}`}
              cards={[card]}
              userId={userId}
              businesses={businesses}
              focusCardId={null}
              ready
              active={!panel && !screen && !palette}
              onDecide={handleDecision}
              onAsk={handleAsk}
              onFlag={handleFlag}
              answers={answers}
              onUndo={handleRollback}
              api={api}
              layout="desk"
            />
          )}
          onWorkspace={() => setScreen('team')}
          workspaceMenu={workspaceSwitcher('header')}
          onCreateChannel={(name) => channelCall('POST', { name })}
          onRenameChannel={(slug, name) => channelCall('PUT', { slug, name })}
          onDeleteChannel={(slug) => channelCall('DELETE', { slug })}
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

      {/* Always drawn: on a phone the sheet and its scrim cover it, on a
          laptop the rail staying put is the app keeping its own chrome. */}
      {(
        <nav className="tabbar has-ws" aria-label={t('Main')}>
          {/* The workspace's mark and name, and the way into every other
              workspace — at the top of the rail on a laptop; on a phone the
              list's header and the You screen carry it. */}
          {workspaceSwitcher('rail')}
          {/* The lit tab is where you are: a screen while one is open, the
              feed otherwise. The rail used to light Feed under History. */}
          <button
            className={!screen && mode === 'cards' ? 'tab on' : 'tab'}
            aria-current={!screen && mode === 'cards' ? 'page' : undefined}
            onClick={() => { setScreen(null); switchMode('cards') }}
            data-tab="feed"
            aria-label={t('Feed')}
          ><Icon name="home" /></button>
          <button className={screen === 'history' ? 'tab on' : 'tab'} aria-current={screen === 'history' ? 'page' : undefined} data-tab="history" onClick={() => setScreen('history')} aria-label={t('History')}><Icon name="history" /></button>
          <button className="tab compose" data-tab="compose" onClick={() => setPanel('compose')} aria-label={t('Tell your AI')} aria-keyshortcuts="n">
            <span className="fab-face"><Icon name="plus" /></span>
          </button>
          <button className={screen === 'tools' ? 'tab on' : 'tab'} aria-current={screen === 'tools' ? 'page' : undefined} data-tab="tools" onClick={() => setScreen('tools')} aria-label={t('Tools')}><Icon name="tools" /></button>
          <button className={screen && screen !== 'history' && screen !== 'tools' ? 'tab on' : 'tab'} aria-current={screen && screen !== 'history' && screen !== 'tools' ? 'page' : undefined} data-tab="you" onClick={() => setScreen('profile')} aria-label={t('You')}><Icon name="you" /></button>
        </nav>
      )}

      {panel && <div className="scrim" onClick={() => { setPanel(null); setComposeSeed(null) }} />}

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
        <div className="sheet sheet-bottom sheet-compose" role="dialog" aria-modal="true" aria-label={t('Tell your AI')}>
          <div className="sheet-title">{t('Tell your AI')}</div>
          <p className="sheet-hint">{t('compose.hint')}</p>
          <CreateDecision
            key={composeSeed?.id || 'compose'}
            relayHttpUrl={relayHttpUrl}
            orgId={orgId}
            userId={userId}
            sessionToken={sessionToken}
            initialText={composeSeed?.text}
            autoSend={Boolean(composeSeed?.text)}
            autoFocus
            onSendCard={(card) => wsClientRef.current!.sendCardCreated(card)}
            onLog={addDebugLog}
            onDone={() => { setPanel(null); setComposeSeed(null) }}
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
          onClose={closeScreen}
        />
      )}
      {screen === 'tools' && (
        <Tools httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={closeScreen} />
      )}
      {screen === 'history' && (
        <History
          decided={decidedCards}
          sent={sentCards}
          businesses={businesses}
          userId={userId}
          onUndo={handleRollback}
          onClose={closeScreen}
          httpBase={relayHttpUrl}
          orgId={orgId}
          sessionToken={sessionToken}
        />
      )}
      {screen === 'notifications' && (
        <NotificationSettings httpBase={relayHttpUrl} sessionToken={sessionToken} onClose={closeScreen} />
      )}
      {screen === 'insights' && (
        <Insights httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={closeScreen} />
      )}
      {screen === 'automations' && (
        <Automations
          httpBase={relayHttpUrl}
          orgId={orgId}
          sessionToken={sessionToken}
          // "Run now" delivers a card; the person goes to read it, in the
          // cards view, where a report is drawn as a document.
          onOpenCard={(id) => { try { localStorage.setItem('mode', 'cards') } catch {}; navigate(hashForCard(id)) }}
          onClose={closeScreen}
        />
      )}
      {screen === 'playbook' && (
        <Playbook httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={closeScreen} />
      )}
      {screen === 'plans' && (
        <Plans httpBase={relayHttpUrl} sessionToken={sessionToken} orgId={orgId} onClose={closeScreen} />
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
            else setScreen(where, 'profile')
          }}
          onLocaleChange={() => setLocaleVersion((v) => v + 1)}
          onSwitchOrg={(next) => { setScreen(null); onSwitchOrg(next) }}
          onLogout={onLogout}
          onClose={closeScreen}
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
