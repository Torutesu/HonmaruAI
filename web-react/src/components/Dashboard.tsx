import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { WebSocketClient } from '../services/WebSocketClient'
import { Workbench, type Member, type WorkspaceView } from './Workbench'
import { RequestComposer } from './RequestComposer'
import { WorkspaceSettings } from './WorkspaceSettings'
import { NotificationsButton } from './NotificationsBanner'
import { notifyNewDecision, setTabBadge } from '../utils/notifications'
import { syncLocale } from '../utils/push'
import { readResponse } from '../utils/api'
import type { AppState, Business, DecisionCard } from '../types/card'

interface Props { userId: string; orgId: string; relayUrl: string; sessionToken: string; onLogout: (reason?: string) => void; onSwitchOrg: (orgId: string) => void }
interface Pending { id: string; action: string; replyText?: string; previousDecision?: string; timer: ReturnType<typeof setTimeout> }
function currentNavigation() { const query = new URLSearchParams(location.search); return { view: (['inbox', 'sent', 'completed', 'workspace'].includes(query.get('view') || '') ? query.get('view') : 'inbox') as WorkspaceView, card: query.get('card') } }
export const Dashboard: React.FC<Props> = ({ userId, orgId, relayUrl, sessionToken, onLogout, onSwitchOrg }) => {
  const [state, setState] = useState<AppState>({ cardsById: {} }), [connected, setConnected] = useState(false), [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<WorkspaceView>(() => currentNavigation().view), [selectedId, setSelectedId] = useState<string | null>(() => currentNavigation().card)
  const [compose, setCompose] = useState(false), [members, setMembers] = useState<Member[]>([]), [businesses, setBusinesses] = useState<Business[]>([])
  const [membersError, setMembersError] = useState(''), [displayName, setDisplayName] = useState(userId.replace(/^(u:|email:)/, '').split('@')[0])
  const [notice, setNotice] = useState<{ text: string; undoId?: string; error?: boolean } | null>(null), [busyCardId, setBusyCardId] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0), [, setLocaleVersion] = useState(0)
  useEffect(() => { if (!notice || notice.error) return; const timeout = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(timeout) }, [notice])
  const socket = useRef<WebSocketClient>(); if (!socket.current) socket.current = new WebSocketClient()
  const pending = useRef<Pending | null>(null), latestState = useRef(state); latestState.current = state
  const httpBase = relayUrl.replace(/^ws/, 'http')
  const navigate = useCallback((next: WorkspaceView, card: string | null = null, replace = false) => { setView(next); setSelectedId(card); const url = new URL(location.href); url.searchParams.set('view', next); if (card) url.searchParams.set('card', card); else url.searchParams.delete('card'); history[replace ? 'replaceState' : 'pushState'](null, '', url) }, [])
  const clearPending = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = null; setBusyCardId(null) }
  useEffect(() => { const pop = () => { const current = currentNavigation(); setView(current.view); setSelectedId(current.card); setCompose(false) }; window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop) }, [])
  useEffect(() => {
    const ws = socket.current!; let ignore = false
    ws.onStateChange = (next) => {
      if (ignore) return
      setState(next); setLoaded(true)
      const waiting = pending.current, card = waiting && next.cardsById[waiting.id]
      if (waiting && card && (waiting.action === 'rollback' ? card.status === 'pending' && !card.decision : card.decision?.action === waiting.action && card.decision.actorUserID === userId && card.decision.decidedAt !== waiting.previousDecision && (!waiting.replyText || card.decision.replyText === waiting.replyText))) {
        clearPending(); setNotice(waiting.action === 'rollback' ? { text: 'Response undone. The request is back in Inbox.' } : { text: 'Response saved. The sender can see your decision.', undoId: waiting.id })
      }
    }
    ws.onAccessDenied = (message) => { if (!ignore) onLogout(message) }
    ws.onCardCreated = (card) => { if (!ignore && card.recipientUserID === userId && card.status === 'pending') notifyNewDecision(card.title || 'New request', 'A teammate') }
    ws.onError = (message) => { if (!ignore) { clearPending(); setNotice({ text: message, error: true }) } }
    ws.onConnectionChange = (ready) => { if (!ignore) setConnected(ready) }
    ws.connect(relayUrl, userId, orgId, sessionToken).catch(() => { if (!ignore) setNotice({ text: 'Unable to connect. Requests will reload when the connection returns.', error: true }) })
    return () => { ignore = true; if (pending.current) clearTimeout(pending.current.timer); pending.current = null; ws.disconnect() }
  }, [relayUrl, userId, orgId, sessionToken])
  useEffect(() => { const count = Object.values(state.cardsById).filter((c) => c.recipientUserID === userId && c.status === 'pending').length; setTabBadge(count); return () => setTabBadge(0) }, [state, userId])
  useEffect(() => { syncLocale(httpBase, sessionToken) }, [httpBase, sessionToken])
  useEffect(() => {
    const abort = new AbortController(), headers = { 'x-session-token': sessionToken }
    setMembersError('')
    fetch(`${httpBase}/members?orgId=${encodeURIComponent(orgId)}`, { headers, signal: abort.signal }).then(readResponse).then((result) => { if (!abort.signal.aborted) setMembers(result.members || []) }).catch(() => { if (!abort.signal.aborted) setMembersError('The team could not be loaded. Refresh Workspace before choosing a recipient.') })
    fetch(`${httpBase}/businesses?orgId=${encodeURIComponent(orgId)}`, { headers, signal: abort.signal }).then(readResponse).then((result) => { if (!abort.signal.aborted) setBusinesses(result.businesses || []) }).catch(() => {})
    fetch(`${httpBase}/me`, { headers, signal: abort.signal }).then(readResponse).then((result) => { if (!abort.signal.aborted && result.name) setDisplayName(result.name) }).catch(() => {})
    return () => abort.abort()
  }, [httpBase, sessionToken, orgId, refresh])
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const openCard = (event: MessageEvent) => { const card = latestState.current.cardsById[event.data?.cardId]; if (event.data?.type === 'open-card' && card) { setCompose(false); navigate(card.status !== 'pending' ? 'completed' : card.recipientUserID === userId ? 'inbox' : 'sent', card.id) } }
    navigator.serviceWorker.addEventListener('message', openCard); return () => navigator.serviceWorker.removeEventListener('message', openCard)
  }, [navigate, userId])
  const initialFocus = useRef(false)
  useEffect(() => { if (!loaded || initialFocus.current) return; initialFocus.current = true; const card = selectedId && state.cardsById[selectedId]; if (card) navigate(card.status !== 'pending' ? 'completed' : card.recipientUserID === userId ? 'inbox' : 'sent', card.id, true) }, [loaded, selectedId, state, navigate, userId])
  const begin = (id: string, action: string, options?: { replyText?: string }) => {
    if (pending.current) return false
    const sent = action === 'rollback' ? socket.current!.sendRollback(id) : socket.current!.sendDecision(id, action, options)
    if (!sent) { setNotice({ text: 'Reconnect before saving a response.', error: true }); return false }
    pending.current = { id, action, ...options, previousDecision: latestState.current.cardsById[id]?.decision?.decidedAt, timer: setTimeout(() => { pending.current = null; setBusyCardId(null); setNotice({ text: 'Saving is taking longer than expected. Check the request status before trying again.', error: true }) }, 20000) }
    setBusyCardId(id); return true
  }
  const send = async (card: DecisionCard) => { await socket.current!.sendCardCreated({ ...card }); setNotice({ text: 'Request delivered. Track its response in Sent.' }); navigate('sent', card.id) }
  return <><Workbench cards={Object.values(state.cardsById)} userId={userId} displayName={displayName} members={members} businesses={businesses} connected={connected} loaded={loaded} view={view} onView={(next) => navigate(next)} selectedId={selectedId} onSelect={(id) => navigate(view, id)} onCompose={() => setCompose(true)} onDecide={begin} onUndo={(id) => begin(id, 'rollback')} onNudge={(id) => { if (socket.current!.sendNudge(id)) setNotice({ text: 'Reminder requested. Delivery depends on the recipient’s notification settings.' }); else setNotice({ text: 'Reconnect before requesting a reminder.', error: true }) }} onLogout={() => onLogout()} busyCardId={busyCardId} notificationControl={<NotificationsButton httpBase={httpBase} sessionToken={sessionToken} />} workspace={<WorkspaceSettings key={refresh} members={members} membersError={membersError} userId={userId} displayName={displayName} onLogout={() => onLogout()} onRefresh={() => setRefresh((r) => r + 1)} httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} onSwitchOrg={onSwitchOrg} onLocaleChange={() => setLocaleVersion((v) => v + 1)} />} notice={notice && <div className={`wb-toast ${notice.error ? 'is-error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span>{notice.undoId && <button disabled={!!busyCardId || !connected} onClick={() => begin(notice.undoId!, 'rollback')}>Undo</button>}<button onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={15} /></button></div>} /><RequestComposer open={compose} onClose={() => setCompose(false)} userId={userId} userName={displayName} members={members} membersError={membersError} businesses={businesses} connected={connected} onSend={send} httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} /></>
}
