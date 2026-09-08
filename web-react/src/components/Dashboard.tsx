import { Home, PlusCircle, UserRound } from 'lucide-react'
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { WebSocketClient } from '../services/WebSocketClient'
import { Feed } from './Feed'
import { ClassicList } from './ClassicList'
import { DecisionCard } from './DecisionCard'
import { CreateDecision } from './CreateDecision'
import { RecordSheet } from './RecordSheet'
import { InviteTeammate } from './InviteTeammate'
import { Tools } from '../screens/Tools'
import { History } from '../screens/History'
import { NotificationSettings } from '../screens/NotificationSettings'
import { Plans } from '../screens/Plans'
import { Profile } from '../screens/Profile'
import { NotificationsButton } from './NotificationsBanner'
import { notifyNewDecision, setTabBadge } from '../utils/notifications'
import { syncLocale } from '../utils/push'
import type { AppState, Business } from '../types/card'
import './Dashboard.css'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { sampleCards, sampleUser, sampleMembers, sampleBusinesses } from '../utils/sampleWorkspace'
import { readResponse } from '../utils/api'

interface Props {
  userId: string
  orgId: string
  relayUrl: string
  sessionToken: string
  onLogout: () => void
  sample?: boolean
  figmaFixture?: boolean
}

type Panel = null | 'compose' | 'sent' | 'done' | 'record' | 'invite' | 'detail' | 'undo'
type Mode = 'cards' | 'classic'
// A full screen over the feed, as opposed to a sheet. These are the design's
// own screens — Tools, History, Notifications, Plan, You — and each one owns
// the viewport while it is open.
type Screen = null | 'tools' | 'history' | 'notifications' | 'plans' | 'profile'

/// The shell around the feed. The feed is the screen; everything else —
/// telling your AI something, what you sent, what you decided, the team —
/// is a sheet over it that closes back to the feed.
export const Dashboard: React.FC<Props> = ({ userId, orgId, relayUrl, sessionToken, onLogout, sample = false, figmaFixture = false }) => {
  const t = useT()
  const [state, setState] = useState<AppState>(() => ({ cardsById: sample ? Object.fromEntries(sampleCards(figmaFixture).map((card) => [card.id, card])) : {} }))
  const [isConnected, setIsConnected] = useState(sample)
  const [loaded, setLoaded] = useState(sample)
  const [members, setMembers] = useState<Array<{id:string;name:string;role:string}>>(sample ? sampleMembers : [])
  const [membersError,setMembersError]=useState(false), [membersVersion,setMembersVersion]=useState(0)
  const [profile, setProfile] = useState<{ name?:string; avatarUrl?:string }>({})
  const [composeSeed, setComposeSeed] = useState<{ text:string; recipient:string; videoURL?:string }>({text:"",recipient:""})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ message:string; undo?:string } | null>(null)
  const pendingAction = useRef<{ id:string; action:string; baseline?:string; expected:Record<string,unknown>; timer:ReturnType<typeof setTimeout> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [screen, setScreen] = useState<Screen>(null)
  const [businesses, setBusinesses] = useState<Business[]>(sample ? sampleBusinesses : [])
  const [debugLog, setDebugLog] = useState<Array<{ timestamp: string; message: string }>>([])
  const showDebug = import.meta.env.VITE_DEBUG === 'true' || (typeof location !== 'undefined' && location.search.includes('debug'))
  // Bumped when the language changes, so cards re-read their localized text.
  const [localeVersion, setLocaleVersion] = useState(0)
  // Cards is one decision per screen; Classic is the same decisions as a list
  // you can scan. Remembered, because it is a way of working, not a detour.
  const [mode, setMode] = useState<Mode>(() => {
    try { return localStorage.getItem('mode') === 'classic' ? 'classic' : 'cards' } catch { return 'cards' }
  })
  const switchMode = (next: Mode) => {
    setMode(next)
    try { localStorage.setItem('mode', next) } catch {}
  }
  // The card a notification tap (or a ?card= link) asked for.
  const [focusCardId, setFocusCardId] = useState<string | null>(() => {
    try { return new URL(window.location.href).searchParams.get('card') } catch { return null }
  })

  const wsClientRef = useRef<WebSocketClient | null>(null)
  if (wsClientRef.current === null) wsClientRef.current = new WebSocketClient()

  const addDebugLog = useCallback((message: string) => {
    setDebugLog((logs) => [...logs.slice(-199), { timestamp: new Date().toLocaleTimeString(), message }])
  }, [])

  const clearPending = () => { if (pendingAction.current) clearTimeout(pendingAction.current.timer); pendingAction.current = null; setSaving(false) }
  const trackAction = (id:string, action:string, expected:Record<string,unknown> = {}) => {
    clearPending(); setSaving(true); setFeedback(null)
    pendingAction.current = { id, action, expected, baseline: state.cardsById[id]?.decision?.decidedAt, timer:setTimeout(() => { pendingAction.current = null; setSaving(false); setError(t('The response is not confirmed yet. Check the request before retrying.')) },20000) }
  }
  useEffect(() => () => { if (pendingAction.current) clearTimeout(pendingAction.current.timer) }, [])
  const relayHttpUrl = relayUrl.replace(/^ws/, 'http')

  useEffect(() => {
    const cards = Object.values(state.cardsById || {})
    const pending = cards.filter((c) => c.status === 'pending' && c.recipientUserID === userId)
    setTabBadge(pending.length)
    return () => setTabBadge(0)
  }, [state, userId])

  useEffect(() => {
    if (sample) return
    const wsClient = wsClientRef.current!
    let ignore = false
    wsClient.onAccessDenied = () => { if (!ignore) onLogout() }
    wsClient.onStateChange = (newState) => {
      if (ignore) return
      setState(newState); setLoaded(true)
      const waiting = pendingAction.current, card = waiting && newState.cardsById[waiting.id]
      if (waiting && card && (waiting.action === 'rollback' ? card.status === 'pending' && !card.decision : card.status !== 'pending' && card.decision?.action === waiting.action && card.decision.actorUserID === userId && card.decision.decidedAt !== waiting.baseline && Object.entries(waiting.expected).every(([key,value]) => (card.decision as unknown as Record<string,unknown>)[key] === value))) {
        clearPending(); setFeedback({message:t(waiting.action === 'rollback' ? 'Response undone. The request is waiting again.' : 'Response saved.'), ...(waiting.action === 'rollback' ? {} : {undo:card.id})})
      }
    }
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
    wsClient.onError = (message) => { if (!ignore) { clearPending(); setError(message); addDebugLog(`Error: ${message}`) } }
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
    if (sample || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'open-card' && event.data.cardId) { setPanel(null); setFocusCardId(event.data.cardId) }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  // What language this browser reads, so every notification arrives in it.
  useEffect(() => { if (!sample) syncLocale(relayHttpUrl, sessionToken) }, [relayHttpUrl, sessionToken])

  // The org's businesses, for turning a slug on a card into its name. Nobody
  // picks one; the AI files every card in the background.
  const loadBusinesses = useCallback(async () => {
    if (sample) return
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

  useEffect(() => {
    const background = [...document.querySelectorAll<HTMLElement>('.feed,.classic,.topbar')]
    background.forEach((node) => { node.inert = !!screen; if (screen) node.setAttribute('aria-hidden','true'); else node.removeAttribute('aria-hidden') })
    return () => background.forEach((node) => { node.inert = false; node.removeAttribute('aria-hidden') })
  }, [screen, mode, localeVersion, panel])

  // Escape closes whatever is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPanel(null); setScreen(null) }
      else if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !panel && !screen && !(e.target as HTMLElement)?.closest('input, textarea, select,button,a,[contenteditable]')) setPanel('compose')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, screen])

  useEffect(() => {
    if (sample) return
    const request = new AbortController(), headers = { 'x-session-token': sessionToken }
    setMembersError(false)
    fetch(`${relayHttpUrl}/members?orgId=${encodeURIComponent(orgId)}`, { headers, signal: request.signal }).then(readResponse).then((data) => { if (!request.signal.aborted) setMembers(data.members || []) }).catch(() => { if (!request.signal.aborted) setMembersError(true) })
    fetch(`${relayHttpUrl}/me`, { headers, signal: request.signal }).then(readResponse).then((data) => { if (!request.signal.aborted) setProfile(data) }).catch(() => {})
    return () => request.abort()
  }, [relayHttpUrl, sessionToken, orgId, sample, membersVersion])
  const handleAsk = useCallback((text: string, card: any, videoURL?: string) => {
    setComposeSeed({ text: `About "${card.title}": ${text}`, recipient: card.senderUserID, videoURL }); setPanel('compose')
  }, [])
  const sendCreated = async (card: any) => {
    if (sample) { setState((current) => ({ ...current, cardsById: { ...current.cardsById, [card.id]: { ...card, senderUserID: userId, requestedBy: { name: 'Alex Morgan', role: 'Product lead', quote: card.sourceInstruction } } } })); setFeedback({message:t('Sample request created locally. Find it in Classic under Sent by you.')}); return }
    await wsClientRef.current!.sendCardCreated(card)
    setFeedback({message:t('Request sent. You can find it in Classic under Sent by you.')})
  }
  const attachVideo = async (file: File) => {
    const result = await readResponse(await fetch(`${relayHttpUrl}/media`, { method:'POST', headers: { 'content-type': file.type, 'x-session-token': sessionToken }, body:file }))
    return result.url as string
  }

  const handleDecision = useCallback((cardId: string, action: string, options?: any) => {
    if (panel || screen || saving || pendingAction.current) return false
    if (sample) { setState((current) => { const card = current.cardsById[cardId]; return { ...current, cardsById: { ...current.cardsById, [cardId]: { ...card, status: action === 'decline' ? 'rejected' : action === 'approve' ? 'approved' : 'completed', decision: { action, ...options, actorUserID: userId, decidedAt: new Date().toISOString() } } } } }); setFeedback({message:t('Sample response saved locally.'),undo:cardId}); return true }
    trackAction(cardId, action, options || {})
    if (!wsClientRef.current!.sendDecision(cardId, action, options)) { clearPending(); setError(t('Reconnect before saving a response.')); return false }
    addDebugLog(`Sent decision: ${cardId} → ${action}`)
    return true
  }, [addDebugLog, panel, screen, saving, state, sample, userId, t])
  const handleRollback = useCallback((cardId: string) => {
    if (saving || pendingAction.current) return
    setPanel(null)
    if (sample) { setState((current) => ({ ...current, cardsById: { ...current.cardsById, [cardId]: { ...current.cardsById[cardId], status: 'pending', decision: undefined } } })); setFeedback({message:t('Sample response undone locally.')}); return }
    trackAction(cardId, 'rollback')
    if (!wsClientRef.current!.sendRollback(cardId)) { clearPending(); setError(t('Reconnect before undoing a response.')) }
    else addDebugLog(`Undo requested: ${cardId}`)
  }, [addDebugLog, saving, state, sample, t])
  const handleNudge = useCallback((cardId: string) => {
    if (sample) { setError(t('Sample reminder recorded locally. No notification was sent.')); return }
    if (!wsClientRef.current!.sendNudge(cardId)) setError(t('Reconnect before sending a reminder.'))
    else { addDebugLog(`Reminder requested: ${cardId}`); setFeedback({message:t('Reminder requested.')}) }
  }, [addDebugLog])

  const cards = Object.values(state.cardsById || {}).map((card) => sample ? { ...card, title:t(card.title), summary:t(card.summary), context:t(card.context), requestedBy:card.requestedBy ? {...card.requestedBy,role:t(card.requestedBy.role || ''),quote:t(card.requestedBy.quote || '')}:undefined,recommendation:card.recommendation ? {...card.recommendation,reason:t(card.recommendation.reason || '')}:undefined } : card)
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
    .filter((c) => c.senderUserID === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const nameOf = (slug?: string) => businesses.find((b) => b.slug === slug)?.name
  const memberName = (id:string) => members.find((member) => member.id === id)?.name || id.replace(/^(u:|email:)/,'').split('@')[0]
  const selectedCard = selectedId ? state.cardsById[selectedId] : undefined
  const openCard = (id:string) => {
    const card = state.cardsById[id]; setScreen(null)
    if (card?.status === 'pending' && card.recipientUserID === userId) { setPanel(null); setFocusCardId(id); switchMode('cards') }
    else { setSelectedId(id); setPanel('detail') }
  }
  const askUndo = (id:string) => { setSelectedId(id); setPanel('undo') }
  useEffect(() => {
    const root = document.querySelector('.shell'), modal = root?.querySelector<HTMLElement>('.sheet[role="dialog"]')
    if (!panel || !root || !modal) return
    const previous = document.activeElement as HTMLElement | null
    const siblings = [...root.children].filter((node) => node !== modal && !node.contains(modal) && !node.classList.contains('scrim')) as HTMLElement[]
    siblings.forEach((node) => node.inert = true)
    const focusable = () => [...modal.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter((node) => node.getClientRects().length)
    focusable()[0]?.focus()
    const trap = (event:KeyboardEvent) => { if (event.key !== 'Tab') return; const targets = focusable(), first = targets[0], last = targets[targets.length-1]; if (!first) { event.preventDefault(); return }; if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus() } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus() } }
    document.addEventListener('keydown',trap)
    return () => { siblings.forEach((node) => node.inert = false); document.removeEventListener('keydown',trap); previous?.focus() }
  },[panel])

  return (
    <div className={`shell${mode === 'classic' ? ' classic-mode' : ''}${screen ? ' screen-open' : ''}${screen === 'profile' ? ' profile-open' : ''}`}>
      {mode === 'cards' ? (
        <Feed
          key={localeVersion}
          cards={pendingCards}
          userId={userId}
          businesses={sample ? businesses.map((business) => ({...business,name:t(business.name)})) : businesses}
          focusCardId={focusCardId}
          onDecide={handleDecision}
          onAsk={handleAsk}
          connected={isConnected && !saving}
          loaded={loaded}
          active={!panel && !screen}
          sample={sample}
          onAttach={sample ? undefined : attachVideo}
        />
      ) : (
        <ClassicList
          workspaceLabel={t(sample ? 'Sample workspace' : 'Your workspace')}
          onProfile={() => setScreen('profile')}
          key={localeVersion}
          pending={pendingCards}
          sent={sentCards}
          decided={decidedCards}
          businesses={sample ? businesses.map((business) => ({...business,name:t(business.name)})) : businesses}
          onOpen={openCard}
          memberName={memberName}
          onNudge={handleNudge}
        />
      )}

      {sample && <div className="demo-label">{t('Sample workspace · local only')} <button onClick={onLogout}>{t('Exit demo')}</button></div>}
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
          <span className={`dot ${isConnected ? 'on' : 'off'}`} title={isConnected ? t('Connected') : t('Reconnecting…')} />

          <button className="avatar-button" onClick={() => setScreen('profile')} aria-label={t('You')}>
            {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : <UserRound size={23} strokeWidth={1.7} />}
          </button>
        </div>
      </header>

      <div className="toasts">
        {(feedback || saving) && <div className="toast decision-feedback" role="status"><span>{saving ? t('Saving response…') : feedback?.message}</span>{feedback?.undo && <button onClick={() => askUndo(feedback.undo!)}>{t('Undo')}</button>}<button aria-label={t('Dismiss')} onClick={() => setFeedback(null)}>×</button></div>}
        {error && <div className="toast error" onClick={() => setError(null)}>{error}</div>}
      </div>

      {panel === null && <nav className="tabbar" aria-label={t('Main')}>
        <button className={`tab${!screen ? ' on' : ''}`} data-tab="feed" onClick={() => { setScreen(null); switchMode('cards') }} aria-label={t('Home')}><Home size={25} strokeWidth={1.9} /></button>
        <button className="tab compose" data-tab="compose" onClick={() => { setComposeSeed({text:'',recipient:''}); setPanel('compose') }} aria-label={t('Tell your AI')}><PlusCircle size={27} strokeWidth={1.8} /></button>
        <button className={`tab${screen === 'profile' ? ' on' : ''}`} data-tab="you" onClick={() => setScreen('profile')} aria-label={t('You')}><UserRound size={25} strokeWidth={1.8} /></button>
      </nav>}


      {panel && <div className="scrim" onClick={() => setPanel(null)} />}

      {(
        <div hidden={panel !== 'compose'} className="sheet sheet-bottom" aria-modal={panel === 'compose' ? true : undefined} role={panel === 'compose' ? 'dialog' : undefined} aria-label={t('Tell your AI')}>
          <div className="sheet-title">{t('Tell your AI')}<button className="close" onClick={() => setPanel(null)} aria-label={t('Close')}>×</button></div>
          <p className="sheet-hint">{t(sample ? 'Create a sample request. Choose a teammate and review the details.' : 'Choose a teammate and review your request before sending.')}</p>
          <CreateDecision
            relayHttpUrl={relayHttpUrl}
            orgId={orgId}
            userId={userId}
            sessionToken={sessionToken}
            autoFocus
            connected={isConnected}
            onSendCard={sendCreated}
            members={members}
            membersError={membersError}
            onReloadMembers={() => setMembersVersion((version) => version + 1)}
            initialText={composeSeed.text}
            initialRecipient={composeSeed.recipient}
            videoURL={composeSeed.videoURL}
            sample={sample}
            open={panel === 'compose'}
            onLog={addDebugLog}
            onDone={() => setPanel(null)}
          />
        </div>
      )}

      {panel === 'sent' && (
        <aside className="sheet sheet-side" role="dialog" aria-label={t('Sent by you')}>
          <div className="sheet-title">{t('Sent by you')} <button className="close" data-close="1" onClick={() => setPanel(null)} aria-label={t('Close')}>×</button></div>
          {sentCards.length === 0 && <p className="sheet-empty">{t('Nothing sent yet. Tell your AI something.')}</p>}
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
              {card.status === 'pending' && <button className="nudge-button" onClick={() => handleNudge(card.id)}>{t('Nudge')}</button>}
            </div>
          ))}
        </aside>
      )}

      {panel === 'done' && (
        <aside className="sheet sheet-side" role="dialog" aria-label={t('Decided')}>
          <div className="sheet-title">{t('Decided')} <button className="close" data-close="1" onClick={() => setPanel(null)} aria-label={t('Close')}>×</button></div>
          {decidedCards.length === 0 && <p className="sheet-empty">{t('No decisions yet.')}</p>}
          {decidedCards.map((card) => (
            <DecisionCard
              key={card.id}
              card={card}
              currentUserId={userId}
              businessName={nameOf(card.business)}
              onApprove={() => {}} onDecline={() => {}} onChoose={() => {}} onReply={() => {}}
              onAcknowledge={() => {}} onDelegate={() => {}}
              onRollback={() => askUndo(card.id)}
              isPending={false}
            />
          ))}
        </aside>
      )}

      {panel === 'detail' && selectedCard && <aside className="sheet sheet-bottom" role="dialog" aria-modal="true" aria-label={t('Request details')} data-testid="request-detail"><div className="sheet-title">{t('Request details')}<button className="close" onClick={() => setPanel(null)} aria-label={t('Close')}>×</button></div><p className="sheet-hint">{memberName(selectedCard.senderUserID)} → {memberName(selectedCard.recipientUserID)}</p><DecisionCard card={selectedCard} currentUserId={userId} businessName={nameOf(selectedCard.business)} onApprove={() => {}} onDecline={() => {}} onChoose={() => {}} onReply={() => {}} onAcknowledge={() => {}} onDelegate={() => {}} onRollback={() => askUndo(selectedCard.id)} isPending={false} disabled={saving} />{selectedCard.status === 'pending' && <p className="form-note">{t('Waiting on {name}',{name:memberName(selectedCard.recipientUserID)})}</p>}</aside>}
      {panel === 'undo' && selectedCard && <div className="sheet sheet-bottom" role="dialog" aria-modal="true" aria-label={t('Undo response?')}><div className="sheet-title">{t('Undo response?')}<button className="close" onClick={() => setPanel(null)} aria-label={t('Close')}>×</button></div><p className="sheet-hint">{selectedCard.title}</p><p className="form-note">{t(sample ? 'The sample request will return to waiting. No notifications are sent.' : 'The request will return to waiting. Changes already made in connected tools are not undone.')}</p><div className="compose-actions"><button className="btn btn-ghost" onClick={() => setPanel(null)}>{t('Cancel')}</button><button className="btn btn-primary" disabled={saving} onClick={() => handleRollback(selectedCard.id)}>{t('Undo response')}</button></div></div>}

      {panel === 'record' && (
        <RecordSheet httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={() => setPanel(null)} />
      )}

      {panel === 'invite' && (
        <div className="sheet sheet-bottom" role="dialog" aria-label={t('Invite a teammate')}>
          <div className="sheet-title">
            {t('Invite a teammate')}
            <button className="close" data-close="1" onClick={() => setPanel(null)} aria-label={t('Close')}>×</button>
          </div>
          <InviteTeammate relayHttpUrl={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} />
        </div>
      )}

      {/* The design's own screens. Each takes the viewport while it is open,
          which is what makes them screens and not sheets. */}
      {screen === 'tools' && (
        <Tools httpBase={relayHttpUrl} orgId={orgId} sessionToken={sessionToken} onClose={() => setScreen(null)} />
      )}
      {screen === 'history' && (
        <History
          decided={decidedCards}
          sent={sentCards}
          businesses={sample ? businesses.map((business) => ({...business,name:t(business.name)})) : businesses}
          userId={userId}
          onOpen={openCard}
          memberName={memberName}
          onClose={() => setScreen(null)}
        />
      )}
      {screen === 'notifications' && (
        <NotificationSettings httpBase={relayHttpUrl} sessionToken={sessionToken} onClose={() => setScreen(null)} />
      )}
      {screen === 'plans' && (
        <Plans httpBase={relayHttpUrl} sessionToken={sessionToken} onClose={() => setScreen(null)} />
      )}
      {screen === 'profile' && (
        <Profile
          sample={sample}
          sampleMembers={sampleMembers}
          onResetSample={() => { setState({ cardsById:Object.fromEntries(sampleCards(figmaFixture).map((card) => [card.id,card])) }); setFeedback({message:t('Sample workspace reset.')}) }}
          httpBase={relayHttpUrl}
          orgId={orgId}
          userId={userId}
          sessionToken={sessionToken}
          businesses={sample ? businesses.map((business) => ({...business,name:t(business.name)})) : businesses}
          pendingCount={pendingCards.length}
          decidedCount={decidedCards.length}
          onOpen={(where) => {
            if (where === 'record') { setScreen(null); setPanel('record') }
            else if (where === 'invite') { setScreen(null); setPanel('invite') }
            else setScreen(where)
          }}
          onLocaleChange={() => setLocaleVersion((v) => v + 1)}
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
