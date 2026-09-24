import React, { useMemo, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName, properName } from '../utils/names'
import { Icon } from './Icon'
import { BrandLogo, isBrand } from './BrandLogo'
import { useT } from '../utils/i18n'

/// What was done, as a word rather than the verb the API uses — the same
/// table History reads from, so one decision is not "approve" here and
/// "Approved" one screen away. English keys, translated where they are read.
const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred', pending: 'Waiting',
}
const actionWord = (value?: string) => (value ? ACTION_WORD[value] || value : '')

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

/// One conversation in the list: a channel (a business), a person, or an app.
interface Thread {
  key: string
  kind: 'channel' | 'person' | 'app'
  name: string
  /// The login a presence event names — only a person has one.
  login?: string
  icon?: 'mail' | 'notion' | 'github' | 'box' | 'plus'
  /// The business slug, for a channel.
  slug?: string
  /// The connector id, for an app: gmail, slack, notion, github, ai.
  app?: string
  cards: DecisionCard[]
  unread: number
  /// The newest card, when there is one — an empty channel has none.
  latest?: DecisionCard
}

function when(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const stamp = (c: DecisionCard) => [c.lastCommentAt || '', c.decision?.decidedAt || '', c.createdAt].sort().pop() || c.createdAt
const newestFirst = (a: DecisionCard, b: DecisionCard) => stamp(b).localeCompare(stamp(a))

const APP_ICON: Record<string, Thread['icon']> = { gmail: 'mail', email: 'mail', slack: 'box', notion: 'notion', github: 'github' }
const APP_NAME: Record<string, string> = { gmail: 'Gmail', email: 'Email', slack: 'Slack', notion: 'Notion', github: 'GitHub' }

/// The same decisions, laid out the way a chat client lays out a workspace:
/// channels are the team's businesses, direct messages are the people you
/// trade decisions with, apps are where the rest came in from. A row in bold
/// with a count is a conversation with something waiting on you; opening it
/// lists the decisions in it, and each of those opens as a card.
///
/// It is deliberately the same data as the card feed: everything here can be
/// opened as a card, and nothing here exists that the feed does not know
/// about. Presence is the relay's, not invented.
export const ClassicList: React.FC<Props> = ({
  userId, orgName, pending, sent, decided, businesses, presence,
  onOpen, onNudge, onSearch, onCompose, onWorkspace, workspaceMenu,
  onCreateChannel, onRenameChannel, onDeleteChannel,
}) => {
  const t = useT()
  const locale = getLocale()
  const titleOf = (c: DecisionCard) => c.localized?.[locale]?.title || c.title
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
      const app = c.sourceApp ? String(c.sourceApp).toLowerCase() : ''
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
        app === 'ai' ? t('Your AI') : (APP_NAME[app] || app.charAt(0).toUpperCase() + app.slice(1)),
        { icon: app === 'ai' ? 'plus' : (APP_ICON[app] || 'box'), app }, own))
      .filter((x): x is Thread => x !== null)

    return { channels, people, apps }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, sent, decided, businesses, userId, locale])

  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  // Making a channel, renaming one: the box, its text, and what went wrong.
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const toggle = (thread: Thread) => {
    // One decision is one tap: a thread with a single card opens the card.
    // A channel always opens as a channel, so its own controls are reachable.
    if (thread.kind !== 'channel' && thread.cards.length === 1) { onOpen(thread.cards[0].id); return }
    setOpen((prev) => ({ ...prev, [thread.key]: !prev[thread.key] }))
  }
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
    if (err) setProblem(err)
  }

  const preview = (thread: Thread) => {
    const c = thread.latest
    if (!c) return t('No decisions here yet.')
    const title = titleOf(c) + (c.commentCount ? ` · ${t('{n} replies', { n: c.commentCount })}` : '')
    if (isMine(c)) {
      return c.status === 'pending'
        ? t('You: {title}', { title })
        : `${t(actionWord(c.decision?.action || c.status))} · ${title}`
    }
    if (isUnread(c)) return title
    return `${t(actionWord(c.decision?.action || c.status))} · ${title}`
  }

  const CardRow: React.FC<{ card: DecisionCard }> = ({ card }) => {
    const mine = isMine(card)
    const meta = mine
      ? (card.status === 'pending'
        ? t('Waiting on {name}', { name: displayName(card.recipientUserID) })
        : t(actionWord(card.decision?.action || card.status)))
      : (isUnread(card)
        ? `${displayName(card.requestedBy?.name || card.senderUserID)}${nameOfBusiness(card.business) ? ` · ${nameOfBusiness(card.business)}` : ''}`
        : t(actionWord(card.decision?.action || card.status)))
    return (
      <li className={`cl-row cl-card${isUnread(card) ? ' unread' : ''}`}>
        <button className="cl-open" onClick={() => onOpen(card.id)}>
          <span className="cl-lead cl-dot-lead" aria-hidden="true">{isUnread(card) ? <span className="cl-unread-dot" /> : null}</span>
          <span className="cl-text">
            <span className="cl-line">
              <span className="cl-title">{titleOf(card)}</span>
              <span className="cl-when">{when(stamp(card))}</span>
            </span>
            <span className="cl-meta">{meta}{card.commentCount ? ` · ${t('{n} replies', { n: card.commentCount })}` : ''}</span>
          </span>
          {(card.priority === 'urgent' || card.priority === 'high') && isUnread(card) && (
            <span className="cl-badge cl-priority">{t(card.priority === 'urgent' ? 'Urgent' : 'High')}</span>
          )}
        </button>
        {mine && card.status === 'pending' && (
          <button className="cl-nudge" onClick={() => onNudge(card.id)}>{t('Nudge')}</button>
        )}
      </li>
    )
  }

  const ThreadRow: React.FC<{ thread: Thread }> = ({ thread }) => {
    const expanded = Boolean(open[thread.key])
    const online = thread.login ? presence[thread.login] === 'online' : false
    return (
      <li className={`cl-row cl-thread${thread.unread ? ' unread' : ''}${expanded ? ' expanded' : ''}`}>
        <button
          className="cl-open"
          onClick={() => toggle(thread)}
          aria-expanded={thread.cards.length > 1 ? expanded : undefined}
        >
          {thread.kind === 'channel' && <span className="cl-lead cl-hash" aria-hidden="true">#</span>}
          {thread.kind === 'person' && (
            <span className="cl-lead cl-avatar" aria-hidden="true">
              {thread.name.charAt(0).toUpperCase()}
              <span className={`cl-presence${online ? ' on' : ''}`} />
            </span>
          )}
          {thread.kind === 'app' && (
            <span className="cl-lead cl-app" aria-hidden="true">
              {thread.app === 'ai'
                ? <img className="cl-own-mark" src="/icon.svg" alt="" width={32} height={32} />
                : thread.app && isBrand(thread.app) ? <BrandLogo brand={thread.app} size={18} /> : <Icon name={thread.icon || 'box'} size={16} />}
            </span>
          )}
          <span className="cl-text">
            <span className="cl-line">
              <span className="cl-title">{thread.name}</span>
              {thread.latest && <span className="cl-when">{when(stamp(thread.latest))}</span>}
            </span>
            <span className="cl-meta">{preview(thread)}</span>
          </span>
          {thread.unread > 0 && <span className="cl-badge">{thread.unread}</span>}
          {thread.unread === 0 && thread.cards.length > 1 && (
            <span className="cl-count" aria-label={t('{n} decisions', { n: thread.cards.length })}>{thread.cards.length}</span>
          )}
        </button>
        {expanded && (
          <ul className="cl-thread-cards">
            {thread.kind === 'channel' && thread.slug && (
              <li className="cl-channel-tools">
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
              </li>
            )}
            {thread.cards.map((c) => <CardRow key={c.id} card={c} />)}
          </ul>
        )}
      </li>
    )
  }

  const Section: React.FC<{ id: string; label: string; threads: Thread[]; empty: string; action?: React.ReactNode; below?: React.ReactNode }> = ({ id, label, threads, empty, action, below }) => {
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
        {!shut && threads.length > 0 && <ul>{threads.map((th) => <ThreadRow key={th.key} thread={th} />)}</ul>}
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

  const waiting = pending.length

  return (
    <div className="classic">
      <div className="classic-inner">
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
          <Icon name="search" size={15} />
          <span>{t('Jump to or search…')}</span>
        </button>
        {waiting > 0 && (
          <p className="cl-summary" role="status">{t('{n} waiting on you', { n: waiting })}</p>
        )}

        {problem && <p className="cl-problem" role="alert">{problem}</p>}
        <Section id="channels" label={t('Channels')} threads={channels} empty={t('No channels yet. Make one, or let your AI file decisions under a business as they arrive.')} action={addChannel} below={addChannelForm} />
        <Section id="people" label={t('Direct messages')} threads={people} empty={t('Nobody has sent you a decision yet.')} />
        <Section id="apps" label={t('Apps')} threads={apps} empty={t('Connect Gmail or Slack under Tools and their decisions land here.')} />
      </div>
    </div>
  )
}
