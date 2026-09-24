import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DecisionCard, Business, ChannelMessage } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName, properName } from '../utils/names'
import { Icon } from './Icon'
import { BrandLogo, isBrand } from './BrandLogo'
import { useT } from '../utils/i18n'
import { useMembers } from '../utils/mentions'
import { useMentionMenu } from './MentionMenu'
import { MessageActions, Reactions, EmojiPicker, FormatBar, renderRich, SlashMenu, SchedulePicker, parseScheduleCommand } from './MessageParts'
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
  /// Decide a card where it is shown, the way a chat app's buttons do.
  onDecide: (cardId: string, action: string) => void
  /// Where the channels' messages come from.
  api: { httpBase: string; orgId: string; sessionToken: string }
  onSearch: () => void
  onCompose: () => void
  /// Tell your AI something from the list, as you would write to anyone.
  onTellAI: (text: string) => void
  /// A conversation (or a decision) fills a phone's screen: the shell hides
  /// its own chrome while this is true.
  onImmersive: (on: boolean) => void
  /// The whole card, as the feed draws it, for the list's own pane.
  renderCard: (card: DecisionCard) => React.ReactNode
  onWorkspace: () => void
  /// The workspace's mark, name and switcher, drawn by the shell.
  workspaceMenu?: React.ReactNode
  /// Channels are the team's businesses: made, renamed and deleted here,
  /// the way a chat client lets you. Each returns what went wrong, if
  /// anything, as a sentence.
  onCreateChannel: (name: string) => Promise<string | null>
  onRenameChannel: (slug: string, name: string) => Promise<string | null>
  onDeleteChannel: (slug: string) => Promise<string | null>
  /// Another screen: the team to invite, tools to connect, you.
  onOpenScreen?: (screen: 'team' | 'tools' | 'profile') => void
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
  /// The channel its messages live in — `b:<slug>` or `dm:<ref>` — when
  /// people can talk in it. An app has none: it only brings decisions.
  view?: string
  /// Said since you last looked.
  fresh?: boolean
  lastAt?: string
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

/// A teammate as the channel routes name them: a handle and a name, and a
/// hash of their login so a card already in this browser can be matched to
/// them without anyone's login being sent to match it.
interface Member { ref: string; name: string; title?: string; mine: boolean; loginHash: string }
interface Activity { channel: string; lastAt: string; preview: string; lastBy: string | null }

async function hash16(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

const seenKey = (orgId: string, view: string) => `seen:${orgId}:${view}`
function seenAt(orgId: string, view: string): string {
  try { return localStorage.getItem(seenKey(orgId, view)) || '' } catch { return '' }
}

const WIDE = '(min-width: 720px)'
const isWide = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches

function clock(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit' })
}

/// The newest activity on a row, as a chat client shows it: the time today,
/// the date before that.
function when(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString()
    ? clock(iso)
    : d.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' })
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
  onOpen, onNudge, onDecide, api, onSearch, onCompose, onTellAI, onImmersive, renderCard, onWorkspace, workspaceMenu,
  onCreateChannel, onRenameChannel, onDeleteChannel, onOpenScreen,
}) => {
  const t = useT()
  const locale = getLocale()
  const titleOf = (c: DecisionCard) => c.localized?.[locale]?.title || c.title
  const summaryOf = (c: DecisionCard) => c.localized?.[locale]?.summary || c.summary
  const nameOfBusiness = (slug?: string) => businesses.find((b) => b.slug === slug)?.name || slug || ''
  const isMine = (c: DecisionCard) => c.senderUserID === userId && c.recipientUserID !== userId
  const isUnread = (c: DecisionCard) => c.status === 'pending' && c.recipientUserID === userId

  // The team, and what has been said where: loaded once, kept current by
  // the relay's channel events.
  const [members, setMembers] = useState<Member[]>([])
  const [activity, setActivity] = useState<Record<string, Activity>>({})
  const [seenTick, setSeenTick] = useState(0)
  // Read positions from the server: the same on the phone and the laptop.
  const [serverReads, setServerReads] = useState<Record<string, string>>({})
  const readAt = (v: string) => [seenAt(api.orgId, v), serverReads[v] || ''].sort().pop() || ''
  const authHeaders = useMemo(() => ({ 'x-session-token': api.sessionToken }), [api.sessionToken])
  useEffect(() => {
    let ignore = false
    fetch(`${api.httpBase}/channels?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (ignore || !data) return
        setMembers(data.members || [])
        setActivity(Object.fromEntries((data.activity || []).map((a: Activity) => [a.channel, a])))
        setServerReads(data.reads || {})
      })
      .catch(() => { /* the list still shows every decision */ })
    return () => { ignore = true }
  }, [api.httpBase, api.orgId, authHeaders])

  // Which login is which member, for the logins this browser already holds.
  const [hashes, setHashes] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    const logins = new Set<string>()
    for (const c of [...pending, ...sent, ...decided]) { logins.add(c.senderUserID); logins.add(c.recipientUserID) }
    for (const login of Object.keys(presence)) logins.add(login)
    const missing = [...logins].filter((l) => l && !hashes.has(l))
    if (!missing.length || !crypto?.subtle) return
    let ignore = false
    Promise.all(missing.map(async (l) => [l, await hash16(l)] as const)).then((pairs) => {
      if (ignore) return
      setHashes((prev) => { const next = new Map(prev); for (const [l, h] of pairs) next.set(l, h); return next })
    })
    return () => { ignore = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, sent, decided, presence])

  const { channels, people, apps } = useMemo(() => {
    const all = new Map<string, DecisionCard>()
    for (const c of [...pending, ...sent, ...decided]) all.set(c.id, c)
    const cards = [...all.values()].sort(newestFirst)

    const build = (kind: Thread['kind'], key: string, name: string, extra: Partial<Thread>, own: DecisionCard[], keepEmpty = false): Thread | null => {
      if (!own.length && !keepEmpty) return null
      return { key, kind, name, cards: own, unread: own.filter(isUnread).length, latest: own[0], ...extra }
    }
    // What was said in it, and whether that is news to you.
    const withTalk = (th: Thread): Thread => {
      const a = th.view ? activity[th.view] : undefined
      if (!a) return th
      return { ...th, lastAt: a.lastAt, fresh: a.lastBy !== 'me' && a.lastAt > readAt(th.view!) }
    }

    // Channels: one per business the team has, in the team's order — empty
    // ones too, a channel just made is a channel — plus any slug a card
    // names that the table has not caught up with yet.
    const bySlug = new Map<string, DecisionCard[]>()
    for (const c of cards) if (c.business) bySlug.set(c.business, [...(bySlug.get(c.business) || []), c])
    const slugs = [...businesses.map((b) => b.slug), ...[...bySlug.keys()].filter((s) => !businesses.some((b) => b.slug === s))]
    const channels = slugs
      .map((slug) => build('channel', `channel:${slug}`, nameOfBusiness(slug), { slug, view: `b:${slug}` }, bySlug.get(slug) || [], true))
      .filter((x): x is Thread => x !== null)
      .map(withTalk)

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
    // Every teammate is somebody you can write to, whether or not a
    // decision has passed between you yet — as in any chat client.
    const loginOf = new Map<string, string>()
    for (const [login, h] of hashes) loginOf.set(h, login)
    const claimed = new Set<string>()
    const teammates = members.filter((m) => !m.mine).map((m) => {
      const login = loginOf.get(m.loginHash)
      const own = login ? (byPerson.get(login) || []) : []
      if (login) claimed.add(login)
      return withTalk(build('person', `person:${m.ref}`, m.name, { login, view: `dm:${m.ref}` }, own, true)!)
    })
    // Somebody a card names who is not on the member list (they left):
    // their decisions still have a home, with nothing to write into.
    const former = [...byPerson.entries()]
      .filter(([login]) => !claimed.has(login))
      .map(([login, own]) => build('person', `person:${login}`, personName(login, own), { login }, own))
      .filter((x): x is Thread => x !== null)
    const latestOf = (th: Thread) => [th.lastAt || '', th.latest ? stamp(th.latest) : ''].sort().pop() || ''
    const people = [...teammates, ...former]
      .sort((a, b) => (b.unread + (b.fresh ? 1 : 0) > 0 ? 1 : 0) - (a.unread + (a.fresh ? 1 : 0) > 0 ? 1 : 0)
        || latestOf(b).localeCompare(latestOf(a)) || a.name.localeCompare(b.name))

    // Your AI is always there to write to, first among the apps.
    if (!byApp.has('ai')) byApp.set('ai', [])
    const apps = [...byApp.entries()]
      .sort(([a], [b]) => (a === 'ai' ? -1 : b === 'ai' ? 1 : 0))
      .map(([app, own]) => build('app', `app:${app}`,
        app === 'ai' ? t('Your AI') : (APP_NAME[app] ? t(APP_NAME[app]) : app.charAt(0).toUpperCase() + app.slice(1)),
        { icon: app === 'ai' ? 'plus' : (APP_ICON[app] || 'box'), app }, own, app === 'ai'))
      .filter((x): x is Thread => x !== null)

    return { channels, people, apps }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, sent, decided, businesses, userId, locale, members, hashes, activity, seenTick, serverReads])

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
    setActivityOpen(false)
    setLaterOpen(false)
    setOpenKey(key)
    setProblem(null)
    setRenaming(null)
    setSettings(false)
    try { if (key) sessionStorage.setItem('list.open', key); else sessionStorage.removeItem('list.open') } catch {}
  }

  // The Activity inbox: what named you, and replies in your threads.
  const [activityOpen, setActivityOpen] = useState(false)
  const [activityItems, setActivityItems] = useState<Array<{ type: 'mention' | 'reply'; message: ChannelMessage; unread: boolean }> | null>(null)
  const loadActivity = useCallback(() => {
    return fetch(`${api.httpBase}/channels/activity?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setActivityItems(data.items || []) })
      .catch(() => { /* nothing new is the same as nothing loaded */ })
  }, [api.httpBase, api.orgId, authHeaders])
  useEffect(() => { void loadActivity() }, [loadActivity])
  const activityUnread = (activityItems || []).filter((i) => i.unread).length
  const openActivity = () => {
    setOpenKey(null)
    setLaterOpen(false)
    setActivityOpen(true)
    setDetailId(null)
    void loadActivity().then(() => {
      fetch(`${api.httpBase}/channels/read`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel: 'activity' }),
      }).then(() => setActivityItems((prev) => prev && prev.map((i) => ({ ...i, unread: false })))).catch(() => {})
    })
  }
  // A place to go to inside a conversation, once it has loaded: a message,
  // or a reply in a thread.
  const pendingJump = useRef<{ view: string; id: string; parentId?: string | null } | null>(null)
  const openAt = (target: { view: string; id: string; parentId?: string | null }) => {
    const th = everything.find((x) => x.view === target.view)
    if (!th) return
    pendingJump.current = target
    choose(th.key)
    setTick((n) => n + 1)
  }
  const [tick, setTick] = useState(0)

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
    const on = !activityOpen && !laterOpen && current?.key === thread.key
    return (
      <li key={thread.key} className={`cl-row cl-thread${thread.unread || (thread.fresh && !on) ? ' unread' : ''}${on ? ' on' : ''}`}>
        <button className="cl-open" onClick={() => choose(thread.key)} aria-current={on ? 'true' : undefined}>
          {lead(thread, 'row')}
          <span className="cl-title">{thread.name}</span>
          {thread.unread > 0 && <span className="cl-badge">{thread.unread}</span>}
          {thread.unread === 0 && thread.fresh && !on && <span className="cl-fresh" aria-label={t('New messages')} />}
          {!on && thread.view && drafts[thread.view] && <span className="cl-draft" title={t('Draft')} aria-label={t('Draft')}>✏️</span>}
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

  // ---- What is said ----

  const cardsById = useMemo(() => {
    const map = new Map<string, DecisionCard>()
    for (const c of [...pending, ...sent, ...decided]) map.set(c.id, c)
    return map
  }, [pending, sent, decided])
  const [messages, setMessages] = useState<Record<string, ChannelMessage[]>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // Conversations where the AI is writing a card right now.
  // …and which step it is on: reading, routing, writing.
  const [thinking, setThinking] = useState<Record<string, string | false>>({})
  const composer = useRef<HTMLTextAreaElement>(null)
  const view = current?.view
  // Whether there is more above what is loaded, per conversation.
  const [more, setMore] = useState<Record<string, boolean>>({})
  const PAGE = 150
  const loadMessages = useCallback((channel: string) => {
    return fetch(`${api.httpBase}/channels/messages?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        setMessages((prev) => ({ ...prev, [channel]: data.messages || [] }))
        setMore((prev) => ({ ...prev, [channel]: (data.messages || []).length >= PAGE }))
      })
      .catch(() => { /* the decisions still show */ })
  }, [api.httpBase, api.orgId, authHeaders])
  // Scrolled to the top: the page before, kept in place as it arrives.
  const loadingOlder = useRef(false)
  const keepScroll = useRef<number | null>(null)
  const loadOlder = useCallback(async (channel: string) => {
    const list = messagesRef.current[channel]
    if (loadingOlder.current || !list?.length || !more[channel]) return
    loadingOlder.current = true
    try {
      const res = await fetch(`${api.httpBase}/channels/messages?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&before=${encodeURIComponent(list[0].createdAt)}`, { headers: authHeaders })
      const data = res.ok ? await res.json() : null
      if (!data) return
      const older = (data.messages || []) as ChannelMessage[]
      keepScroll.current = logRef.current ? logRef.current.scrollHeight - logRef.current.scrollTop : null
      setMessages((prev) => {
        const cur = prev[channel] || []
        const known = new Set(cur.map((m) => m.id))
        return { ...prev, [channel]: [...older.filter((m) => !known.has(m.id)), ...cur] }
      })
      setMore((prev) => ({ ...prev, [channel]: older.length >= PAGE }))
    } catch { /* try again on the next scroll */ } finally {
      loadingOlder.current = false
    }
  }, [api.httpBase, api.orgId, authHeaders, more])
  useEffect(() => { if (view) void loadMessages(view) }, [view, loadMessages])
  // Where you were up to when you opened it: the red "New" line goes there.
  const [newSince, setNewSince] = useState<{ view: string; at: string } | null>(null)
  useEffect(() => {
    if (!view) { setNewSince(null); return }
    setNewSince({ view, at: readAt(view) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  // Opened is read — here, and on the server for your other devices.
  useEffect(() => {
    if (!view) return
    const now = new Date().toISOString()
    try { localStorage.setItem(seenKey(api.orgId, view), now) } catch { /* private mode: nothing remembered */ }
    setSeenTick((n) => n + 1)
    const id = setTimeout(() => {
      fetch(`${api.httpBase}/channels/read`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel: view }),
      }).then(() => setServerReads((prev) => ({ ...prev, [view]: now }))).catch(() => { /* this device still remembers */ })
    }, 600)
    return () => clearTimeout(id)
  }, [view, api.orgId, messages[view || '']?.length])
  // The composer grows with what is written, up to a point.
  useEffect(() => {
    const el = composer.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])
  // Somebody said something: into its conversation if it is loaded, into
  // the sidebar's activity either way. The AI's answer reloads the
  // conversation, so the message it answered shows the card it became.
  useEffect(() => {
    const myRef = members.find((m) => m.mine)?.ref
    const on = (e: Event) => {
      const m = (e as CustomEvent<ChannelMessage>).detail
      if (!m?.channel) return
      const mine = m.mine || (Boolean(myRef) && m.authorRef === myRef)
      // A live event is shared by the room: whose reactions are yours is
      // read from the refs, not from a flag set for somebody else.
      const reactions = (m.reactions || []).map((r) => ({ ...r, mine: myRef ? r.refs.includes(myRef) : r.mine }))
      const msg = { ...m, mine, reactions }
      if (m.parentId) {
        // A reply: into the thread if it is open; its parent's count comes
        // as an event of its own.
        setThread((prev) => {
          if (!prev || prev.parent.id !== m.parentId) return prev
          const has = prev.replies.some((x) => x.id === m.id)
          const replies = m.deleted ? prev.replies.filter((x) => x.id !== m.id)
            : has ? prev.replies.map((x) => (x.id === m.id ? msg : x)) : [...prev.replies, msg]
          return { ...prev, replies }
        })
        if (m.kind === 'ai') setThinking((prev) => ({ ...prev, [m.channel]: false }))
        return
      }
      let isNew = false
      setMessages((prev) => {
        const list = prev[m.channel]
        if (!list) return prev
        const has = list.some((x) => x.id === m.id)
        isNew = !has
        if (m.deleted && !m.replyCount) return { ...prev, [m.channel]: list.filter((x) => x.id !== m.id) }
        return { ...prev, [m.channel]: has ? list.map((x) => (x.id === m.id ? msg : x)) : [...list, msg] }
      })
      setThread((prev) => (prev && prev.parent.id === m.id ? { ...prev, parent: msg } : prev))
      if (!m.deleted && !m.editedAt && (isNew || !messagesRef.current[m.channel])) {
        setActivity((prev) => ({ ...prev, [m.channel]: { channel: m.channel, lastAt: m.createdAt, preview: m.body.slice(0, 120), lastBy: mine ? 'me' : m.authorName } }))
      }
      if (m.kind === 'ai') {
        setThinking((prev) => ({ ...prev, [m.channel]: false }))
        void loadMessages(m.channel)
      }
    }
    window.addEventListener('honmaru:channel-message', on)
    return () => window.removeEventListener('honmaru:channel-message', on)
  }, [members, loadMessages])
  // The AI's steps, as it takes them.
  useEffect(() => {
    const on = (e: Event) => {
      const p = (e as CustomEvent<{ channel: string; step: string }>).detail
      if (!p?.channel) return
      setThinking((prev) => ({ ...prev, [p.channel]: p.step === 'done' || p.step === 'failed' ? false : p.step }))
    }
    window.addEventListener('honmaru:channel-progress', on)
    return () => window.removeEventListener('honmaru:channel-progress', on)
  }, [])

  const send = async (channel: string, decide: boolean, parentId?: string, sendAt?: string) => {
    let body = (parentId ? threadDraft : draft).trim()
    if (!body || sending) return
    // A command, not a message: done here, with a note only you see.
    const cmd = !parentId && !sendAt ? /^\/(\w+)\s*([\s\S]*)$/.exec(body) : null
    if (cmd) {
      const [, name, rest] = cmd
      const done = await runCommand(channel, name.toLowerCase(), rest.trim())
      if (done === 'send-decide') { body = rest.trim(); decide = true }
      else if (done === 'send-later') return
      else { if (done) setDraft(''); return }
      if (!body) return
    }
    setSending(true); setProblem(null)
    try {
      const res = await fetch(`${api.httpBase}/channels/messages`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel, body, decide, ...(parentId ? { parentId } : {}), ...(sendAt ? { sendAt } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setProblem(data.message || t('That did not send. Try again.')); return }
      if (data.scheduled) {
        setDraft('')
        setScheduled((prev) => [...prev, data.scheduled].sort((a, b) => a.sendAt.localeCompare(b.sendAt)))
        note(channel, t('Scheduled for {when}.', { when: new Date(data.scheduled.sendAt).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }))
        return
      }
      const msg = data.message as ChannelMessage
      if (parentId) {
        setThreadDraft('')
        setThread((prev) => (prev && prev.parent.id === parentId && !prev.replies.some((x) => x.id === msg.id) ? { ...prev, replies: [...prev.replies, msg] } : prev))
        setMessages((prev) => ({ ...prev, [channel]: (prev[channel] || []).map((x) => (x.id === parentId ? { ...x, replyCount: (x.replyCount || 0) + 1, lastReplyAt: msg.createdAt } : x)) }))
        if (data.deciding) setThinking((prev) => ({ ...prev, [channel]: 'reading' }))
        return
      }
      setDraft('')
      setMessages((prev) => {
        const list = prev[channel] || []
        return list.some((x) => x.id === msg.id) ? prev : { ...prev, [channel]: [...list, msg] }
      })
      if (data.deciding) setThinking((prev) => ({ ...prev, [channel]: 'reading' }))
    } catch {
      setProblem(t('That did not send. Try again.'))
    } finally {
      setSending(false)
      if (parentId) threadComposer.current?.focus(); else composer.current?.focus()
    }
  }

  // ---- Time and gathering: drafts, scheduled sends, Later, clips, notes ----
  // A draft per conversation, kept in this browser, as in any chat client.
  const draftKey = (v: string) => `draft:${api.orgId}:${v}`
  const [drafts, setDrafts] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {}
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ''; if (k.startsWith(`draft:${api.orgId}:`) && localStorage.getItem(k)) out[k.slice(`draft:${api.orgId}:`.length)] = true } } catch { /* none kept */ }
    return out
  })
  const draftView = useRef<string | undefined>(undefined)
  useEffect(() => {
    // Leaving a conversation keeps what was being written there; arriving
    // brings back what was being written here.
    draftView.current = view
    let kept = ''
    try { kept = view ? localStorage.getItem(draftKey(view)) || '' : '' } catch {}
    setDraft(kept)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  useEffect(() => {
    const v = draftView.current
    if (!v || v !== view) return
    try { if (draft) localStorage.setItem(draftKey(v), draft); else localStorage.removeItem(draftKey(v)) } catch {}
    setDrafts((prev) => (Boolean(prev[v]) === Boolean(draft) ? prev : { ...prev, [v]: Boolean(draft) }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const [scheduled, setScheduled] = useState<Array<{ id: string; body: string; sendAt: string; channel: string; parentId?: string | null }>>([])
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduledOpen, setScheduledOpen] = useState(false)
  const loadScheduled = useCallback(() => {
    fetch(`${api.httpBase}/channels/scheduled?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setScheduled(d.scheduled || []) }).catch(() => {})
  }, [api.httpBase, api.orgId, authHeaders])
  useEffect(() => { loadScheduled() }, [loadScheduled, view])
  const cancelScheduled = async (id: string) => {
    const res = await fetch(`${api.httpBase}/channels/scheduled`, { method: 'DELETE', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, id }) }).catch(() => null)
    if (res?.ok) setScheduled((prev) => prev.filter((x) => x.id !== id))
  }

  // Notes only you see: what a command did.
  const [notes, setNotes] = useState<Record<string, Array<{ id: string; text: string }>>>({})
  const note = (channel: string, text: string) => setNotes((prev) => ({ ...prev, [channel]: [...(prev[channel] || []), { id: `${Date.now()}-${Math.random()}`, text }] }))

  // Later: saved messages.
  const [laterOpen, setLaterOpen] = useState(false)
  const [laterItems, setLaterItems] = useState<Array<{ id: string; remindAt: string | null; remindedAt: string | null; message: ChannelMessage }> | null>(null)
  const loadLater = useCallback(() => {
    return fetch(`${api.httpBase}/channels/later?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setLaterItems(d.items || []) }).catch(() => {})
  }, [api.httpBase, api.orgId, authHeaders])
  useEffect(() => { void loadLater() }, [loadLater])
  const saveLater = async (channel: string, m: ChannelMessage, remindAt: string | null) => {
    const res = await fetch(`${api.httpBase}/channels/later`, { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, channel, messageId: m.id, remindAt }) }).catch(() => null)
    if (!res?.ok) { setProblem(t('That did not save.')); return }
    note(channel, remindAt
      ? t('Saved for later. Your AI will bring it back {when}.', { when: new Date(remindAt).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })
      : t('Saved for later.'))
    void loadLater()
  }
  const finishLater = async (id: string) => {
    const res = await fetch(`${api.httpBase}/channels/later`, { method: 'DELETE', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, id }) }).catch(() => null)
    if (res?.ok) setLaterItems((prev) => (prev || []).filter((x) => x.id !== id))
  }

  // A clip: messages gathered from anywhere, made one decision.
  const [clip, setClip] = useState<Array<{ channel: string; id: string; body: string; who: string }>>([])
  const toggleClip = (channel: string, m: ChannelMessage) => setClip((prev) => prev.some((x) => x.id === m.id)
    ? prev.filter((x) => x.id !== m.id)
    : [...prev, { channel, id: m.id, body: m.body, who: m.kind === 'ai' ? t('Your AI') : (m.mine ? t('You') : m.authorName || t('a teammate')) }].slice(-30))
  const sendClip = async (channel: string) => {
    if (!clip.length) return
    setProblem(null)
    const res = await fetch(`${api.httpBase}/channels/clip`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, items: clip.map((c) => ({ channel: c.channel, messageId: c.id })), instruction: draft.trim() }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    if (!res?.ok) { setProblem(data.message || t('That could not become a decision. Try again.')); return }
    setClip([]); setDraft('')
    if (data.message) setMessages((prev) => ({ ...prev, [channel]: (prev[channel] || []).some((x) => x.id === data.message.id) ? prev[channel] : [...(prev[channel] || []), data.message] }))
    setThinking((prev) => ({ ...prev, [channel]: 'reading' }))
  }

  /// "/name rest": returns 'send-decide' to send the rest as a decision,
  /// 'send-later' when it scheduled, true when handled, false when not a command.
  const runCommand = async (channel: string, name: string, rest: string): Promise<'send-decide' | 'send-later' | boolean> => {
    const post = (path: string, body: unknown) => fetch(`${api.httpBase}${path}`, { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (name === 'decide') return rest ? 'send-decide' : (note(channel, t('Write what needs deciding after /decide.')), true)
    if (name === 'remember') {
      if (!rest) { note(channel, t('Write the rule after /remember.')); return true }
      const res = await post('/memories', { orgId: api.orgId, text: rest }).catch(() => null)
      note(channel, res?.ok ? t('Added to the playbook: “{rule}”', { rule: rest }) : t('That did not save.'))
      return true
    }
    if (name === 'routine') {
      if (!rest) { note(channel, t('Say what and when after /routine — e.g. every Monday at 9 summarise last week.')); return true }
      const parsed = await post('/routines/parse', { text: rest, locale }).then((r) => r.json()).then((d) => d.parsed).catch(() => null)
      if (!parsed) { note(channel, t('Say when, too — e.g. every Monday at 9, or every day at 18:00.')); return true }
      const res = await post('/routines', { orgId: api.orgId, kind: 'report', instruction: parsed.instruction || rest, cadence: parsed.cadence, hour: parsed.hour, minute: parsed.minute, weekday: parsed.weekday, monthday: parsed.monthday }).catch(() => null)
      note(channel, res?.ok ? t('Your AI will do this {when}.', { when: parsed.schedule || '' }) : ((await res?.json().catch(() => null))?.message || t('That did not save.')))
      return true
    }
    if (name === 'schedule') {
      const p = parseScheduleCommand(rest)
      if (!p) { note(channel, t('Try /schedule 30m …, /schedule 2h …, /schedule tomorrow … or /schedule monday …')); return true }
      setDraft(p.text)
      await sendAtTime(channel, p.at, p.text)
      return 'send-later'
    }
    if (name === 'shortcuts') { window.dispatchEvent(new CustomEvent('honmaru:shortcuts')); return true }
    note(channel, t('/{name} is not a command. Try /decide, /remember, /routine, /schedule or /shortcuts.', { name }))
    return true
  }
  const sendAtTime = async (channel: string, at: string, text?: string) => {
    const body = (text ?? draft).trim()
    if (!body) return
    const res = await fetch(`${api.httpBase}/channels/messages`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, body, sendAt: at }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    if (!res?.ok) { setProblem(data.message || t('That did not send. Try again.')); return }
    setDraft('')
    setScheduled((prev) => [...prev, data.scheduled].sort((a, b) => a.sendAt.localeCompare(b.sendAt)))
    note(channel, t('Scheduled for {when}.', { when: new Date(data.scheduled.sendAt).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }))
  }

  // ---- What you can do to a message ----
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [toolsOpen, setToolsOpen] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [thread, setThread] = useState<{ channel: string; parent: ChannelMessage; replies: ChannelMessage[] } | null>(null)
  const [threadDraft, setThreadDraft] = useState('')
  const threadComposer = useRef<HTMLTextAreaElement>(null)
  const [pins, setPins] = useState<ChannelMessage[] | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const myRef = members.find((m) => m.mine)?.ref
  const nameOfRef = (ref: string) => (ref === myRef ? t('You') : members.find((m) => m.ref === ref)?.name || t('a teammate'))

  /// Put a changed message wherever it shows: the log, the thread, the pins.
  const replaceMessage = (channel: string, msg: ChannelMessage) => {
    if (msg.parentId) {
      setThread((prev) => (prev && prev.parent.id === msg.parentId
        ? { ...prev, replies: msg.deleted ? prev.replies.filter((x) => x.id !== msg.id) : prev.replies.map((x) => (x.id === msg.id ? msg : x)) }
        : prev))
      return
    }
    setMessages((prev) => {
      const list = prev[channel] || []
      if (msg.deleted && !msg.replyCount) return { ...prev, [channel]: list.filter((x) => x.id !== msg.id) }
      return { ...prev, [channel]: list.map((x) => (x.id === msg.id ? msg : x)) }
    })
    setThread((prev) => (prev && prev.parent.id === msg.id ? { ...prev, parent: msg } : prev))
    setPins((prev) => (prev ? (msg.pinned ? (prev.some((x) => x.id === msg.id) ? prev.map((x) => (x.id === msg.id ? msg : x)) : [msg, ...prev]) : prev.filter((x) => x.id !== msg.id)) : prev))
  }
  const act = async (method: 'POST' | 'PUT' | 'DELETE', path: string, channel: string, extra: Record<string, unknown>) => {
    setProblem(null)
    try {
      const res = await fetch(`${api.httpBase}${path}`, {
        method,
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel, ...extra }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setProblem(data.message || t('That did not work. Try again.')); return null }
      if (data.message && typeof data.message === 'object') replaceMessage(channel, data.message as ChannelMessage)
      return data.message as ChannelMessage
    } catch {
      setProblem(t('That did not work. Try again.'))
      return null
    }
  }
  const react = (channel: string, m: ChannelMessage, emoji: string) => void act('POST', '/channels/reactions', channel, { messageId: m.id, emoji })
  const saveEdit = async (channel: string) => {
    if (!editing) return
    const text = editing.text.trim()
    if (!text) return
    const done = await act('PUT', '/channels/messages', channel, { messageId: editing.id, body: text })
    if (done) setEditing(null)
  }
  const remove = async (channel: string, m: ChannelMessage) => {
    if (!window.confirm(t('Delete this message? This cannot be undone.'))) return
    await act('DELETE', '/channels/messages', channel, { messageId: m.id })
    if (editing?.id === m.id) setEditing(null)
  }
  const togglePin = (channel: string, m: ChannelMessage) => void act('POST', '/channels/pins', channel, { messageId: m.id, pinned: !m.pinned })
  const openThread = async (channel: string, m: ChannelMessage) => {
    setDetailId(null)
    setThread({ channel, parent: m, replies: [] })
    setThreadDraft('')
    const res = await fetch(`${api.httpBase}/channels/thread?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&messageId=${encodeURIComponent(m.id)}`, { headers: authHeaders }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (data) setThread((prev) => (prev && prev.parent.id === m.id ? { channel, parent: data.parent, replies: data.replies || [] } : prev))
    requestAnimationFrame(() => threadComposer.current?.focus())
  }
  const loadPins = async (channel: string) => {
    if (pins) { setPins(null); return }
    const res = await fetch(`${api.httpBase}/channels/pins?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}`, { headers: authHeaders }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    setPins(data?.messages || [])
  }
  const jumpTo = (id: string) => {
    setPins(null)
    const el = document.getElementById(`msg-${id}`)
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setFlash(id); setTimeout(() => setFlash(null), 1600) }
  }
  // Leaving a conversation closes what was open on it.
  useEffect(() => { setEditing(null); setThread(null); setPins(null); setPickerFor(null) }, [current?.key])
  useEffect(() => {
    const j = pendingJump.current
    if (!j || !current || current.view !== j.view) return
    const list = messages[j.view]
    if (!list) return
    pendingJump.current = null
    if (j.parentId) {
      const parent = list.find((m) => m.id === j.parentId) || ({ id: j.parentId, channel: j.view, kind: 'message', body: '', authorName: null, authorRef: null, mine: false, cardId: null, createdAt: '' } as ChannelMessage)
      void openThread(j.view, parent)
    } else {
      requestAnimationFrame(() => jumpTo(j.id))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.view, messages[current?.view || '']?.length, tick])
  // Somebody named you, or answered in your thread: the inbox refreshes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const on = (e: Event) => {
      const m = (e as CustomEvent<ChannelMessage>).detail
      if (!m || m.mine || (!m.parentId && !/[@＠]/.test(m.body || ''))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void loadActivity() }, 800)
    }
    window.addEventListener('honmaru:channel-message', on)
    return () => { window.removeEventListener('honmaru:channel-message', on); if (timer) clearTimeout(timer) }
  }, [loadActivity])
  // From search: open the conversation and go to the message.
  useEffect(() => {
    const go = (target: { view: string; id: string; parentId?: string | null }) => openAt(target)
    const on = (e: Event) => { try { sessionStorage.removeItem('list.jump') } catch {}; go((e as CustomEvent).detail) }
    window.addEventListener('honmaru:open-message', on)
    try {
      const saved = sessionStorage.getItem('list.jump')
      if (saved) { sessionStorage.removeItem('list.jump'); const j = JSON.parse(saved); setTimeout(() => go(j), 300) }
    } catch { /* nothing to go to */ }
    return () => window.removeEventListener('honmaru:open-message', on)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everything.length])
  const decideMessage = async (channel: string, m: ChannelMessage) => {
    setProblem(null)
    const res = await fetch(`${api.httpBase}/channels/decide`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, messageId: m.id }),
    }).catch(() => null)
    if (res?.ok) setThinking((prev) => ({ ...prev, [channel]: 'reading' }))
    else setProblem(t('That could not become a decision. Try again.'))
  }

  // ---- The decision pane ----
  // A decision opens beside the conversation — as a chat client opens a
  // thread — never by leaving the list for the feed.
  const [detailId, setDetailId] = useState<string | null>(null)
  const detail = detailId ? cardsById.get(detailId) : undefined
  const openCard = (id: string) => { setThread(null); setDetailId(id) }
  useEffect(() => {
    if (!detailId && !thread) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('textarea, input')) { setDetailId(null); setThread(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailId, thread])
  // A phone gives a conversation, or a decision, the whole screen.
  useEffect(() => { onImmersive(!wide && (Boolean(current && !activityOpen && !laterOpen) || Boolean(detail) || Boolean(thread) || activityOpen || laterOpen)) }, [wide, current?.key, detail?.id, thread, activityOpen, laterOpen, onImmersive])
  useEffect(() => () => onImmersive(false), [onImmersive])

  // Messages, or the decisions in this conversation as a list.
  const [tab, setTab] = useState<'messages' | 'decisions'>('messages')
  useEffect(() => { setTab('messages'); setPicked(new Set()) }, [current?.key])
  // Several decisions at once: the ones ticked in the list.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const approvePicked = () => {
    for (const id of picked) onDecide(id, 'approve')
    setPicked(new Set())
  }

  // "@" in the composer offers the team — and the AI.
  const mentionable = useMembers(api.httpBase, api.orgId, api.sessionToken)
  const withAI = useMemo(() => [{ ref: '__ai', name: 'AI' } as (typeof mentionable)[number], ...mentionable], [mentionable])
  const mention = useMentionMenu(composer, draft, setDraft, withAI)
  const threadMention = useMentionMenu(threadComposer, threadDraft, setThreadDraft, withAI)

  // The newest message in view when a conversation opens, as in any chat.
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    if (keepScroll.current !== null) { el.scrollTop = el.scrollHeight - keepScroll.current; keepScroll.current = null; return }
    el.scrollTop = el.scrollHeight
  }, [current?.key, current?.cards.length, messages[current?.view || '']?.length, thinking[current?.view || '']])

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
    return d.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })
  }

  /// A decision as a chat app's attachment: what, where it stands, and the
  /// buttons that decide it right here — as a Slack app's message does.
  const attachment = (c: DecisionCard) => {
    const s = status(c)
    const note = c.decision?.note || c.decision?.replyText
    const summary = summaryOf(c)
    const fyi = Boolean(c.report) || c.format === 'fyi'
    return (
      <div className={`slk-card ${s.tone}`}>
        <button className="slk-title" onClick={() => openCard(c.id)}>
          {(c.priority === 'urgent' || c.priority === 'high') && c.status === 'pending' && (
            <span className={`slk-chip ${c.priority}`}>{t(c.priority === 'urgent' ? 'Urgent' : 'High')}</span>
          )}
          {c.report && <span className="slk-chip report">{t('Report')}</span>}
          {c.proposal && <span className="slk-chip proposal">{t('Proposal')}</span>}
          <span>{titleOf(c)}</span>
        </button>
        {summary && <p className="slk-summary">{summary}</p>}
        <div className="slk-status-line">
          <span className="slk-status">{s.text}</span>
          {note && <span className="slk-note">“{note}”</span>}
        </div>
        <div className="slk-actions">
          {isUnread(c) && (fyi ? (
            <button className="slk-action primary" onClick={() => onDecide(c.id, 'acknowledge')}>{t('Got it')}</button>
          ) : (
            <>
              <button className="slk-action primary" onClick={() => onDecide(c.id, 'approve')}>{t('Approve')}</button>
              <button className="slk-action danger" onClick={() => onDecide(c.id, 'decline')}>{t('Decline')}</button>
            </>
          ))}
          <button className="slk-action" onClick={() => openCard(c.id)}>{t('Open')}</button>
          {isMine(c) && c.status === 'pending' && <button className="slk-action" onClick={() => onNudge(c.id)}>{t('Nudge')}</button>}
          {Boolean(c.commentCount) && (
            <button className="slk-replies" onClick={() => openCard(c.id)}>{c.commentCount === 1 ? t('1 reply') : t('{n} replies', { n: c.commentCount! })}</button>
          )}
          {c.business && current?.kind !== 'channel' && <span className="slk-where">#{nameOfBusiness(c.business)}</span>}
        </div>
      </div>
    )
  }

  const avatarFor = (app: string, initial: string) => app
    ? <span className="slk-avatar app">{app === 'ai'
        ? <img src="/icon.svg" alt="" width={36} height={36} />
        : isBrand(app) ? <BrandLogo brand={app} size={20} /> : <Icon name={APP_ICON[app] || 'box'} size={18} />}</span>
    : <span className="slk-avatar">{initial}</span>

  /// One block of a conversation: a gutter, a name and a time — or, joined
  /// to the one before, just the words — then what was said.
  const block = (key: string, opts: { joined: boolean; at: string; app: string; name: string; badge?: string; to?: string; unread?: boolean; tools?: React.ReactNode; msgId?: string; pinned?: boolean }, body: React.ReactNode) => (
    <article key={key} id={opts.msgId ? `msg-${opts.msgId}` : undefined} tabIndex={opts.msgId ? -1 : undefined}
      className={`slk-msg${opts.joined ? ' joined' : ''}${opts.unread ? ' unread' : ''}${opts.msgId && toolsOpen === opts.msgId ? ' tools-open' : ''}${opts.msgId && editing?.id === opts.msgId ? ' editing' : ''}${opts.pinned ? ' pinned' : ''}${opts.msgId && flash === opts.msgId ? ' flash' : ''}`}>
      <div className="slk-gutter" aria-hidden="true">
        {opts.joined ? <span className="slk-hover-time">{clock(opts.at)}</span> : avatarFor(opts.app, opts.name.charAt(0).toUpperCase())}
      </div>
      <div className="slk-body">
        {opts.pinned && <div className="slk-pin-mark">📌 {t('Pinned')}</div>}
        {!opts.joined && (
          <div className="slk-meta">
            <span className="slk-author">{opts.name}</span>
            {opts.badge && <span className="slk-app-badge">{opts.badge}</span>}
            {opts.to && <span className="slk-to">→ {opts.to}</span>}
            <time className="slk-time" dateTime={opts.at}>{clock(opts.at)}</time>
          </div>
        )}
        {body}
      </div>
      {opts.tools && <div className="slk-tools">{opts.tools}</div>}
    </article>
  )

  /// Words as written, with Slack's formatting read back: lines kept,
  /// links clickable, @names marked.
  const rich = (text: string) => renderRich(text, (part) => `slk-mention${/^[@＠]ai$/i.test(part.replace(/[にへ]$/, '')) ? ' ai' : ''}`)

  /// What sits under a message's words: its reactions and its thread.
  const underneath = (channel: string, m: ChannelMessage, inThread = false) => (
    <>
      {!m.deleted && (
        <Reactions message={m} nameOf={nameOfRef} onToggle={(e) => react(channel, m, e)} onAdd={() => setPickerFor(m.id)} />
      )}
      {pickerFor === m.id && <div className="slk-picker-anchor"><EmojiPicker onPick={(e) => react(channel, m, e)} onClose={() => setPickerFor(null)} /></div>}
      {!inThread && (m.replyCount || 0) > 0 && (
        <button type="button" className="slk-thread-link" onClick={() => void openThread(channel, m)}>
          <span className="slk-thread-faces" aria-hidden="true">
            {(m.replyRefs || []).slice(0, 3).map((r) => <span key={r} className="slk-face">{nameOfRef(r).charAt(0).toUpperCase()}</span>)}
          </span>
          <b>{m.replyCount === 1 ? t('1 reply') : t('{n} replies', { n: m.replyCount! })}</b>
          {m.lastReplyAt && <span className="slk-thread-last">{t('Last reply {when}', { when: when(m.lastReplyAt) })}</span>}
        </button>
      )}
    </>
  )

  /// A person's message: the words (or the box to change them), what is
  /// under them, and on hover everything you can do to it.
  const words = (channel: string, m: ChannelMessage) => {
    if (editing?.id === m.id) {
      return (
        <form className="slk-edit" onSubmit={(e) => { e.preventDefault(); void saveEdit(channel) }}>
          <textarea
            className="slk-input"
            value={editing.text}
            autoFocus
            rows={Math.min(8, editing.text.split('\n').length + 1)}
            maxLength={4000}
            onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void saveEdit(channel) }
            }}
            aria-label={t('Edit message')}
          />
          <div className="slk-edit-bar">
            <span className="slk-composer-hint">{t('Escape to cancel · Enter to save')}</span>
            <button type="button" className="cl-nudge" onClick={() => setEditing(null)}>{t('Cancel')}</button>
            <button type="submit" className="slk-send save" disabled={!editing.text.trim()}>{t('Save')}</button>
          </div>
        </form>
      )
    }
    if (m.deleted) return <div className="slk-text slk-deleted">{t('This message was deleted.')}</div>
    return (
      <div className="slk-text">
        {rich(m.body)}
        {m.editedAt && <span className="slk-edited" title={new Date(m.editedAt).toLocaleString(locale)}> {t('(edited)')}</span>}
      </div>
    )
  }
  const toolsFor = (channel: string, m: ChannelMessage, inThread = false) => (m.deleted || editing?.id === m.id) ? undefined : (
    <MessageActions
      message={m}
      inThread={inThread}
      onReact={(e) => react(channel, m, e)}
      onReply={() => void openThread(channel, m)}
      onPin={() => togglePin(channel, m)}
      onEdit={m.mine && m.kind === 'message' ? () => setEditing({ id: m.id, text: m.body }) : undefined}
      onDelete={m.mine && m.kind === 'message' ? () => void remove(channel, m) : undefined}
      onDecide={!m.cardId && m.kind === 'message' && !inThread ? () => void decideMessage(channel, m) : undefined}
      onLater={(at) => void saveLater(channel, m, at)}
      onClip={() => toggleClip(channel, m)}
      clipped={clip.some((x) => x.id === m.id)}
      onOpenChange={(open) => setToolsOpen((cur) => (open ? m.id : cur === m.id ? null : cur))}
    />
  )

  /// What the AI is doing, step by step, where a person is waiting for it.
  const STEPS: Array<[string, string]> = [['reading', 'Reading the conversation'], ['routing', 'Deciding who decides'], ['writing', 'Writing the card']]
  const aiSteps = (step: string | false) => {
    if (!step) return null
    const at = Math.max(0, STEPS.findIndex(([k]) => k === step))
    return (
      <div className="slk-typing slk-steps" role="status" aria-live="polite">
        <span className="slk-dots" aria-hidden="true"><i /><i /><i /></span>
        <ol>
          {STEPS.map(([k, label], i) => (
            <li key={k} className={i < at ? 'done' : i === at ? 'now' : ''}>
              <span aria-hidden="true">{i < at ? '✓' : i === at ? '›' : '·'}</span> {t(label)}
            </li>
          ))}
        </ol>
      </div>
    )
  }

  type Item = { at: string; kind: 'card'; card: DecisionCard } | { at: string; kind: 'msg'; msg: ChannelMessage }

  /// The Activity inbox, as a conversation of its own: each item says where
  /// it was, who, and why it is here, and opens in place.
  const laterView = () => (
    <>
      <header className="slk-head">
        <button className="slk-back" onClick={() => setLaterOpen(false)} aria-label={t('Back')}><span aria-hidden="true">‹</span></button>
        <span className="cl-lead cl-app sz-head" aria-hidden="true">🔖</span>
        <div className="slk-head-text">
          <h1>{t('Later')}</h1>
          <p>{t('Messages you saved to come back to. A reminder brings one back to your feed as a card.')}</p>
        </div>
      </header>
      <div className="slk-log slk-activity">
        {laterItems && laterItems.length === 0 && (
          <div className="slk-start">
            <span className="cl-lead cl-app sz-head" aria-hidden="true">🔖</span>
            <h2>{t('Nothing saved')}</h2>
            <p>{t('Pick “Save for later” from any message’s ⋯ menu.')}</p>
          </div>
        )}
        {(laterItems || []).map(({ id, remindAt, remindedAt, message: m }) => {
          const th = everything.find((x) => x.view === m.channel)
          return (
            <div key={id} className="slk-act later" data-saved={id}>
              <span className="slk-act-kind">
                {th ? (th.kind === 'channel' ? `#${th.name}` : th.name) : ''}
                {remindAt && ` · ${remindedAt ? t('Reminded') : t('Reminder {when}', { when: new Date(remindAt).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })}`}
              </span>
              <span className="slk-act-line"><b>{m.kind === 'ai' ? t('Your AI') : (m.mine ? t('You') : m.authorName || t('a teammate'))}</b><span className="slk-act-when">{when(m.createdAt)}</span></span>
              <span className="slk-act-body">{m.body.slice(0, 280)}</span>
              <span className="slk-act-actions">
                <button type="button" className="cl-nudge" onClick={() => openAt({ view: m.channel, id: m.id, parentId: m.parentId })}>{t('Open')}</button>
                <button type="button" className="cl-nudge" onClick={() => void finishLater(id)}>{t('Done')}</button>
              </span>
            </div>
          )
        })}
      </div>
    </>
  )

  const activityView = () => {
    const nameOfView = (v: string) => {
      const th = everything.find((x) => x.view === v)
      return th ? (th.kind === 'channel' ? `#${th.name}` : th.name) : v
    }
    return (
      <>
        <header className="slk-head">
          <button className="slk-back" onClick={() => setActivityOpen(false)} aria-label={t('Back')}><span aria-hidden="true">‹</span></button>
          <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="bell" size={18} /></span>
          <div className="slk-head-text">
            <h1>{t('Activity')}</h1>
            <p>{t('Mentions of you, and replies in your threads.')}</p>
          </div>
        </header>
        <div className="slk-log slk-activity">
          {activityItems === null && <p className="slk-empty">{t('Loading…')}</p>}
          {activityItems && activityItems.length === 0 && (
            <div className="slk-start">
              <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="bell" size={18} /></span>
              <h2>{t('Nothing for you yet')}</h2>
              <p>{t('When somebody writes @ your name, or replies in a thread you are part of, it shows up here.')}</p>
            </div>
          )}
          {(activityItems || []).map(({ type, message: m, unread }) => (
            <button key={`${type}-${m.id}`} type="button" className={`slk-act${unread ? ' unread' : ''}`}
              onClick={() => openAt({ view: m.channel, id: m.id, parentId: m.parentId })}>
              <span className="slk-act-kind">{type === 'mention' ? t('Mentioned you in {where}', { where: nameOfView(m.channel) }) : t('Replied in a thread in {where}', { where: nameOfView(m.channel) })}</span>
              <span className="slk-act-line">
                <b>{m.kind === 'ai' ? t('Your AI') : (m.authorName || t('a teammate'))}</b>
                <span className="slk-act-when">{when(m.createdAt)}</span>
              </span>
              <span className="slk-act-body">{m.body.slice(0, 280)}</span>
            </button>
          ))}
        </div>
      </>
    )
  }

  const conversation = (thread: Thread) => {
    const said = thread.view ? (messages[thread.view] || []) : []
    // A card the AI announced sits under its announcement, not twice.
    const announced = new Set(said.filter((m) => m.kind === 'ai' && m.cardId).map((m) => m.cardId!))
    const items: Item[] = [
      ...thread.cards.filter((c) => !announced.has(c.id)).map((card) => ({ at: card.createdAt, kind: 'card' as const, card })),
      ...said.map((msg) => ({ at: msg.createdAt, kind: 'msg' as const, msg })),
    ].sort((a, b) => a.at.localeCompare(b.at))

    const out: React.ReactNode[] = []
    let day = ''
    // The red line: the first thing somebody else said since you last read.
    const since = newSince && newSince.view === thread.view ? newSince.at : ''
    let lined = !since
    let prevWho = ''
    let prevAt = 0
    for (const item of items) {
      const d = new Date(Date.parse(item.at)).toDateString()
      if (d !== day) {
        day = d
        prevWho = ''
        out.push(<div key={`day-${d}`} className="slk-day" role="separator"><span>{dayLabel(item.at)}</span></div>)
      }
      const at = Date.parse(item.at)
      if (!lined && item.kind === 'msg' && !item.msg.mine && item.at > since) {
        lined = true
        out.push(<div key="new-line" className="slk-new-line" role="separator"><span>{t('New')}</span></div>)
      }
      if (item.kind === 'card') {
        const c = item.card
        const who = author(c)
        const joined = prevWho === `card:${who.name}` && at - prevAt < 5 * 60000
        const to = c.senderUserID === userId && c.recipientUserID !== userId ? properName(recipientNameOf(c)) : ''
        out.push(block(c.id, { joined, at: c.createdAt, app: who.app, name: who.name, to, unread: isUnread(c) }, attachment(c)))
        prevWho = `card:${who.name}`
      } else {
        const m = item.msg
        if (m.kind === 'ai') {
          const card = m.cardId ? cardsById.get(m.cardId) : undefined
          out.push(block(m.id, { joined: false, at: m.createdAt, app: 'ai', name: t('Your AI'), badge: t('AI'), msgId: m.id, pinned: m.pinned, tools: toolsFor(thread.view!, m) },
            <>
              <div className="slk-text">{rich(m.body)}</div>
              {card && attachment(card)}
              {underneath(thread.view!, m)}
            </>))
          prevWho = 'ai'
        } else {
          const whoKey = `msg:${m.authorRef || m.authorName}`
          const joined = prevWho === whoKey && at - prevAt < 5 * 60000
          const name = m.mine ? t('You') : (m.authorName || t('a teammate'))
          out.push(block(m.id, {
            joined: joined && !m.pinned, at: m.createdAt, app: '', name, msgId: m.id, pinned: m.pinned,
            tools: toolsFor(thread.view!, m),
          }, (
            <>
              {words(thread.view!, m)}
              {m.cardId && <button className="slk-made" onClick={() => openCard(m.cardId!)}>{t('→ Decision')}</button>}
              {underneath(thread.view!, m)}
            </>
          )))
          prevWho = whoKey
        }
      }
      prevAt = at
    }
    const waitingHere = thread.cards.filter(isUnread).length
    const placeholder = thread.kind === 'channel'
      ? t('Message #{name} — @AI makes it a decision', { name: thread.name })
      : t('Message {name} — @AI makes it a decision', { name: thread.name })
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
          {thread.view && (
            <button
              className={`slk-pins-button${pins ? ' on' : ''}`}
              onClick={() => void loadPins(thread.view!)}
              aria-label={t('Pinned messages')}
              aria-expanded={Boolean(pins)}
              title={t('Pinned messages')}
            >
              <span aria-hidden="true">📌</span>
              {(messages[thread.view] || []).filter((m) => m.pinned).length > 0 && <span>{(messages[thread.view] || []).filter((m) => m.pinned).length}</span>}
            </button>
          )}
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
        {pins && thread.view && (
          <div className="slk-pins" role="dialog" aria-label={t('Pinned messages')}>
            <div className="slk-pins-head">
              <b>{t('Pinned messages')}</b>
              <button type="button" className="slk-pane-close" onClick={() => setPins(null)} aria-label={t('Close')}>×</button>
            </div>
            {pins.length === 0 && <p className="slk-empty">{t('Nothing pinned yet. Pin a message from its ⋯ menu to keep it here.')}</p>}
            <ul>
              {pins.map((m) => (
                <li key={m.id}>
                  <button type="button" className="slk-pin-row" onClick={() => jumpTo(m.id)}>
                    <span className="slk-pin-who">{m.kind === 'ai' ? t('Your AI') : (m.mine ? t('You') : m.authorName || t('a teammate'))} · {when(m.createdAt)}</span>
                    <span className="slk-pin-body">{m.body.slice(0, 200)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <nav className="slk-tabs" role="tablist" aria-label={t('View')}>
          <button role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'on' : ''} onClick={() => setTab('messages')}>
            {thread.view ? t('Messages') : t('Activity')}
          </button>
          <button role="tab" aria-selected={tab === 'decisions'} className={tab === 'decisions' ? 'on' : ''} onClick={() => setTab('decisions')}>
            {t('Decisions')}{thread.cards.length > 0 && <span className="slk-tab-count">{thread.cards.length}</span>}
          </button>
        </nav>
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
        {tab === 'decisions' ? (
          <div className="slk-log slk-decisions">
            {thread.cards.length === 0 && <p className="slk-empty">{t('No decisions here yet.')}</p>}
            {(['waiting', 'decided'] as const).map((group) => {
              const list = thread.cards.filter((c) => (group === 'waiting' ? c.status === 'pending' : c.status !== 'pending'))
              if (!list.length) return null
              return (
                <section key={group} className="slk-dgroup">
                  <h3>
                    {group === 'waiting' ? t('Waiting') : t('Decided')}<span>{list.length}</span>
                    {group === 'waiting' && (() => {
                      const mine = list.filter((c) => isUnread(c) && c.format !== 'fyi' && !c.report)
                      if (mine.length < 2) return null
                      const all = mine.every((c) => picked.has(c.id))
                      return (
                        <span className="slk-bulk">
                          <button type="button" className="cl-nudge" onClick={() => setPicked(all ? new Set() : new Set(mine.map((c) => c.id)))}>{all ? t('Clear selection') : t('Select all')}</button>
                          {picked.size > 0 && <button type="button" className="slk-send ai" onClick={approvePicked} data-bulk-approve="1">{t('Approve {n}', { n: picked.size })}</button>}
                        </span>
                      )
                    })()}
                  </h3>
                  <ul>
                    {list.map((c) => {
                      const st = status(c)
                      return (
                        <li key={c.id} className={isUnread(c) && c.format !== 'fyi' && !c.report ? 'pickable' : ''}>
                          {isUnread(c) && c.format !== 'fyi' && !c.report && (
                            <input type="checkbox" className="slk-pick" checked={picked.has(c.id)} aria-label={t('Select {title}', { title: titleOf(c) })}
                              onChange={() => setPicked((prev) => { const next = new Set(prev); if (next.has(c.id)) next.delete(c.id); else next.add(c.id); return next })} />
                          )}
                          <button className={`slk-drow ${st.tone}${detailId === c.id ? ' on' : ''}${isUnread(c) ? ' unread' : ''}`} onClick={() => openCard(c.id)}>
                            <span className="slk-ddot" aria-hidden="true" />
                            <span className="slk-dmain">
                              <span className="slk-dtitle">{titleOf(c)}</span>
                              <span className="slk-dmeta">{author(c).name} · {st.text}</span>
                            </span>
                            <span className="slk-dwhen">{when(stamp(c))}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        ) : (
        <div className="slk-log" ref={logRef} onScroll={(e) => { if (thread.view && e.currentTarget.scrollTop < 120) void loadOlder(thread.view) }}>
          {thread.view && more[thread.view] && <div className="slk-older" role="status">{t('Loading earlier messages…')}</div>}
          {!(thread.view && more[thread.view]) && <div className="slk-start">
            {lead(thread, 'head')}
            <h2>{thread.kind === 'channel' ? t('This is the start of #{name}', { name: thread.name }) : thread.name}</h2>
            <p>{thread.kind === 'channel'
              ? t('Talk about {name} here. Write @AI — or pick “Make it a decision” on any message — and your AI turns it into a decision card, written from what was said.', { name: thread.name })
              : thread.kind === 'person'
                ? t('Just the two of you. Write @AI and your AI makes what you said a decision for {name}.', { name: thread.name })
                : t('What {name} brought in. Each opens as a card.', { name: thread.name })}</p>
          </div>}
          {thread.app === 'ai' && out.length === 0 && (
            block('ai-intro', { joined: false, at: new Date().toISOString(), app: 'ai', name: t('Your AI'), badge: t('AI') }, (
              <>
                <div className="slk-text">{t('Hi — I turn what you tell me into decisions for the right person, with what they need to decide. Try one of these, or write your own:')}</div>
                <div className="slk-samples">
                  {[t('Ask Kenji to approve the new supplier price, +8% from Friday'), t('Every Monday at 9, summarise last week’s decisions'), t('Remind the team to submit expenses by the 25th')].map((x) => (
                    <button key={x} type="button" className="slk-sample" onClick={() => { setDraft(x); composer.current?.focus() }}>{x}</button>
                  ))}
                </div>
              </>
            ))
          )}
          {out}
          {thread.view && (notes[thread.view] || []).map((n) => (
            <div key={n.id} className="slk-note-row" role="status">
              <span className="slk-note-only">{t('Only visible to you')}</span>
              <span>{n.text}</span>
              <button type="button" onClick={() => setNotes((prev) => ({ ...prev, [thread.view!]: (prev[thread.view!] || []).filter((x) => x.id !== n.id) }))} aria-label={t('Dismiss')}>×</button>
            </div>
          ))}
          {thread.view && aiSteps(thinking[thread.view])}
        </div>
        )}
        {thread.view && (() => {
          const here = scheduled.filter((x) => x.channel === thread.view)
          return (
            <>
              {clip.length > 0 && (
                <div className="slk-clip" role="region" aria-label={t('Clip')}>
                  <span className="slk-clip-count">📎 {t('{n} messages clipped', { n: clip.length })}</span>
                  <span className="slk-clip-list">{clip.map((c) => <span key={c.id} className="slk-clip-chip" title={c.body}>{c.who}: {c.body.slice(0, 30)}<button type="button" onClick={() => setClip((p) => p.filter((x) => x.id !== c.id))} aria-label={t('Remove')}>×</button></span>)}</span>
                  <button type="button" className="slk-send ai" onClick={() => void sendClip(thread.view!)}>{t('Make one decision')}</button>
                  <button type="button" className="cl-nudge" onClick={() => setClip([])}>{t('Clear')}</button>
                </div>
              )}
              {here.length > 0 && (
                <div className="slk-scheduled">
                  <button type="button" className="slk-scheduled-toggle" onClick={() => setScheduledOpen((o) => !o)} aria-expanded={scheduledOpen}>
                    ⏰ {here.length === 1 ? t('1 scheduled message') : t('{n} scheduled messages', { n: here.length })}
                  </button>
                  {scheduledOpen && (
                    <ul>
                      {here.map((x) => (
                        <li key={x.id}>
                          <span className="slk-scheduled-when">{new Date(x.sendAt).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          <span className="slk-scheduled-body">{x.body}</span>
                          <button type="button" className="cl-nudge" onClick={() => { setDraft(x.body); void cancelScheduled(x.id) }}>{t('Edit')}</button>
                          <button type="button" className="cl-nudge cl-danger" onClick={() => void cancelScheduled(x.id)}>{t('Cancel')}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )
        })()}
        {thread.view ? (
          <form className="slk-composer" onSubmit={(e) => { e.preventDefault(); void send(thread.view!, false) }}>
            <textarea
              ref={composer}
              className="slk-input"
              value={draft}
              rows={1}
              maxLength={4000}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(e) => { setDraft(e.target.value); mention.track() }}
              onKeyUp={mention.track}
              onClick={mention.track}
              onKeyDown={(e) => {
                if (mention.onKeyDown(e)) return
                // ↑ in an empty box edits what you last said, as in Slack.
                if (e.key === 'ArrowUp' && !draft && !e.nativeEvent.isComposing) {
                  const last = [...(messages[thread.view!] || [])].reverse().find((m) => m.mine && m.kind === 'message' && !m.deleted)
                  if (last) { e.preventDefault(); setEditing({ id: last.id, text: last.body }) }
                  return
                }
                // Bold, italic, strike, as everywhere.
                if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ['b', 'i'].includes(e.key.toLowerCase())) {
                  e.preventDefault()
                  const el = e.currentTarget
                  const mark = e.key.toLowerCase() === 'b' ? '*' : '_'
                  const a = el.selectionStart, b = el.selectionEnd
                  setDraft(draft.slice(0, a) + mark + draft.slice(a, b) + mark + draft.slice(b))
                  requestAnimationFrame(() => el.setSelectionRange(a + 1, b + 1))
                  return
                }
                // Enter sends; Shift-Enter is a new line; an IME converting
                // Japanese owns Enter until it is done.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(thread.view!, e.metaKey || e.ctrlKey) }
              }}
              disabled={sending}
            />
            {mention.menu}
            <SlashMenu draft={draft} onPick={(name) => { setDraft(`/${name} `); composer.current?.focus() }} />
            <div className="slk-composer-bar">
              <FormatBar target={composer} value={draft} set={setDraft} />
              <span className="slk-composer-hint">{t('Enter to send · ⌘Enter sends and asks your AI for a decision · / for commands')}</span>
              <button type="button" className="slk-send ai" disabled={sending || !draft.trim()} onClick={() => void send(thread.view!, true)}>
                {t('Send as a decision')}
              </button>
              <span className="slk-send-group">
                <button type="submit" className="slk-send" disabled={sending || !draft.trim()} aria-label={t('Send')}>
                  <Icon name="send" size={16} />
                </button>
                <button type="button" className="slk-send more" disabled={sending || !draft.trim() || draft.trim().startsWith('/')} onClick={() => setScheduleOpen((o) => !o)} aria-label={t('Schedule message')} title={t('Schedule message')} aria-expanded={scheduleOpen}>
                  <span aria-hidden="true">⌄</span>
                </button>
                {scheduleOpen && <SchedulePicker onPick={(at) => void sendAtTime(thread.view!, at)} onClose={() => setScheduleOpen(false)} />}
              </span>
            </div>
          </form>
        ) : thread.app === 'ai' ? (
          // Your AI is somebody you write to, like anyone else in the list:
          // what you write here is an instruction, routed as one.
          <form className="slk-composer" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onTellAI(draft.trim()); setDraft('') } else composer.current?.focus() }}>
            <textarea
              ref={composer}
              className="slk-input"
              value={draft}
              rows={1}
              maxLength={4000}
              placeholder={t('Tell your AI — who decides what, by when')}
              aria-label={t('Tell your AI')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (draft.trim()) { onTellAI(draft.trim()); setDraft('') }
                }
              }}
            />
            <div className="slk-composer-bar">
              <span className="slk-composer-hint">{t('Enter to send — your AI makes it a card for whoever decides')}</span>
              <button type="submit" className="slk-send" aria-label={t('Send')}><Icon name="send" size={16} /></button>
            </div>
          </form>
        ) : (
          <button className="slk-compose" onClick={onCompose}>
            <Icon name="plus" size={15} />
            <span>{t('Tell your AI…')}</span>
          </button>
        )}
      </>
    )
  }

  const waiting = pending.length

  // Getting started: five things that make the list worth opening, ticked
  // off as they happen, until they all have or the person says enough.
  const onboardKey = `onboard.hidden:${api.orgId}`
  const [onboardHidden, setOnboardHidden] = useState(() => { try { return Boolean(localStorage.getItem(onboardKey)) } catch { return false } })
  const [toolsSeen, setToolsSeen] = useState(() => { try { return Boolean(localStorage.getItem(`onboard.tools:${api.orgId}`)) } catch { return false } })
  const steps = [
    { id: 'ai', done: sent.length > 0 || [...pending, ...decided].some((c) => c.senderUserID === userId), label: t('Tell your AI something to decide'), go: () => { const ai = apps.find((a) => a.app === 'ai'); if (ai) choose(ai.key); requestAnimationFrame(() => composer.current?.focus()) } },
    { id: 'channel', done: businesses.length > 0, label: t('Make a channel for a business'), go: () => { setAdding(true) } },
    { id: 'invite', done: members.length > 1, label: t('Invite a teammate'), go: () => (onOpenScreen ? onOpenScreen('team') : onWorkspace()) },
    { id: 'decide', done: decided.length > 0, label: t('Decide your first card'), go: () => { const w = everything.find((x) => x.unread > 0); if (w) choose(w.key) } },
    { id: 'tools', done: toolsSeen, label: t('Connect Gmail, Slack or another tool'), go: () => { try { localStorage.setItem(`onboard.tools:${api.orgId}`, '1') } catch {}; setToolsSeen(true); onOpenScreen?.('tools') } },
  ]
  const stepsDone = steps.filter((x) => x.done).length
  const checklist = !onboardHidden && stepsDone < steps.length ? (
    <section className="slk-onboard" aria-label={t('Getting started')}>
      <div className="slk-onboard-head">
        <b>{t('Getting started')}</b>
        <span>{stepsDone}/{steps.length}</span>
        <button type="button" onClick={() => { try { localStorage.setItem(onboardKey, '1') } catch {}; setOnboardHidden(true) }} aria-label={t('Hide')}>×</button>
      </div>
      <div className="slk-onboard-bar"><i style={{ width: `${(stepsDone / steps.length) * 100}%` }} /></div>
      <ul>
        {steps.map((x) => (
          <li key={x.id} className={x.done ? 'done' : ''}>
            <button type="button" onClick={x.go} disabled={x.done} data-step={x.id}>
              <span aria-hidden="true">{x.done ? '✓' : '○'}</span>{x.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  ) : null

  return (
    <div className={`classic slk${current || activityOpen || laterOpen ? ' in-thread' : ''}${detail || thread ? ' with-pane' : ''}`}>
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
        {checklist}
        {!current && problem && <p className="cl-problem" role="alert">{problem}</p>}
        <nav className="slk-sections">
          <ul className="slk-special">
            <li className={`cl-row cl-thread${activityOpen ? ' on' : ''}${activityUnread ? ' unread' : ''}`}>
              <button className="cl-open" onClick={openActivity} aria-current={activityOpen ? 'true' : undefined} data-activity="1">
                <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="bell" size={14} /></span>
                <span className="cl-title">{t('Activity')}</span>
                {activityUnread > 0 && <span className="cl-badge">{activityUnread}</span>}
              </button>
            </li>
            <li className={`cl-row cl-thread${laterOpen ? ' on' : ''}`}>
              <button className="cl-open" onClick={() => { setOpenKey(null); setActivityOpen(false); setLaterOpen(true); void loadLater() }} aria-current={laterOpen ? 'true' : undefined} data-later="1">
                <span className="cl-lead cl-app sz-row" aria-hidden="true">🔖</span>
                <span className="cl-title">{t('Later')}</span>
                {(laterItems || []).length > 0 && <span className="cl-count">{laterItems!.length}</span>}
              </button>
            </li>
          </ul>
          {section('channels', t('Channels'), channels, t('No channels yet. Make one, or let your AI file decisions under a business as they arrive.'), addChannel, addChannelForm)}
          {section('people', t('Direct messages'), people, t('Nobody has sent you a decision yet.'))}
          {section('apps', t('Apps'), apps, t('Connect Gmail or Slack under Tools and their decisions land here.'))}
        </nav>
      </aside>
      <main className="slk-main">
        {activityOpen ? activityView() : laterOpen ? laterView() : current ? conversation(current) : (
          <div className="slk-none"><p>{t('Pick a conversation.')}</p></div>
        )}
      </main>
      {detail && (
        <aside className="slk-pane" aria-label={t('Decision')}>
          <header className="slk-pane-head">
            <button className="slk-back pane" onClick={() => setDetailId(null)} aria-label={t('Back')}><span aria-hidden="true">‹</span></button>
            <h2>{t('Decision')}</h2>
            {detail.business && <span className="slk-pane-where">#{nameOfBusiness(detail.business)}</span>}
            <button className="slk-pane-feed" onClick={() => onOpen(detail.id)} title={t('Open in Cards')}>{t('Open in Cards')}</button>
            <button className="slk-pane-close" onClick={() => setDetailId(null)} aria-label={t('Close')}>×</button>
          </header>
          <div className="slk-pane-body">{renderCard(detail)}</div>
        </aside>
      )}
      {!detail && thread && (
        <aside className="slk-pane slk-thread-pane" aria-label={t('Thread')}>
          <header className="slk-pane-head">
            <button className="slk-back pane" onClick={() => setThread(null)} aria-label={t('Back')}><span aria-hidden="true">‹</span></button>
            <h2>{t('Thread')}</h2>
            {current && <span className="slk-pane-where">{current.kind === 'channel' ? `#${current.name}` : current.name}</span>}
            <button className="slk-pane-close" onClick={() => setThread(null)} aria-label={t('Close')}>×</button>
          </header>
          <div className="slk-thread-log">
            {[thread.parent, ...thread.replies].map((m, i) => (
              <React.Fragment key={m.id}>
                {block(m.id, {
                  joined: false, at: m.createdAt, app: m.kind === 'ai' ? 'ai' : '', badge: m.kind === 'ai' ? t('AI') : undefined,
                  name: m.kind === 'ai' ? t('Your AI') : (m.mine ? t('You') : m.authorName || t('a teammate')),
                  msgId: i === 0 ? `thread-${m.id}` : m.id,
                  tools: toolsFor(thread.channel, m, true),
                }, (
                  <>
                    {words(thread.channel, m)}
                    {m.cardId && cardsById.get(m.cardId) && attachment(cardsById.get(m.cardId)!)}
                    {underneath(thread.channel, m, true)}
                  </>
                ))}
                {i === 0 && (
                  <div className="slk-thread-count" role="separator">
                    <span>{thread.replies.length === 1 ? t('1 reply') : t('{n} replies', { n: thread.replies.length })}</span>
                  </div>
                )}
              </React.Fragment>
            ))}
            {aiSteps(thinking[thread.channel])}
          </div>
          <form className="slk-composer thread" onSubmit={(e) => { e.preventDefault(); void send(thread.channel, false, thread.parent.id) }}>
            <textarea
              ref={threadComposer}
              className="slk-input"
              value={threadDraft}
              rows={1}
              maxLength={4000}
              placeholder={t('Reply… — @AI makes it a decision')}
              aria-label={t('Reply in thread')}
              onChange={(e) => { setThreadDraft(e.target.value); threadMention.track() }}
              onKeyUp={threadMention.track}
              onClick={threadMention.track}
              onKeyDown={(e) => {
                if (threadMention.onKeyDown(e)) return
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(thread.channel, e.metaKey || e.ctrlKey, thread.parent.id) }
              }}
              disabled={sending}
            />
            {threadMention.menu}
            <div className="slk-composer-bar">
              <FormatBar target={threadComposer} value={threadDraft} set={setThreadDraft} />
              <span className="slk-composer-hint" />
              <button type="submit" className="slk-send" disabled={sending || !threadDraft.trim()} aria-label={t('Send')}>
                <Icon name="send" size={16} />
              </button>
            </div>
          </form>
        </aside>
      )}
    </div>
  )
}
