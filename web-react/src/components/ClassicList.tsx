import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName, properName } from '../utils/names'
import { Icon } from './Icon'
import { BrandLogo, isBrand } from './BrandLogo'
import { useT } from '../utils/i18n'
import './ClassicList.css'

/// What was done, as a word rather than the verb the API uses — the same
/// table History reads from, so one decision is not "approve" here and
/// "Approved" one screen away. English keys, translated where they are read.
const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred', pending: 'Waiting',
  approved: 'Approved', rejected: 'Declined', revised: 'Revision asked',
  delegated: 'Delegated', completed: 'Acknowledged',
}
const actionWord = (value?: string) => (value ? ACTION_WORD[value] || value : '')

/// The recipient's name when the relay stamped one, else their login.
const recipientNameOf = (c: DecisionCard) => (c as DecisionCard & { recipientName?: string }).recipientName || c.recipientUserID

export type Presence = Record<string, 'online' | 'offline'>

interface Props {
  userId: string
  orgName: string
  pending: DecisionCard[]
  sent: DecisionCard[]
  decided: DecisionCard[]
  businesses: Business[]
  presence: Presence
  onOpen: (cardId: string) => void
  onNudge: (cardId: string) => void
  onSearch: () => void
  onCompose: () => void
  onWorkspace: () => void
  /// The workspace's mark, name and switcher, drawn by the shell.
  workspaceMenu?: React.ReactNode
  /// Channels are the team's businesses: made, renamed and deleted here,
  /// the way a chat client lets you. Each returns what went wrong, if
  /// anything, as a sentence.
  onCreateChannel: (name: string) => Promise<string | null>
  onRenameChannel: (slug: string, name: string) => Promise<string | null>
  onDeleteChannel: (slug: string) => Promise<string | null>
}

/// One conversation in the sidebar: a channel (a business), a person, or an app.
interface Thread {
  key: string
  kind: 'channel' | 'person' | 'app'
  name: string
  /// The login a presence event names — only a person has one.
  login?: string
  icon?: 'mail' | 'notion' | 'github' | 'box' | 'plus' | 'repeat' | 'terminal'
  /// The business slug, for a channel.
  slug?: string
  /// The connector id, for an app: gmail, slack, notion, github, ai.
  app?: string
  /// Newest first, as the sidebar reads them; the conversation reverses.
  cards: DecisionCard[]
  unread: number
  latest?: DecisionCard
}

const stamp = (c: DecisionCard) => [c.lastCommentAt || '', c.decision?.decidedAt || '', c.createdAt].sort().pop() || c.createdAt
const newestFirst = (a: DecisionCard, b: DecisionCard) => stamp(b).localeCompare(stamp(a))

const APP_ICON: Record<string, Thread['icon']> = { gmail: 'mail', email: 'mail', slack: 'box', notion: 'notion', github: 'github', routine: 'repeat', agent: 'terminal' }
/// English keys, translated where read: an automation's report and an
/// agent's question are the AI's own apps, not somebody's product name.
const APP_NAME: Record<string, string> = { gmail: 'Gmail', email: 'Email', slack: 'Slack', notion: 'Notion', github: 'GitHub', routine: 'Automations', agent: 'Agents' }

/// Which app a card came in through, as the sidebar groups it. Your AI's
/// own proposals sit with everything else your AI brought you.
const appKey = (c: DecisionCard) => {
  const app = c.sourceApp ? String(c.sourceApp).toLowerCase() : ''
  return app === 'your ai' ? 'ai' : app
}

const WIDE = '(min-width: 720px)'
const isWide = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches

function clock(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/// The newest activity on a row, as a chat client shows it: the time today,
/// the date before that.
function when(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString()
    ? clock(iso)
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/// The workspace laid out the way a chat client lays it out — and the one
/// place in this product that deliberately does. On the left, channels are
/// the team's businesses, direct messages are the people you trade
/// decisions with, apps are where the rest came in from. On the right, the
/// conversation you picked: its decisions in the order they happened, each
/// one a message with who asked, what, and where it stands. A decision
/// still opens as a card, where it is decided — the conversation is how you
/// find it and see it in context, never a second place to decide.
///
/// It is the same data as the card feed: everything here opens as a card,
/// and nothing here exists that the feed does not know about. Presence is
/// the relay's, not invented. On a phone it is one pane at a time: the
/// sidebar, then the conversation with a way back.
export const ClassicList: React.FC<Props> = ({
  userId, orgName, pending, sent, decided, businesses, presence,
  onOpen, onNudge, onSearch, onCompose, onWorkspace, workspaceMenu,
  onCreateChannel, onRenameChannel, onDeleteChannel,
}) => {
  const t = useT()
  const locale = getLocale()
  const titleOf = (c: DecisionCard) => c.localized?.[locale]?.title || c.title
  const summaryOf = (c: DecisionCard) => c.localized?.[locale]?.summary || c.summary
  const nameOfBusiness = (slug?: string) => businesses.find((b) => b.slug === slug)?.name || slug || ''
  const isMine = (c: DecisionCard) => c.senderUserID === userId && c.recipientUserID !== userId
  const isUnread = (c: DecisionCard) => c.status === 'pending' && c.recipientUserID === userId

  const { channels, people, apps } = useMemo(() => {
    const all = new Map<string, DecisionCard>()
    for (const c of [...pending, ...sent, ...decided]) all.set(c.id, c)
    const cards = [...all.values()].sort(newestFirst)

    const build = (kind: Thread['kind'], key: string, name: string, extra: Partial<Thread>, own: DecisionCard[], keepEmpty = false): Thread | null => {
      if (!own.length && !keepEmpty) return null
      return { key, kind, name, cards: own, unread: own.filter(isUnread).length, latest: own[0], ...extra }
    }

    // Channels: one per business the team has, in the team's order — empty
    // ones too, a channel just made is a channel — plus any slug a card
    // names that the table has not caught up with yet.
    const bySlug = new Map<string, DecisionCard[]>()
    for (const c of cards) if (c.business) bySlug.set(c.business, [...(bySlug.get(c.business) || []), c])
    const slugs = [...businesses.map((b) => b.slug), ...[...bySlug.keys()].filter((s) => !businesses.some((b) => b.slug === s))]
    const channels = slugs
      .map((slug) => build('channel', `channel:${slug}`, nameOfBusiness(slug), { slug }, bySlug.get(slug) || [], true))
      .filter((x): x is Thread => x !== null)

    // Direct messages: the other party on every card that came from a person
    // rather than a connected app. A card you sent yourself is your AI's.
    const byPerson = new Map<string, DecisionCard[]>()
    const byApp = new Map<string, DecisionCard[]>()
    for (const c of cards) {
      const app = appKey(c)
      if (app) { byApp.set(app, [...(byApp.get(app) || []), c]); continue }
      const other = c.senderUserID === userId ? c.recipientUserID : c.senderUserID
      if (!other || other === userId) { byApp.set('ai', [...(byApp.get('ai') || []), c]); continue }
      byPerson.set(other, [...(byPerson.get(other) || []), c])
    }
    const personName = (login: string, own: DecisionCard[]) => {
      const named = own.find((c) => c.senderUserID === login && c.requestedBy?.name)
      return named?.requestedBy?.name || properName(login)
    }
    const people = [...byPerson.entries()]
      .map(([login, own]) => build('person', `person:${login}`, personName(login, own), { login }, own))
      .filter((x): x is Thread => x !== null)
      .sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || stamp(b.latest!).localeCompare(stamp(a.latest!)))

    const apps = [...byApp.entries()]
      .map(([app, own]) => build('app', `app:${app}`,
        app === 'ai' ? t('Your AI') : (APP_NAME[app] ? t(APP_NAME[app]) : app.charAt(0).toUpperCase() + app.slice(1)),
        { icon: app === 'ai' ? 'plus' : (APP_ICON[app] || 'box'), app }, own))
      .filter((x): x is Thread => x !== null)

    return { channels, people, apps }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, sent, decided, businesses, userId, locale])

  const everything = useMemo(() => [...channels, ...people, ...apps], [channels, people, apps])

  // Which conversation is open. On a laptop one always is — the first with
  // something waiting on you, else the first there is — the way a chat
  // client never shows an empty right half. On a phone none is until tapped.
  const [openKey, setOpenKey] = useState<string | null>(() => {
    if (!isWide()) return null
    try { return sessionStorage.getItem('list.open') } catch { return null }
  })
  const [wide, setWide] = useState(isWide)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(WIDE)
    const on = () => setWide(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  const current = everything.find((th) => th.key === openKey)
    || (wide ? (everything.find((th) => th.unread > 0) || everything[0]) : undefined)
  const choose = (key: string | null) => {
    setOpenKey(key)
    setProblem(null)
    setRenaming(null)
    setSettings(false)
    try { if (key) sessionStorage.setItem('list.open', key); else sessionStorage.removeItem('list.open') } catch {}
  }

  const [folded, setFolded] = useState<Record<string, boolean>>({})
  // Making a channel, renaming one: the box, its text, and what went wrong.
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The channel's own controls, behind ⋯ — as in a chat client, not in the way.
  const [settings, setSettings] = useState(false)

  const createChannel = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true); setProblem(null)
    const err = await onCreateChannel(name)
    setBusy(false)
    if (err) { setProblem(err); return }
    setNewName(''); setAdding(false)
  }
  const renameChannel = async (slug: string) => {
    const name = renameTo.trim()
    if (!name || busy) { setRenaming(null); return }
    setBusy(true); setProblem(null)
    const err = await onRenameChannel(slug, name)
    setBusy(false)
    if (err) { setProblem(err); return }
    setRenaming(null)
  }
  const deleteChannel = async (thread: Thread) => {
    if (!thread.slug || busy) return
    const ask = thread.cards.length
      ? t('Delete #{name}? Its {n} decisions stay, unfiled.', { name: thread.name, n: thread.cards.length })
      : t('Delete #{name}?', { name: thread.name })
    if (!window.confirm(ask)) return
    setBusy(true); setProblem(null)
    const err = await onDeleteChannel(thread.slug)
    setBusy(false)
    if (err) { setProblem(err); return }
    choose(null)
  }

  // The newest message in view when a conversation opens, as in any chat.
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [current?.key, current?.cards.length])

  // ---- The sidebar ----

  const lead = (thread: Thread, size: 'row' | 'head') => {
    const online = thread.login ? presence[thread.login] === 'online' : false
    if (thread.kind === 'channel') return <span className={`cl-lead cl-hash sz-${size}`} aria-hidden="true">#</span>
    if (thread.kind === 'person') {
      return (
        <span className={`cl-lead cl-avatar sz-${size}`} aria-hidden="true">
          {thread.name.charAt(0).toUpperCase()}
          <span className={`cl-presence${online ? ' on' : ''}`} />
        </span>
      )
    }
    return (
      <span className={`cl-lead cl-app sz-${size}`} aria-hidden="true">
        {thread.app === 'ai'
          ? <img className="cl-own-mark" src="/icon.svg" alt="" width={20} height={20} />
          : thread.app && isBrand(thread.app) ? <BrandLogo brand={thread.app} size={size === 'head' ? 18 : 14} /> : <Icon name={thread.icon || 'box'} size={14} />}
      </span>
    )
  }

  const row = (thread: Thread) => {
    const on = current?.key === thread.key
    return (
      <li key={thread.key} className={`cl-row cl-thread${thread.unread ? ' unread' : ''}${on ? ' on' : ''}`}>
        <button className="cl-open" onClick={() => choose(thread.key)} aria-current={on ? 'true' : undefined}>
          {lead(thread, 'row')}
          <span className="cl-title">{thread.name}</span>
          {thread.unread > 0 && <span className="cl-badge">{thread.unread}</span>}
        </button>
      </li>
    )
  }

  const section = (id: string, label: string, threads: Thread[], empty: string, action?: React.ReactNode, below?: React.ReactNode) => {
    const shut = Boolean(folded[id])
    const unread = threads.reduce((n, th) => n + th.unread, 0)
    return (
      <section className={`cl-section${shut ? ' folded' : ''}`}>
        <h2>
          <button className="cl-fold" onClick={() => setFolded((p) => ({ ...p, [id]: !p[id] }))} aria-expanded={!shut}>
            <span className="cl-caret" aria-hidden="true">{shut ? '▸' : '▾'}</span>
            {label}
            {shut && unread > 0 && <span className="cl-badge">{unread}</span>}
          </button>
          {action}
        </h2>
        {!shut && threads.length === 0 && <p className="cl-empty">{empty}</p>}
        {!shut && threads.length > 0 && <ul>{threads.map(row)}</ul>}
        {!shut && below}
      </section>
    )
  }

  const addChannel = (
    <button type="button" className="cl-add" onClick={() => { setAdding((a) => !a); setProblem(null) }} aria-label={t('New channel')} aria-expanded={adding}>
      <Icon name="plus" size={14} />
    </button>
  )
  const addChannelForm = adding ? (
    <form className="cl-inline-form cl-add-form" onSubmit={(e) => { e.preventDefault(); void createChannel() }}>
      <span className="cl-hash-small" aria-hidden="true">#</span>
      <input
        className="cl-input"
        value={newName}
        autoFocus
        maxLength={120}
        placeholder={t('e.g. hotel, suppliers, marketing')}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setNewName('') } }}
        aria-label={t('Channel name')}
        disabled={busy}
      />
      <button type="submit" className="cl-nudge" disabled={busy || !newName.trim()}>{busy ? t('Creating…') : t('Create')}</button>
    </form>
  ) : null

  // ---- The conversation ----

  /// Who a decision is from, as the message's author: the app it came in
  /// through, your AI for one you routed to yourself, else the person.
  const author = (c: DecisionCard) => {
    const app = appKey(c)
    if (app) return { name: app === 'ai' ? t('Your AI') : (APP_NAME[app] ? t(APP_NAME[app]) : c.sourceApp!), app, initial: '' }
    if (c.senderUserID === userId && c.recipientUserID === userId) return { name: t('Your AI'), app: 'ai', initial: '' }
    const name = c.senderUserID === userId ? t('You') : (c.requestedBy?.name || properName(c.senderUserID))
    return { name, app: '', initial: name.charAt(0).toUpperCase() }
  }

  const status = (c: DecisionCard) => {
    if (c.status === 'pending') {
      if (c.recipientUserID === userId) return { tone: 'waiting', text: t('Waiting on you') }
      return { tone: 'sent', text: t('Waiting on {name}', { name: properName(recipientNameOf(c)) }) }
    }
    const decider = c.decision?.actorUserID
    const who = decider === userId ? t('you') : properName(decider || c.recipientUserID)
    return { tone: c.status === 'rejected' ? 'declined' : 'decided', text: t('{action} by {name}', { action: t(actionWord(c.decision?.action || c.status)), name: who }) }
  }

  const dayLabel = (iso: string) => {
    const d = new Date(Date.parse(iso))
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86400000)
    if (d.toDateString() === today.toDateString()) return t('Today')
    if (d.toDateString() === yesterday.toDateString()) return t('Yesterday')
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  }

  const message = (c: DecisionCard, joined: boolean) => {
    const who = author(c)
    const s = status(c)
    const note = c.decision?.note || c.decision?.replyText
    const summary = summaryOf(c)
    const to = c.senderUserID === userId && c.recipientUserID !== userId ? properName(recipientNameOf(c)) : ''
    return (
      <article key={c.id} className={`slk-msg${joined ? ' joined' : ''}${isUnread(c) ? ' unread' : ''}`}>
        <div className="slk-gutter" aria-hidden="true">
          {joined
            ? <span className="slk-hover-time">{clock(c.createdAt)}</span>
            : who.app
              ? <span className="slk-avatar app">{who.app === 'ai'
                  ? <img src="/icon.svg" alt="" width={36} height={36} />
                  : isBrand(who.app) ? <BrandLogo brand={who.app} size={20} /> : <Icon name={APP_ICON[who.app] || 'box'} size={18} />}</span>
              : <span className="slk-avatar">{who.initial}</span>}
        </div>
        <div className="slk-body">
          {!joined && (
            <div className="slk-meta">
              <span className="slk-author">{who.name}</span>
              {to && <span className="slk-to">→ {to}</span>}
              <time className="slk-time" dateTime={c.createdAt}>{clock(c.createdAt)}</time>
            </div>
          )}
          <button className="slk-title" onClick={() => onOpen(c.id)}>
            {(c.priority === 'urgent' || c.priority === 'high') && c.status === 'pending' && (
              <span className={`slk-chip ${c.priority}`}>{t(c.priority === 'urgent' ? 'Urgent' : 'High')}</span>
            )}
            {c.report && <span className="slk-chip report">{t('Report')}</span>}
            {c.proposal && <span className="slk-chip proposal">{t('Proposal')}</span>}
            <span>{titleOf(c)}</span>
          </button>
          {summary && <p className="slk-summary">{summary}</p>}
          <div className={`slk-attach ${s.tone}`}>
            <span className="slk-status">{s.text}</span>
            {note && <span className="slk-note">“{note}”</span>}
          </div>
          <div className="slk-actions">
            {isUnread(c) && <button className="slk-action primary" onClick={() => onOpen(c.id)}>{t('Decide')}</button>}
            {!isUnread(c) && <button className="slk-action" onClick={() => onOpen(c.id)}>{t('Open')}</button>}
            {isMine(c) && c.status === 'pending' && <button className="slk-action" onClick={() => onNudge(c.id)}>{t('Nudge')}</button>}
            {Boolean(c.commentCount) && (
              <button className="slk-replies" onClick={() => onOpen(c.id)}>{c.commentCount === 1 ? t('1 reply') : t('{n} replies', { n: c.commentCount! })}</button>
            )}
            {c.business && current?.kind !== 'channel' && <span className="slk-where">#{nameOfBusiness(c.business)}</span>}
          </div>
        </div>
      </article>
    )
  }

  const conversation = (thread: Thread) => {
    const inOrder = [...thread.cards].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const out: React.ReactNode[] = []
    let day = ''
    let prev: DecisionCard | null = null
    for (const c of inOrder) {
      const d = new Date(Date.parse(c.createdAt)).toDateString()
      if (d !== day) {
        day = d
        prev = null
        out.push(<div key={`day-${d}`} className="slk-day" role="separator"><span>{dayLabel(c.createdAt)}</span></div>)
      }
      // One author, a few minutes apart: one block, as a chat client groups it.
      const joined = Boolean(prev && author(prev).name === author(c).name
        && Date.parse(c.createdAt) - Date.parse(prev.createdAt) < 5 * 60000)
      out.push(message(c, joined))
      prev = c
    }
    const waitingHere = thread.cards.filter(isUnread).length
    return (
      <>
        <header className="slk-head">
          <button className="slk-back" onClick={() => choose(null)} aria-label={t('Back')}>
            <span aria-hidden="true">‹</span>
          </button>
          {lead(thread, 'head')}
          <div className="slk-head-text">
            <h1>{thread.name}</h1>
            <p>
              {thread.cards.length ? t('{n} decisions', { n: thread.cards.length }) : t('No decisions here yet.')}
              {waitingHere > 0 && <> · <b>{t('{n} waiting on you', { n: waitingHere })}</b></>}
            </p>
          </div>
          {thread.kind === 'channel' && thread.slug && (
            <button
              className="slk-more"
              onClick={() => { setSettings((v) => !v); setRenaming(null) }}
              aria-label={t('Channel settings')}
              aria-expanded={settings}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          )}
        </header>
        {settings && thread.kind === 'channel' && thread.slug && (
          <div className="cl-channel-tools">
            {renaming === thread.slug ? (
              <form className="cl-inline-form" onSubmit={(e) => { e.preventDefault(); void renameChannel(thread.slug!) }}>
                <input
                  className="cl-input"
                  value={renameTo}
                  autoFocus
                  maxLength={120}
                  onChange={(e) => setRenameTo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null) }}
                  aria-label={t('Channel name')}
                  disabled={busy}
                />
                <button type="submit" className="cl-nudge" disabled={busy || !renameTo.trim()}>{t('Save')}</button>
                <button type="button" className="cl-nudge" onClick={() => setRenaming(null)}>{t('Cancel')}</button>
              </form>
            ) : (
              <>
                <button type="button" className="cl-nudge" onClick={() => { setRenaming(thread.slug!); setRenameTo(thread.name) }}>{t('Rename')}</button>
                <button type="button" className="cl-nudge cl-danger" onClick={() => void deleteChannel(thread)}>{t('Delete channel')}</button>
              </>
            )}
          </div>
        )}
        {problem && <p className="cl-problem" role="alert">{problem}</p>}
        <div className="slk-log" ref={logRef}>
          {inOrder.length === 0 ? (
            <div className="slk-start">
              {lead(thread, 'head')}
              <h2>{thread.kind === 'channel' ? t('This is the start of #{name}', { name: thread.name }) : thread.name}</h2>
              <p>{thread.kind === 'channel'
                ? t('Decisions about {name} land here — filed by your AI as they arrive, or by you.', { name: thread.name })
                : t('No decisions here yet.')}</p>
            </div>
          ) : out}
        </div>
        <button className="slk-compose" onClick={onCompose}>
          <Icon name="plus" size={15} />
          <span>{thread.kind === 'channel'
            ? t('Tell your AI about #{name}…', { name: thread.name })
            : thread.kind === 'person'
              ? t('Ask {name} for a decision…', { name: thread.name })
              : t('Tell your AI…')}</span>
        </button>
      </>
    )
  }

  const waiting = pending.length

  return (
    <div className={`classic slk${current ? ' in-thread' : ''}`}>
      <aside className="slk-side" aria-label={t('Conversations')}>
        <header className="cl-top">
          {workspaceMenu || (
            <button className="cl-workspace" onClick={onWorkspace} aria-label={t('Team')}>
              <span className="cl-workspace-name">{orgName || t('Your team')}</span>
              <span className="cl-caret" aria-hidden="true">▾</span>
            </button>
          )}
          <div className="cl-top-actions">
            <button className="cl-icon-button" onClick={onCompose} aria-label={t('Tell your AI')}><Icon name="plus" size={16} /></button>
          </div>
        </header>
        <button className="cl-search" onClick={onSearch} aria-keyshortcuts="Meta+K Control+K">
          <Icon name="search" size={14} />
          <span>{t('Jump to or search…')}</span>
        </button>
        {waiting > 0 && <p className="cl-summary" role="status">{t('{n} waiting on you', { n: waiting })}</p>}
        {!current && problem && <p className="cl-problem" role="alert">{problem}</p>}
        <nav className="slk-sections">
          {section('channels', t('Channels'), channels, t('No channels yet. Make one, or let your AI file decisions under a business as they arrive.'), addChannel, addChannelForm)}
          {section('people', t('Direct messages'), people, t('Nobody has sent you a decision yet.'))}
          {section('apps', t('Apps'), apps, t('Connect Gmail or Slack under Tools and their decisions land here.'))}
        </nav>
      </aside>
      <main className="slk-main">
        {current ? conversation(current) : (
          <div className="slk-none"><p>{t('Pick a conversation.')}</p></div>
        )}
      </main>
    </div>
  )
}
