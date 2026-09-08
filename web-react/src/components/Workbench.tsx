import React, { useEffect, useMemo, useState } from 'react'
import { ArrowDownWideNarrow, ArrowLeft, ArrowUpRight, Bell, Check, CheckCheck, ChevronRight, Circle, Clock3, Download, Inbox, MessageSquare, Plus, Search, Send, Settings2, SlidersHorizontal, Undo2, Users, X } from 'lucide-react'
import { BrandMark } from './Icon'
import { getLocale } from '../utils/locale'
import { requestContext } from '../utils/cardPresentation'
import type { Business, DecisionCard } from '../types/card'
import './Workbench.css'

export type WorkspaceView = 'inbox' | 'sent' | 'completed' | 'workspace'
export interface Member { id: string; name: string; role: string; avatarUrl?: string }
export const kindLabels = { approval: 'Approval', task: 'Task', notification: 'FYI', revision: 'Revision', delegation: 'Handoff' }
export function subject(card: DecisionCard) {
  const title = card.localized?.[getLocale()]?.title || card.title
  if (!title || /^(Approval needed|Decision needed|Notification|Task assigned|New request)$/i.test(title.trim())) {
    const text = (card.localized?.[getLocale()]?.summary || card.summary || card.sourceInstruction || 'Untitled request').split(/\n/)[0]
    return text.length > 90 ? `${text.slice(0, 87)}…` : text
  }
  return title
}
export function personName(id: string, members: Member[], userId?: string) {
  if (id === userId) return 'You'
  return members.find((m) => m.id === id)?.name || id.replace(/^(u:|email:)/, '').split('@')[0] || 'Teammate'
}
export function outcome(card: DecisionCard) {
  const action = card.decision?.action
  return action === 'reply' ? 'Responded' : action === 'acknowledge' ? (card.type === 'task' || card.type === 'revision' ? 'Completed' : 'Acknowledged') : action === 'decline' || card.status === 'rejected' ? 'Declined' : card.status === 'approved' ? (card.type === 'delegation' ? 'Accepted' : 'Approved') : card.status === 'revised' ? 'Revised' : card.status === 'delegated' ? 'Handed off' : card.status === 'pending' ? 'Awaiting response' : 'Completed'
}
function age(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000))
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}
const navigation = [{ id: 'inbox', title: 'Inbox', icon: Inbox }, { id: 'sent', title: 'Sent', icon: Send }, { id: 'completed', title: 'Completed', icon: CheckCheck }, { id: 'workspace', title: 'Workspace', icon: Users }] as const

interface Props {
  cards: DecisionCard[]; userId: string; displayName: string; members: Member[]; businesses: Business[]
  connected: boolean; loaded: boolean; sample?: boolean; view: WorkspaceView; onView: (view: WorkspaceView) => void
  selectedId: string | null; onSelect: (id: string | null) => void
  onCompose: () => void; onDecide: (id: string, action: string, options?: { replyText?: string }) => boolean
  onUndo: (id: string) => void; onNudge: (id: string) => void; onLogout: () => void
  busyCardId?: string | null; workspace?: React.ReactNode; notificationControl?: React.ReactNode; notice?: React.ReactNode
}
export function Workbench({ cards, userId, displayName, members, businesses, connected, loaded, sample, view, onView, selectedId, onSelect, onCompose, onDecide, onUndo, onNudge, onLogout, busyCardId, workspace, notificationControl, notice }: Props) {
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('all')
  const [priority, setPriority] = useState('all')
  const [sort, setSort] = useState('priority')
  const [filters, setFilters] = useState(false)
  const pending = cards.filter((c) => c.recipientUserID === userId && c.status === 'pending')
  const sent = cards.filter((c) => c.senderUserID === userId)
  const completed = cards.filter((c) => c.status !== 'pending' && (c.senderUserID === userId || c.recipientUserID === userId))
  const source = view === 'sent' ? sent : view === 'completed' ? completed : pending
  const filtered = useMemo(() => {
    const ranks = { urgent: 0, high: 1, medium: 2, low: 3 }
    return source.filter((c) => (kind === 'all' || c.type === kind) && (priority === 'all' || c.priority === priority) && [subject(c), c.summary, personName(c.senderUserID, members), personName(c.recipientUserID, members), c.business].join(' ').toLowerCase().includes(search.toLowerCase())).sort((a, b) => (sort === 'priority' ? ranks[a.priority] - ranks[b.priority] : 0) || (sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)))
  }, [source, kind, priority, members, search, sort])
  const selected = filtered.find((c) => c.id === selectedId) || null
  const active = selected || filtered[0]
  const exportCompleted = () => {
    const markdown = '# Completed requests\n\n' + filtered.map((card) => `## ${subject(card)}\n\n${outcome(card)} · ${personName(card.senderUserID, members, userId)} → ${personName(card.recipientUserID, members, userId)}\n\n${card.summary}\n\n${card.decision?.replyText || card.decision?.note || ''}\n`).join('\n');
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `honmaru-completed-${new Date().toISOString().slice(0, 10)}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const businessName = (slug?: string) => businesses.find((b) => b.slug === slug)?.name || slug
  const navigate = (next: WorkspaceView) => { onView(next); setSearch(''); setKind('all'); setPriority('all') }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement)?.closest('input, textarea, select, [role="dialog"], [contenteditable]')) return
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); onCompose() }
      if (event.key === 'Escape') onSelect(null)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!filtered.length || view === 'workspace') return
        event.preventDefault()
        const index = Math.max(0, filtered.findIndex((c) => c.id === active?.id))
        onSelect(filtered[Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].id)
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [filtered, active?.id, view, onCompose, onSelect])

  return <div className={`workbench ${selected ? 'has-selection' : ''}`}>
    <aside className="wb-sidebar">
      <a className="wb-brand" href="/" onClick={(e) => { e.preventDefault(); navigate('inbox') }}><BrandMark /><span>Honmaru<span>AI</span></span></a>
      <div className="wb-space"><span className="wb-space-icon">{sample ? 'S' : displayName.slice(0, 1)}</span><div><strong>{sample ? 'Sample workspace' : 'Your workspace'}</strong><small>{sample ? 'Local demo · no data sent' : members.length ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` : 'Loading team…'}</small></div></div>
      <nav className="wb-navigation" aria-label="Main navigation">{navigation.map(({ id, title, icon: NavIcon }) => <button key={id} className={view === id ? 'is-current' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><NavIcon size={18} /><span>{title}</span>{id === 'inbox' && pending.length > 0 && <small>{pending.length}</small>}</button>)}</nav>
      <div className="wb-sidebar-bottom"><span className={`wb-connection ${connected ? 'is-live' : ''}`}><span />{sample ? 'Sample data only' : connected ? 'Live updates connected' : 'Reconnecting…'}</span><button className="wb-profile" onClick={() => navigate('workspace')}><span className="wb-avatar">{displayName.slice(0, 1)}</span><span><strong>{displayName}</strong><small>{sample ? 'Demo account' : 'Account & settings'}</small></span><Settings2 size={16} /></button>{sample && <button className="wb-exit" onClick={onLogout}>Exit demo <ArrowUpRight size={14} /></button>}</div>
    </aside>
    <div className="wb-content">
      <header className="wb-topbar"><div><span className="wb-mobile-mark"><BrandMark /></span><span className="wb-breadcrumb">{sample ? 'Sample workspace' : 'Workspace'}<ChevronRight size={14} /></span><strong className="wb-desktop-view">{navigation.find((n) => n.id === view)?.title}</strong><strong className="wb-mobile-identity">{sample ? 'Sample workspace' : 'Honmaru AI'}</strong>{sample && <span className="wb-demo-badge">DEMO</span>}</div><div>{!sample && notificationControl}<button className="wb-new primary-button" onClick={onCompose} aria-keyshortcuts="n"><Plus size={17} /><span>New request</span></button></div></header>{notice}
      {view === 'workspace' ? <main className="wb-settings">{workspace}</main> : <main className="wb-panels">
        <section className="wb-queue" aria-label={`${view} requests`}>
          <div className="wb-queue-heading"><div><h1>{navigation.find((n) => n.id === view)?.title}</h1><span>{source.length}</span>{view === 'completed' && <button className="wb-export" aria-label="Export completed requests" title="Export current results as Markdown" disabled={!filtered.length} onClick={exportCompleted}><Download size={16} /></button>}</div><p>{view === 'inbox' ? 'Requests that need your attention' : view === 'sent' ? 'Follow the requests you’ve sent' : 'Your team’s decisions and responses'}</p></div>
          <div className="wb-queue-tools"><label className="wb-search"><Search size={17} /><input aria-label="Search requests" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requests…" />{search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}</label><div className="wb-filter-bar"><button className={filters || kind !== 'all' || priority !== 'all' ? 'is-active' : ''} onClick={() => setFilters(!filters)} aria-expanded={filters}><SlidersHorizontal size={14} />Filters{(kind !== 'all' || priority !== 'all') && <span className="filter-applied" />}</button><label><ArrowDownWideNarrow size={14} /><select aria-label="Sort requests" value={sort} onChange={(e) => setSort(e.target.value)}><option value="priority">Priority first</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label></div>{filters && <div className="wb-filters"><label>Type<select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All types</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Priority<select aria-label="Filter by priority" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="all">All priorities</option>{['urgent', 'high', 'medium', 'low'].map((p) => <option key={p}>{p}</option>)}</select></label></div>}</div>
          <div className="wb-request-list">{filtered.map((card) => <button key={card.id} className={`wb-request-row ${active?.id === card.id ? 'is-selected' : ''}`} onClick={() => onSelect(card.id)} aria-pressed={active?.id === card.id}><span className="wb-row-person"><span className="wb-avatar small">{personName(view === 'sent' ? card.recipientUserID : card.senderUserID, members, userId).slice(0, 1)}</span><span>{view === 'sent' ? 'To ' : ''}{personName(view === 'sent' ? card.recipientUserID : card.senderUserID, members, userId)}</span><time dateTime={card.createdAt}>{age(card.createdAt)}</time></span><strong>{subject(card)}</strong><span className="wb-row-summary">{card.localized?.[getLocale()]?.summary || card.summary}</span><span className="wb-row-meta"><span className={`wb-kind kind-${card.type}`}>{kindLabels[card.type]}</span>{card.status !== 'pending' ? <span className="wb-status"><Check size={12} />{outcome(card)}</span> : ['high', 'urgent'].includes(card.priority) ? <span className={`wb-priority priority-${card.priority}`}><span />{card.priority}</span> : null}{card.business && <span className="wb-row-business">{businessName(card.business)}</span>}</span></button>)}{!filtered.length && <div className="wb-list-empty"><Inbox size={25} /><strong>{!loaded ? 'Loading requests…' : search || kind !== 'all' || priority !== 'all' ? 'No matching requests' : view === 'inbox' ? 'No requests to review' : view === 'sent' ? 'No requests sent yet' : 'No completed requests yet'}</strong><p>{search || kind !== 'all' || priority !== 'all' ? 'Try a different search or clear your filters.' : view === 'inbox' ? 'Incoming requests will appear here.' : 'Your activity will appear here as you work.'}</p>{(search || kind !== 'all' || priority !== 'all') && <button onClick={() => { setSearch(''); setKind('all'); setPriority('all') }}>Clear filters</button>}</div>}</div>
          <div className="wb-queue-footer">{filtered.length} {filtered.length === 1 ? 'request' : 'requests'}<span>↑ ↓ to navigate</span></div>
        </section>
        <section className="wb-detail-panel" aria-label="Request detail">{active ? <RequestDetail key={active.id} card={active} userId={userId} members={members} business={businessName(active.business)} connected={connected && busyCardId !== active.id} sample={sample} saving={busyCardId === active.id} onBack={() => onSelect(null)} onDecide={onDecide} onUndo={onUndo} onNudge={onNudge} /> : <div className="wb-detail-empty"><span><CheckCheck size={30} /></span><h2>{!loaded ? 'Opening your workspace…' : view === 'inbox' && !source.length ? 'A clear inbox.' : 'Select a request'}</h2><p>{!loaded ? 'Your requests will appear when the connection is ready.' : view === 'inbox' && !source.length ? 'Review requests here as they arrive. Set up your workspace to bring your team together.' : 'The request, its context, and your response — together in one place.'}</p>{loaded && !source.length && view === 'inbox' && <button onClick={() => navigate('workspace')}>Set up workspace <ArrowUpRight size={16} /></button>}</div>}</section>
      </main>}
      <nav className="wb-mobile-nav" aria-label="Mobile navigation">{navigation.map(({ id, title, icon: NavIcon }) => <button key={id} className={view === id ? 'is-current' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><NavIcon size={20} /><span>{title}</span></button>)}</nav>
    </div>
  </div>
}

function RequestDetail({ card, userId, members, business, connected, sample, saving, onBack, onDecide, onUndo, onNudge }: { card: DecisionCard; userId: string; members: Member[]; business?: string; connected: boolean; sample?: boolean; saving?: boolean; onBack: () => void; onDecide: Props['onDecide']; onUndo: Props['onUndo']; onNudge: Props['onNudge'] }) {
  const [replying, setReplying] = useState(false), [reply, setReply] = useState('')
  const pending = card.status === 'pending', canAct = pending && card.recipientUserID === userId
  const localized = card.localized?.[getLocale()]
  const context = requestContext(card, localized?.context || card.context || '').join('\n\n')
  const primary = card.type === 'notification' ? 'Acknowledge' : card.type === 'task' ? 'Complete task' : card.type === 'delegation' ? 'Accept handoff' : card.type === 'revision' ? 'Complete revision' : 'Approve'
  return <>
    <div className="wb-detail-top"><button className="wb-back" onClick={onBack}><ArrowLeft size={17} />Back</button><span>{kindLabels[card.type]} request</span><span className={`wb-detail-state ${pending ? '' : 'is-complete'}`}>{pending ? <Circle size={13} /> : <CheckCheck size={15} />}{outcome(card)}</span></div>
    <article className="wb-detail-body"><div className="wb-detail-tags"><span className={`wb-kind kind-${card.type}`}>{kindLabels[card.type]}</span>{business && <span className="wb-business">{business}</span>}<span className={`wb-priority priority-${card.priority}`}><span />{card.priority} priority</span></div><h2>{subject(card)}</h2><div className="wb-request-people"><span className="wb-avatar">{personName(card.senderUserID, members, userId).slice(0, 1)}</span><div><strong>{personName(card.senderUserID, members, userId)}<span>to</span>{personName(card.recipientUserID, members, userId)}</strong><small><Clock3 size={12} />{new Date(card.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{card.sourceApp && <> · {card.sourceApp}</>}</small></div></div><section className="wb-request-section"><h3>{card.type === 'notification' ? 'What to know' : 'The request'}</h3><p>{localized?.summary || card.summary || card.sourceInstruction || 'No additional description provided.'}</p></section>{context && <section className="wb-context-section"><h3>Background</h3><p>{context}</p></section>}{card.sourceInstruction && card.sourceInstruction !== (localized?.summary || card.summary) && <details className="wb-original"><summary>Original request</summary><p>{card.sourceInstruction}</p></details>}{card.originalBody && <details className="wb-original"><summary>Original text{card.originalLanguage ? ` · ${card.originalLanguage}` : ''}</summary><p>{card.originalBody}</p></details>}{card.githubIssueURL && /^https?:\/\//.test(card.githubIssueURL) && <a className="wb-source-link" href={card.githubIssueURL} target="_blank" rel="noreferrer">View source on GitHub <ArrowUpRight size={15} /></a>}{!pending && <section className="wb-outcome"><CheckCheck size={19} /><div><h3>{outcome(card)}</h3><p>{personName(card.decision?.actorUserID || card.recipientUserID, members, userId)}{card.decision?.decidedAt && ` · ${new Date(card.decision.decidedAt).toLocaleString()}`}</p>{card.decision?.replyText && <blockquote>{card.decision.replyText}</blockquote>}{card.decision?.note && <blockquote>{card.decision.note}</blockquote>}</div></section>}</article>
    <footer className="wb-detail-actions">{canAct ? replying ? <form onSubmit={(e) => { e.preventDefault(); if (reply.trim() && onDecide(card.id, 'reply', { replyText: reply.trim() })) { setReplying(false); setReply('') } }}><label htmlFor="request-response">Your response</label><textarea id="request-response" autoFocus rows={3} maxLength={10000} placeholder="Write a clear answer for your teammate…" value={reply} onChange={(e) => setReply(e.target.value)} /><p>{sample ? 'Demo response stays in this browser session.' : 'Sending a response marks this request as completed.'}</p><div><button type="button" onClick={() => setReplying(false)}>Cancel</button><button className="primary-button" disabled={!reply.trim() || !connected}><Send size={16} />Send response</button></div></form> : <><div className="wb-action-caption">{saving ? 'Saving your response…' : sample ? 'Demo: saved locally. No messages or notifications are sent.' : connected ? 'Your response will be shared with the sender.' : 'Reconnect to save a response.'}</div><div className="wb-action-buttons">{card.type !== 'notification' && <button className="wb-decline" disabled={!connected} onClick={() => onDecide(card.id, 'decline')}>Decline</button>}<button disabled={!connected} onClick={() => setReplying(true)}><MessageSquare size={16} />Respond</button><button className="primary-button" disabled={!connected} onClick={() => onDecide(card.id, card.type === 'notification' ? 'acknowledge' : card.type === 'revision' || card.type === 'task' ? 'acknowledge' : 'approve')}><Check size={17} />{primary}</button></div></> : !pending && card.recipientUserID === userId ? <div className="wb-action-buttons"><span className="wb-action-caption">{sample ? 'Completed locally in the sample workspace.' : 'Undo reopens this request; external source changes are not reversed.'}</span><button disabled={!connected} onClick={() => onUndo(card.id)}><Undo2 size={16} />Undo response</button></div> : <div className="wb-action-buttons"><span className="wb-action-caption">{pending ? `Waiting for ${personName(card.recipientUserID, members, userId)}` : 'Response received'}</span>{pending && card.senderUserID === userId && <button disabled={!connected} onClick={() => onNudge(card.id)}><Bell size={16} />Send reminder</button>}</div>}</footer>
  </>
}
