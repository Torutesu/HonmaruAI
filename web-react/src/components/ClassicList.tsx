import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { awaitsPost } from '../utils/automation'
import type { DecisionCard, Business, ChannelMessage } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName, properName } from '../utils/names'
import { Icon } from './Icon'
import { BrandLogo, isBrand } from './BrandLogo'
import { useT } from '../utils/i18n'
import { useMembers } from '../utils/mentions'
import { useMentionMenu } from './MentionMenu'
import { MessageActions, Reactions, EmojiPicker, FormatBar, renderRich, SlashMenu, SchedulePicker, parseScheduleCommand } from './MessageParts'
import { ChannelJournal, ChannelDetails, JamButton, JamBar } from './ChannelPanes'
import type { DetailsTab, JournalCite } from './ChannelPanes'
import { JamCall } from '../utils/jam'
import { JamPanel } from './JamPanel'
import type { JamMode, JamState } from '../utils/jam'
import { InviteDialog } from './InviteDialog'
import { Avatar } from './Avatar'
import { Sheet, SheetRow, MessageSheet, PeoplePicker, longPress } from './Sheet'
import { useUploads, PendingUploads, MessageFiles } from './Attachments'
import { playSound, setOpenView, rememberLevels, startRing, stopRing } from '../utils/sound'
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
  onCreateChannel: (name: string, opts?: { private?: boolean }) => Promise<string | null>
  onRenameChannel: (slug: string, name: string) => Promise<string | null>
  onDeleteChannel: (slug: string) => Promise<string | null>
  /// Another screen: the team to invite, tools to connect, you.
  onOpenScreen?: (screen: 'team' | 'tools' | 'profile') => void
}

/// One conversation in the sidebar: a channel (a business), a person, or an app.
interface Thread {
  key: string
  /// A group is a DM with several people (`g:<id>`).
  kind: 'channel' | 'person' | 'group' | 'app'
  /// A group's people besides you, by ref.
  refs?: string[]
  /// A channel only its members see.
  private?: boolean
  memberCount?: number
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
interface Member {
  ref: string; name: string; title?: string; mine: boolean; loginHash: string
  handle?: string | null
  avatarUrl?: string | null
  status?: { emoji: string | null; text: string | null; until: string | null } | null
  awayUntil?: string | null
}
interface Activity { channel: string; lastAt: string; preview: string; lastBy: string | null }
/// Whose face goes beside something: a name, and their photo if they have one.
interface Face { name: string; url?: string | null }
/// One notification: somebody named you, replied in your thread, or reacted
/// to what you wrote.
interface ActivityItem { type: 'mention' | 'reply' | 'reaction'; message: ChannelMessage; unread: boolean; at?: string; emoji?: string; by?: string | null; byAvatar?: string | null }

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
  /// The summary, unless it only repeats the title — which it does for a
  /// card written without a model, where both are the person's own words.
  const summaryOf = (c: DecisionCard) => {
    const text = c.localized?.[locale]?.summary || c.summary
    const flat = (x?: string | null) => String(x || '').replace(/\s+/g, ' ').trim()
    return text && flat(text) !== flat(titleOf(c)) ? text : ''
  }
  const nameOfBusiness = (slug?: string) => businesses.find((b) => b.slug === slug)?.name || slug || ''
  const isMine = (c: DecisionCard) => c.senderUserID === userId && c.recipientUserID !== userId
  const isUnread = (c: DecisionCard) => c.status === 'pending' && c.recipientUserID === userId

  // The team, and what has been said where: loaded once, kept current by
  // the relay's channel events.
  const [members, setMembers] = useState<Member[]>([])
  // Group DMs you are in, and who else is in each.
  const [groups, setGroups] = useState<Array<{ view: string; refs: string[] }>>([])
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const [channelsTick, setChannelsTick] = useState(0)
  const [activity, setActivity] = useState<Record<string, Activity>>({})
  const [seenTick, setSeenTick] = useState(0)
  // How loud each conversation may be: all (the default), mentions, mute.
  const [prefs, setPrefs] = useState<Record<string, 'mentions' | 'mute'>>({})
  // The sound for a message is decided where the socket is; it needs to
  // know what you muted and what you are looking at.
  useEffect(() => { rememberLevels(api.orgId, prefs) }, [api.orgId, prefs])
  // Read positions from the server: the same on the phone and the laptop.
  const [serverReads, setServerReads] = useState<Record<string, string>>({})
  const readAt = (v: string) => [seenAt(api.orgId, v), serverReads[v] || ''].sort().pop() || ''
  const authHeaders = useMemo(() => ({ 'x-session-token': api.sessionToken }), [api.sessionToken])
  useEffect(() => {
    let ignore = false
    let tz = ''
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { /* the server keeps what it had */ }
    fetch(`${api.httpBase}/channels?orgId=${encodeURIComponent(api.orgId)}${tz ? `&tz=${encodeURIComponent(tz)}` : ''}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (ignore || !data) return
        setMembers(data.members || [])
        setGroups(data.groups || [])
        setActivity(Object.fromEntries((data.activity || []).map((a: Activity) => [a.channel, a])))
        setServerReads(data.reads || {})
        setPrefs(data.prefs || {})
      })
      .catch(() => { /* the list still shows every decision */ })
    return () => { ignore = true }
  }, [api.httpBase, api.orgId, authHeaders, channelsTick])
  // A group somebody just started with you.
  useEffect(() => {
    const on = (e: Event) => {
      const g = (e as CustomEvent<{ view: string; refs: string[] }>).detail
      if (g?.view) setGroups((prev) => (prev.some((x) => x.view === g.view) ? prev : [...prev, g]))
    }
    window.addEventListener('honmaru:channel-group', on)
    return () => window.removeEventListener('honmaru:channel-group', on)
  }, [])

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
      return { ...th, lastAt: a.lastAt, fresh: !prefs[th.view!] && a.lastBy !== 'me' && a.lastAt > readAt(th.view!) }
    }

    // Channels: one per business the team has, in the team's order — empty
    // ones too, a channel just made is a channel — plus any slug a card
    // names that the table has not caught up with yet.
    const bySlug = new Map<string, DecisionCard[]>()
    for (const c of cards) if (c.business) bySlug.set(c.business, [...(bySlug.get(c.business) || []), c])
    const slugs = [...businesses.map((b) => b.slug), ...[...bySlug.keys()].filter((s) => !businesses.some((b) => b.slug === s))]
    const channels = slugs
      .map((slug) => {
        const b = businesses.find((x) => x.slug === slug)
        return build('channel', `channel:${slug}`, nameOfBusiness(slug), { slug, view: `b:${slug}`, private: Boolean(b?.private), memberCount: b?.memberCount }, bySlug.get(slug) || [], true)
      })
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
    // Group DMs, named by their people, as a chat client names them.
    const nameOfRef = (ref: string) => members.find((m) => m.ref === ref)?.name || t('a teammate')
    const grouped = groups.map((g) => withTalk(build('group', `group:${g.view}`, g.refs.map(nameOfRef).join(', '), { view: g.view, refs: g.refs }, [], true)!))
    const latestOf = (th: Thread) => [th.lastAt || '', th.latest ? stamp(th.latest) : ''].sort().pop() || ''
    const people = [...teammates, ...grouped, ...former]
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
  }, [pending, sent, decided, businesses, userId, locale, members, hashes, activity, seenTick, serverReads, prefs, groups])

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

  // Bringing people or an agent in, from the list itself.
  const [inviting, setInviting] = useState<null | 'people' | 'agent'>(null)
  // On a phone the list is five places along the bottom, as in Slack's app:
  // Home and DMs here, Activity and Later below, You is a screen of its own.
  const [phoneTab, setPhoneTab] = useState<'home' | 'dms'>('home')
  // The round button's choices, and the people picker behind "New message".
  const [starting, setStarting] = useState<null | 'menu' | 'people'>(null)
  // Everything behind ⋯ in a conversation's header, on a phone.
  const [convSheet, setConvSheet] = useState(false)
  // A word that something happened — "Link copied" — for two seconds.
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 2200); return () => clearTimeout(id) }, [toast])

  // The Activity inbox: what named you, and replies in your threads.
  const [activityOpen, setActivityOpen] = useState(false)
  const [activityItems, setActivityItems] = useState<ActivityItem[] | null>(null)
  // What was unread when you opened it stays marked while you are there —
  // the Unread tab is for exactly that — but the badge goes at once.
  const [activitySeenAt, setActivitySeenAt] = useState('')
  const [activityTab, setActivityTab] = useState<'all' | 'unread'>('all')
  const [activityPick, setActivityPick] = useState<string | null>(null)
  const loadActivity = useCallback(() => {
    return fetch(`${api.httpBase}/channels/activity?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setActivityItems(data.items || []) })
      .catch(() => { /* nothing new is the same as nothing loaded */ })
  }, [api.httpBase, api.orgId, authHeaders])
  useEffect(() => { void loadActivity() }, [loadActivity])
  const stillNew = (i: ActivityItem) => i.unread && (i.at || i.message.createdAt) > activitySeenAt
  const activityUnread = (activityItems || []).filter(stillNew).length
  // Unread mentions per conversation: what still calls for you in a
  // conversation set to mentions only, or muted.
  const mentionsIn = useMemo(() => {
    const out: Record<string, number> = {}
    for (const i of activityItems || []) if (stillNew(i) && i.type === 'mention') out[i.message.channel] = (out[i.message.channel] || 0) + 1
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityItems, activitySeenAt])
  const openActivity = () => {
    setOpenKey(null)
    setLaterOpen(false)
    setActivityOpen(true)
    setDetailId(null)
    setActivityPick(null)
    void loadActivity().then(() => {
      const at = new Date().toISOString()
      fetch(`${api.httpBase}/channels/read`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel: 'activity', at }),
      }).then(() => setActivitySeenAt(at)).catch(() => {})
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
  const [newPrivate, setNewPrivate] = useState(false)
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
    const err = await onCreateChannel(name, { private: newPrivate })
    setBusy(false)
    if (err) { setProblem(err); return }
    setNewName(''); setAdding(false); setNewPrivate(false)
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


  const setPref = async (v: string, level: 'all' | 'mentions' | 'mute') => {
    const res = await fetch(`${api.httpBase}/channels/prefs`, { method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, channel: v, level }) }).catch(() => null)
    if (!res?.ok) { setProblem(t('That did not save.')); return }
    setPrefs((prev) => { const next = { ...prev }; if (level === 'all') delete next[v]; else next[v] = level; return next })
  }
  /// A routine that writes this channel up for you every evening.
  const dailySummary = async (thread: Thread) => {
    const text = locale === 'ja' ? `毎日18時に #${thread.name} の会話と決定をまとめて` : `Every day at 18:00 summarise the conversation and decisions in #${thread.name}`
    const post = (path: string, body: unknown) => fetch(`${api.httpBase}${path}`, { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const parsed = await post('/routines/parse', { text, locale }).then((r) => r.json()).then((d) => d.parsed).catch(() => null)
    if (!parsed) { setProblem(t('That did not save.')); return }
    const res = await post('/routines', { orgId: api.orgId, kind: 'report', instruction: parsed.instruction || text, cadence: parsed.cadence, hour: parsed.hour, minute: parsed.minute }).catch(() => null)
    if (!res?.ok) { setProblem(((await res?.json().catch(() => null))?.message) || t('That did not save.')); return }
    if (thread.view) note(thread.view, t('Every evening at 18:00 your AI will send you a summary of #{name} as a card.', { name: thread.name }))
    setSettings(false)
  }

  // A teammate's profile, beside the conversation.
  const [profile, setProfile] = useState<null | { ref: string; data?: { name: string; handle: string | null; title: string; timezone: string | null; status: Member['status']; awayUntil: string | null; joinedAt: string; mine: boolean; stats: { waiting: number; decided90d: number; medianMinutes: number | null } } }>(null)
  const openProfile = async (ref: string) => {
    setDetailId(null); setThread(null)
    setProfile({ ref })
    const res = await fetch(`${api.httpBase}/channels/member?orgId=${encodeURIComponent(api.orgId)}&ref=${encodeURIComponent(ref)}`, { headers: authHeaders }).catch(() => null)
    const d = res?.ok ? await res.json().catch(() => null) : null
    if (d?.member) setProfile((prev) => (prev && prev.ref === ref ? { ref, data: d.member } : prev))
  }

  // Keys a chat client has: ⌥↑/⌥↓ between conversations, ⌘⇧A Activity,
  // ⌘⇧D the sidebar.
  const [sideHidden, setSideHidden] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const list = [...channels, ...people, ...apps]
        if (!list.length) return
        e.preventDefault()
        const i = list.findIndex((x) => x.key === current?.key)
        const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]
        if (next) choose(next.key)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault(); openActivity()
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault(); setSideHidden((h) => !h)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- The sidebar ----

  const lead = (thread: Thread, size: 'row' | 'head') => {
    const online = thread.login ? presence[thread.login] === 'online' : false
    if (thread.kind === 'channel') {
      return thread.private
        ? <span className={`cl-lead cl-hash cl-lock sz-${size}`} aria-hidden="true"><Icon name="lock" size={size === 'head' ? 16 : 13} /></span>
        : <span className={`cl-lead cl-hash sz-${size}`} aria-hidden="true">#</span>
    }
    if (thread.kind === 'group') {
      const faces = (thread.refs || []).slice(0, 2).map((r) => memberByRef(r))
      return (
        <span className={`cl-lead cl-group sz-${size}`} aria-hidden="true">
          {faces.map((m, i) => <Avatar key={i} name={m?.name || '?'} url={m?.avatarUrl} size={size === 'head' ? 22 : 15} />)}
          <b>{(thread.refs || []).length + 1}</b>
        </span>
      )
    }
    if (thread.kind === 'person') {
      return (
        <span className={`cl-lead cl-avatar has-face sz-${size}`} aria-hidden="true">
          <Avatar name={thread.name} url={members.find((m) => thread.view === `dm:${m.ref}`)?.avatarUrl} size={size === 'head' ? 30 : 20} />
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
      <li key={thread.key} data-view={thread.view} className={`cl-row cl-thread${thread.unread || (thread.fresh && !on) ? ' unread' : ''}${on ? ' on' : ''}${thread.view && prefs[thread.view] === 'mute' ? ' muted' : ''}`}>
        <button className="cl-open" onClick={() => choose(thread.key)} aria-current={on ? 'true' : undefined}>
          {lead(thread, 'row')}
          <span className="cl-title">{thread.name}</span>
          {thread.kind === 'person' && (() => {
            const m = members.find((x) => thread.view === `dm:${x.ref}`)
            if (!m) return null
            return <>{m.status?.emoji && <span className="cl-status" title={m.status.text || ''}>{m.status.emoji}</span>}{m.awayUntil && <span className="cl-away" title={t('Away until {when}', { when: new Date(m.awayUntil).toLocaleDateString(locale) })}>{t('away')}</span>}</>
          })()}
          {thread.view && prefs[thread.view] === 'mute' && <span className="cl-muted" role="img" aria-label={t('Muted')}><Icon name="bell-off" size={13} /></span>}
          {thread.view && (mentionsIn[thread.view] || 0) > 0 && thread.unread === 0 && <span className="cl-badge mention">@{mentionsIn[thread.view]}</span>}
          {thread.unread > 0 && <span className="cl-badge">{thread.unread}</span>}
          {thread.unread === 0 && thread.fresh && !on && <span className="cl-fresh" aria-label={t('New messages')} />}
          {!on && thread.view && drafts[thread.view] && <span className="cl-draft" title={t('Draft')} aria-label={t('Draft')}><Icon name="edit" size={12} /></span>}
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
            <span className="cl-caret" aria-hidden="true"><Icon name={shut ? 'chevron-right' : 'chevron-down'} size={12} /></span>
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
      <label className="cl-private-toggle" title={t('Only the people you add can see a private channel.')}>
        <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} data-private="1" />
        <Icon name="lock" size={12} />{t('Private')}
      </label>
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
  // Files going up with the next message: the conversation's, and a thread's.
  const uploads = useUploads(api, setProblem)
  const threadUploads = useUploads(api, setProblem)
  const [dropping, setDropping] = useState(false)
  const attachInput = useRef<HTMLInputElement>(null)
  const threadAttachInput = useRef<HTMLInputElement>(null)
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
      if (m.channel.startsWith('g:') && !groupsRef.current.some((g) => g.view === m.channel)) setChannelsTick((n) => n + 1)
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
    const up = parentId ? threadUploads : uploads
    if ((!body && !up.ids.length) || sending) return
    if (up.busy) { setProblem(t('Wait for the files to finish uploading.')); return }
    if (sendAt && up.ids.length) { setProblem(t('A scheduled message cannot carry files yet.')); return }
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
        body: JSON.stringify({ orgId: api.orgId, channel, body, decide, ...(parentId ? { parentId } : {}), ...(sendAt ? { sendAt } : {}), ...(up.ids.length ? { files: up.ids } : {}) }),
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
      // Sent: a small confirmation, in a direct conversation — as Slack does.
      if (channel.startsWith('dm:')) playSound('sent')
      up.clear()
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
  // Before paint, so a conversation never shows an empty box first.
  useLayoutEffect(() => {
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
  // Which conversation is on screen, for the sound a new message makes.
  const openView = !activityOpen && !laterOpen ? (current?.view || null) : null
  useEffect(() => { setOpenView(openView); return () => { setOpenView(null) } }, [openView])
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
  // On a phone: a long press on a message brings up what you can do to it.
  const [sheet, setSheet] = useState<{ channel: string; m: ChannelMessage; inThread: boolean } | null>(null)
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
    setProfile(null)
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setEditing(null); setThread(null); setPins(null); setPickerFor(null); uploads.clear() }, [current?.key])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { threadUploads.clear() }, [thread?.parent.id])
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
  // From a link to a message: ask where it is for you, then go there.
  useEffect(() => {
    const go = (id: string) => {
      fetch(`${api.httpBase}/channels/locate?orgId=${encodeURIComponent(api.orgId)}&messageId=${encodeURIComponent(id)}`, { headers: authHeaders })
        .then((r) => (r.ok ? r.json() : null))
        .then((where) => { if (where?.view) openAt(where); else setToast(t('That message is not somewhere you can read.')) })
        .catch(() => {})
    }
    const on = (e: Event) => { try { sessionStorage.removeItem('list.jumpId') } catch {}; go(String((e as CustomEvent).detail || '')) }
    window.addEventListener('honmaru:open-message-id', on)
    try {
      const saved = sessionStorage.getItem('list.jumpId')
      if (saved && everything.length) { sessionStorage.removeItem('list.jumpId'); setTimeout(() => go(saved), 300) }
    } catch { /* nothing to go to */ }
    return () => window.removeEventListener('honmaru:open-message-id', on)
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

  // ---- What to tell your AI ----
  // Suggested from this person's own work — teammates, channels, what is
  // waiting — by the Worker; the examples everyone used to see only when it
  // cannot be reached.
  const [aiSamples, setAiSamples] = useState<string[] | null>(null)
  const [samplesBusy, setSamplesBusy] = useState(false)
  const loadSamples = useCallback(async (refresh = false) => {
    setSamplesBusy(true)
    if (refresh) setAiSamples(null)
    const res = await fetch(`${api.httpBase}/ai/suggestions?orgId=${encodeURIComponent(api.orgId)}${refresh ? '&refresh=1' : ''}`, { headers: authHeaders }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    const texts = Array.isArray(data?.suggestions) ? data.suggestions.map((x: { text?: string }) => x?.text).filter((x: unknown): x is string => typeof x === 'string' && x.length > 0) : []
    setAiSamples(texts.length ? texts : [t('Every Monday at 9, summarise last week’s decisions'), t('Remind the team to submit expenses by the 25th')])
    setSamplesBusy(false)
  }, [api.httpBase, api.orgId, authHeaders, t])
  const aiOpen = current?.app === 'ai'
  useEffect(() => { if (aiOpen && aiSamples === null && !samplesBusy) void loadSamples() }, [aiOpen, aiSamples, samplesBusy, loadSamples])
  useEffect(() => { setAiSamples(null) }, [api.orgId])

  // ---- The decision pane ----
  // A decision opens beside the conversation — as a chat client opens a
  // thread — never by leaving the list for the feed.
  const [detailId, setDetailId] = useState<string | null>(null)
  const detail = detailId ? cardsById.get(detailId) : undefined
  const openCard = (id: string) => { setThread(null); setProfile(null); setSide(null); setDetailId(id) }

  // ---- What the header opens ----
  // The journal ("Context"), or the channel's details on one of its tabs.
  const [side, setSide] = useState<null | { kind: 'journal' } | { kind: 'details'; tab: DetailsTab }>(null)
  const openSide = (next: { kind: 'journal' } | { kind: 'details'; tab: DetailsTab }) => {
    setDetailId(null); setThread(null); setProfile(null); setPins(null)
    setSide((prev) => (prev && prev.kind === next.kind && (prev.kind === 'journal' || (next.kind === 'details' && prev.kind === 'details' && prev.tab === next.tab)) ? null : next))
  }
  useEffect(() => { setSide(null) }, [current?.key])
  // How many automations run into each channel, for the header's count.
  const [automationCount, setAutomationCount] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!view || !view.startsWith('b:') || automationCount[view] !== undefined) return
    let ignore = false
    fetch(`${api.httpBase}/channels/details?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(view)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!ignore && d?.counts) setAutomationCount((prev) => ({ ...prev, [view]: d.counts.automations })) })
      .catch(() => { /* the button still opens the panel */ })
    return () => { ignore = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, api.httpBase, api.orgId, authHeaders])
  /// A journal line's citation: the message, in its conversation — loading
  /// back to it when it is further up than what is loaded — or its thread.
  const goToCite = async (channel: string, cite: JournalCite) => {
    if (cite.parentId) {
      const list = messagesRef.current[channel] || []
      const parent = list.find((m) => m.id === cite.parentId) || ({ id: cite.parentId, channel, kind: 'message', body: '', authorName: null, authorRef: null, mine: false, cardId: null, createdAt: '' } as ChannelMessage)
      setSide(null)
      void openThread(channel, parent)
      return
    }
    let list = messagesRef.current[channel] || []
    let older = more[channel]
    for (let page = 0; page < 20 && older && list.length && !list.some((m) => m.id === cite.id); page += 1) {
      const res = await fetch(`${api.httpBase}/channels/messages?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&before=${encodeURIComponent(list[0].createdAt)}`, { headers: authHeaders }).catch(() => null)
      const data = res?.ok ? await res.json().catch(() => null) : null
      if (!data) break
      const got = (data.messages || []) as ChannelMessage[]
      const known = new Set(list.map((m) => m.id))
      list = [...got.filter((m) => !known.has(m.id)), ...list]
      older = got.length >= PAGE
    }
    const merged = list
    setMessages((prev) => ({ ...prev, [channel]: merged }))
    setMore((prev) => ({ ...prev, [channel]: Boolean(older) }))
    setTimeout(() => jumpTo(cite.id), 80)
  }

  // ---- Jam ----
  // Who is talking in which channel, and the call this tab is in.
  const [jams, setJams] = useState<Record<string, JamState>>({})
  const [call, setCall] = useState<JamCall | null>(null)
  const [, setCallTick] = useState(0)
  // The call's own panel beside the conversation; tucked away, the bar.
  const [jamShown, setJamShown] = useState(true)
  // Being called: a Jam somebody started in a conversation of two with you.
  const [ringing, setRinging] = useState<{ channel: string; name: string; avatarUrl: string | null } | null>(null)
  const declined = useRef<Set<string>>(new Set())
  const [jamBusy, setJamBusy] = useState(false)
  const callRef = useRef<JamCall | null>(null)
  callRef.current = call
  useEffect(() => {
    const on = (e: Event) => {
      const { name, value } = (e as CustomEvent<{ name: string; value: any }>).detail || {}
      if (name === 'jam_state' && value?.channel) {
        setJams((prev) => {
          const next = { ...prev }
          if (value.active) next[value.channel] = value as JamState
          else delete next[value.channel]
          return next
        })
        // A Jam just started in a direct conversation, by the other person,
        // and you are not in a call: it rings — until answered, declined,
        // joined by you, over, or thirty seconds pass.
        const state = value as JamState
        const mineRef = membersRef.current.find((m) => m.mine)?.ref
        const caller = state.participants?.[0]
        const fresh = state.startedAt && Date.now() - Date.parse(state.startedAt) < 45_000
        const shouldRing = state.active && /^(dm|g):/.test(String(value.channel)) && state.participants.length === 1
          && caller && caller.ref !== mineRef && fresh && !callRef.current && !declined.current.has(`${value.channel}:${state.startedAt}`)
        if (shouldRing) {
          setRinging({ channel: value.channel, name: caller.name, avatarUrl: caller.avatarUrl || null })
          startRing()
        } else {
          setRinging((prev) => {
            if (prev && prev.channel === value.channel) { stopRing(); return null }
            return prev
          })
        }
      } else if (name === 'reset') {
        // The relay sends what is going on again after this.
        setJams({})
      }
    }
    window.addEventListener('honmaru:jam', on)
    return () => window.removeEventListener('honmaru:jam', on)
  }, [])
  // Leaving the list — or the page — leaves the call.
  useEffect(() => () => { void callRef.current?.leave() }, [])
  /// A Jam going on, shown where it started: how long, who, and a way in.
  const jamCard = (view: string, st: JamState) => {
    const here = Boolean(call && !call.ended && call.channel === view)
    return (
      <div className="jam-card" data-jam-card="1">
        <div className="jam-card-main">
          <span className="jam-card-live"><i aria-hidden="true" /> <JamClock from={st.startedAt} /></span>
          <span className="jam-card-faces" aria-label={st.participants.map((p) => p.name).join(', ')}>
            {st.participants.slice(0, 6).map((p) => <Avatar key={p.peerId} name={p.name} url={p.avatarUrl || memberByRef(p.ref)?.avatarUrl} size={24} round />)}
          </span>
          <span className="jam-card-sub">{st.participants.length === 1 && !here ? t('{name} is waiting for others…', { name: st.participants[0].name }) : st.participants.map((p) => p.name).join(', ')}</span>
        </div>
        {here
          ? <button type="button" className="jam-card-join leave" onClick={() => void leaveJam()}>{t('Leave')}</button>
          : <button type="button" className="jam-card-join" onClick={() => void startJam(view, { mode: st.mode })} disabled={jamBusy}>{t('Join')}</button>}
      </div>
    )
  }
  const whereOf = (view: string) => { const w = everything.find((x) => x.view === view); return w ? (w.kind === 'channel' ? `#${w.name}` : w.name) : '' }
  const leaveJam = async () => {
    const c = callRef.current
    setCall(null)
    if (c) { playSound('jamLeave'); setJamBusy(true); await c.leave(); setJamBusy(false) }
  }
  const startJam = async (channel: string, opts: { micId?: string; speakerId?: string; mode: JamMode }) => {
    if (jamBusy) return
    setJamBusy(true); setProblem(null)
    if (callRef.current) await callRef.current.leave()
    const where = everything.find((x) => x.view === channel)
    const c: JamCall = new JamCall({
      channel, mode: opts.mode, micId: opts.micId, speakerId: opts.speakerId,
      onChange: () => { setCallTick((n) => n + 1); if (c.ended && callRef.current === c) setCall(null) },
      onProblem: (m) => setProblem(t(m)),
      onPeople: (change) => playSound(change === 'joined' ? 'jamJoin' : 'jamLeave'),
      lang: locale,
      upload: async (blob, meta) => {
        const q = new URLSearchParams({ orgId: api.orgId, channel, mode: meta.mode, startedAt: meta.startedAt, endedAt: meta.endedAt, people: meta.people.join(',') })
        const res = await fetch(`${api.httpBase}/channels/jam/recording?${q}`, { method: 'POST', headers: { ...authHeaders, 'content-type': blob.type || 'audio/webm' }, body: blob })
        if (!res.ok) throw new Error('upload')
        note(channel, t('Your AI is writing notes from the Jam. They will appear in {where}.', { where: where?.kind === 'channel' ? `#${where.name}` : (where?.name || '') }))
      },
    })
    setCall(c)
    setJamShown(true)
    setRinging(null); stopRing()
    try {
      await c.start()
      playSound('jamJoin')
    } catch {
      setCall(null)
      setProblem(t('Your microphone could not be opened. Allow it for this site and try again.'))
    }
    setJamBusy(false)
  }
  useEffect(() => {
    if (!detailId && !thread) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('textarea, input')) { setDetailId(null); setThread(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailId, thread])
  // A phone gives a conversation, or a decision, the whole screen.
  // A conversation, a card or a thread takes the whole phone; Activity and
  // Later are tabs, with the tab bar under them.
  useEffect(() => { onImmersive(!wide && (Boolean(current && !activityOpen && !laterOpen) || Boolean(detail) || Boolean(thread))) }, [wide, current?.key, detail?.id, thread, activityOpen, laterOpen, onImmersive])
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
  /// A person as the list names them: the name they go by in this
  /// workspace, never the login a card carries ("Gotawazumi4").
  const nameOfLogin = (login?: string | null) => {
    if (!login) return ''
    const h = hashes.get(login)
    const m = h ? members.find((x) => x.loginHash === h) : undefined
    return m?.name || properName(login)
  }
  const nameOfRecipient = (c: DecisionCard) => (c as DecisionCard & { recipientName?: string }).recipientName || nameOfLogin(c.recipientUserID)
  const myName = members.find((m) => m.mine)?.name || ''
  const membersRef = useRef(members)
  membersRef.current = members
  const myAvatar = members.find((m) => m.mine)?.avatarUrl || null
  const memberByRef = (ref?: string | null) => (ref ? members.find((m) => m.ref === ref) : undefined)
  const memberOfLogin = (login?: string | null) => {
    const h = login ? hashes.get(login) : undefined
    return h ? members.find((x) => x.loginHash === h) : undefined
  }
  /// The face beside a message: yours, or whoever wrote it.
  const faceOfMessage = (m: ChannelMessage): Face => (m.mine
    ? { name: myName || t('You'), url: myAvatar }
    : { name: m.authorName || t('a teammate'), url: m.authorAvatar || memberByRef(m.authorRef)?.avatarUrl || null })

  const author = (c: DecisionCard) => {
    const app = appKey(c)
    if (app) return { name: app === 'ai' ? t('Your AI') : (APP_NAME[app] ? t(APP_NAME[app]) : c.sourceApp!), app, face: null }
    if (c.senderUserID === userId && c.recipientUserID === userId) return { name: t('Your AI'), app: 'ai', face: null }
    const mine = c.senderUserID === userId
    const name = mine ? t('You') : (c.requestedBy?.name || nameOfLogin(c.senderUserID))
    const face = mine
      ? { name: myName || name, url: myAvatar }
      : { name, url: memberOfLogin(c.senderUserID)?.avatarUrl || (c.requestedBy as { avatarUrl?: string } | undefined)?.avatarUrl || null }
    return { name, app: '', face }
  }

  const status = (c: DecisionCard) => {
    if (c.status === 'pending') {
      if (c.recipientUserID === userId) return { tone: 'waiting', text: t('Waiting on you') }
      return { tone: 'sent', text: t('Waiting on {name}', { name: nameOfRecipient(c) }) }
    }
    const decider = c.decision?.actorUserID
    const who = decider === userId ? t('you') : nameOfLogin(decider || c.recipientUserID)
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
          {isUnread(c) && (awaitsPost(c) ? (
            <button className="slk-action primary" onClick={() => openCard(c.id)}>{t('Review and post')}</button>
          ) : fyi ? (
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

  const avatarFor = (app: string, face: Face | null) => app
    ? <span className="slk-avatar app">{app === 'ai'
        ? <img src="/icon.svg" alt="" width={36} height={36} />
        : isBrand(app) ? <BrandLogo brand={app} size={20} /> : <Icon name={APP_ICON[app] || 'box'} size={18} />}</span>
    : <span className="slk-avatar face"><Avatar name={face?.name || '?'} url={face?.url} size={36} /></span>

  /// One block of a conversation: a gutter, a name and a time — or, joined
  /// to the one before, just the words — then what was said.
  const block = (key: string, opts: { joined: boolean; at: string; app: string; name: string; face?: Face | null; badge?: string; to?: string; unread?: boolean; tools?: React.ReactNode; msgId?: string; pinned?: boolean; authorRef?: string | null; onHold?: () => void }, body: React.ReactNode) => (
    <article key={key} id={opts.msgId ? `msg-${opts.msgId}` : undefined} tabIndex={opts.msgId ? -1 : undefined}
      {...(!wide ? longPress(opts.onHold) : {})}
      className={`slk-msg${opts.joined ? ' joined' : ''}${opts.unread ? ' unread' : ''}${opts.msgId && toolsOpen === opts.msgId ? ' tools-open' : ''}${opts.msgId && editing?.id === opts.msgId ? ' editing' : ''}${opts.pinned ? ' pinned' : ''}${opts.msgId && flash === opts.msgId ? ' flash' : ''}`}>
      <div className="slk-gutter" aria-hidden="true">
        {opts.joined ? <span className="slk-hover-time">{clock(opts.at)}</span> : avatarFor(opts.app, opts.face || { name: opts.name })}
      </div>
      <div className="slk-body">
        {opts.pinned && <div className="slk-pin-mark"><Icon name="pin" size={12} /> {t('Pinned')}</div>}
        {!opts.joined && (
          <div className="slk-meta">
            {opts.authorRef
              ? <button type="button" className="slk-author link" onClick={() => void openProfile(opts.authorRef!)}>{opts.name}</button>
              : <span className="slk-author">{opts.name}</span>}
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
            {(m.replyRefs || []).slice(0, 3).map((r) => <Avatar key={r} className="slk-face" name={nameOfRef(r)} url={memberByRef(r)?.avatarUrl} size={20} />)}
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
      <>
        {(m.body || m.editedAt) && (
          <div className="slk-text">
            {rich(m.body)}
            {m.editedAt && <span className="slk-edited" title={new Date(m.editedAt).toLocaleString(locale)}> {t('(edited)')}</span>}
          </div>
        )}
        <MessageFiles files={m.files} base={api.httpBase} />
      </>
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

  /// A long press, on a phone: the same things, in a sheet from the bottom.
  const holdFor = (channel: string, m: ChannelMessage, inThread = false) => (m.deleted || editing?.id === m.id)
    ? undefined
    : () => setSheet({ channel, m, inThread })
  /// A link to one message that opens it for anyone who can read it — the
  /// message's id, not the conversation's name, which differs per reader.
  const copyLink = (m: ChannelMessage) => {
    const url = `${location.origin}${location.pathname}#/m/${encodeURIComponent(m.id)}`
    void navigator.clipboard?.writeText(url).then(() => setToast(t('Link copied')), () => setToast(url))
  }

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
      <header className="slk-head slk-later-head">
        <button className="slk-back" onClick={() => setLaterOpen(false)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
        <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="bookmark" size={16} /></span>
        <div className="slk-head-text">
          <h1>{t('Later')}</h1>
          <p>{t('Messages you saved to come back to. A reminder brings one back to your feed as a card.')}</p>
        </div>
      </header>
      <div className="slk-log slk-activity">
        {laterItems && laterItems.length === 0 && (
          <div className="slk-start">
            <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="bookmark" size={16} /></span>
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
      return th ? (th.kind === 'channel' ? th.name : th.name) : v
    }
    const isChannel = (v: string) => everything.find((x) => x.view === v)?.kind === 'channel'
    const keyOf = (i: ActivityItem) => `${i.type}-${i.message.id}-${i.emoji || ''}-${i.at || ''}`
    const whoOf = (i: ActivityItem) => (i.type === 'reaction' ? (i.by || t('a teammate')) : i.message.kind === 'ai' ? t('Your AI') : (i.message.authorName || t('a teammate')))
    const verb = (i: ActivityItem) => (i.type === 'reaction' ? t('reacted') : i.type === 'reply' ? t('replied in a thread') : t('mentioned you'))
    const items = (activityItems || []).filter((i) => activityTab === 'all' || i.unread)
    const picked = (activityItems || []).find((i) => keyOf(i) === activityPick) || null
    const open = (i: ActivityItem) => {
      if (wide) setActivityPick(keyOf(i))
      else openAt({ view: i.message.channel, id: i.message.id, parentId: i.message.parentId })
    }
    const where = (v: string) => (
      <span className="slk-note-where">
        {isChannel(v) ? <Icon name="hash" size={11} /> : <Icon name="message" size={11} />}
        {nameOfView(v)}
      </span>
    )
    return (
      <div className="slk-inbox">
        <section className="slk-inbox-list" aria-label={t('Activity')}>
          <header className="slk-inbox-head">
            <button className="slk-back" onClick={() => setActivityOpen(false)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
            <div className="slk-inbox-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={activityTab === 'all'} onClick={() => setActivityTab('all')}>{t('All')}</button>
              <button type="button" role="tab" aria-selected={activityTab === 'unread'} onClick={() => setActivityTab('unread')} data-unread-tab="1">
                {t('Unread')}{(activityItems || []).some((i) => i.unread) ? <span className="slk-inbox-count">{(activityItems || []).filter((i) => i.unread).length}</span> : null}
              </button>
            </div>
            <button type="button" className="slk-inbox-action" onClick={() => setActivityItems((prev) => prev && prev.map((i) => ({ ...i, unread: false })))}
              aria-label={t('Mark all as read')} title={t('Mark all as read')}>
              <Icon name="check" size={15} />
            </button>
          </header>
          <div className="slk-inbox-rows slk-activity">
            {activityItems === null && <p className="slk-empty">{t('Loading…')}</p>}
            {activityItems && items.length === 0 && (
              <div className="slk-start">
                <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="bell" size={18} /></span>
                <h2>{activityTab === 'unread' ? t('All caught up') : t('Nothing for you yet')}</h2>
                <p>{t('When somebody writes @ your name, replies in a thread you are part of, or reacts to what you wrote, it shows up here.')}</p>
              </div>
            )}
            {items.map((i) => {
              const m = i.message
              const who = whoOf(i)
              return (
                <button key={keyOf(i)} type="button" className={`slk-act slk-note${i.unread ? ' unread' : ''}${activityPick === keyOf(i) ? ' on' : ''}`} onClick={() => open(i)} data-kind={i.type}>
                  <span className="slk-note-avatar" aria-hidden="true">{m.kind === 'ai' && i.type !== 'reaction'
                    ? <img src="/icon.svg" alt="" width={32} height={32} />
                    : <Avatar name={who} url={i.type === 'reaction' ? i.byAvatar : (m.authorAvatar || memberByRef(m.authorRef)?.avatarUrl)} size={32} />}</span>
                  <span className="slk-note-main">
                    <span className="slk-note-line">
                      <span className="slk-note-who"><b>{who}</b> {verb(i)}</span>
                      <span className="slk-act-when">{when(i.at || m.createdAt)}</span>
                    </span>
                    {where(m.channel)}
                    <span className="slk-act-body">{i.type === 'reaction' ? <>{t('You')}: </> : null}{m.body.slice(0, 280)}</span>
                    {i.type === 'reaction' && i.emoji && <span className="slk-note-reaction"><span>{i.emoji}</span> 1</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
        <section className="slk-inbox-view" aria-label={t('Notification')}>
          {!picked ? (
            <div className="slk-inbox-empty">
              <span className="slk-inbox-art" aria-hidden="true"><i /><Icon name="bell" size={22} /></span>
              <h2>{t('One at a time')}</h2>
              <p>{t('Select a notification on the left to see it here.')}</p>
            </div>
          ) : (
            <>
              <header className="slk-inbox-view-head">
                <div>
                  <h2>{whoOf(picked)} {verb(picked)}</h2>
                  {where(picked.message.channel)}
                </div>
                <button type="button" className="slk-pane-feed" onClick={() => openAt({ view: picked.message.channel, id: picked.message.id, parentId: picked.message.parentId })}>
                  {picked.message.parentId ? t('Open the thread') : t('Open in the conversation')}
                </button>
              </header>
              <div className="slk-inbox-view-body">
                {picked.type === 'reaction' && picked.emoji && (
                  <p className="slk-inbox-said"><span className="slk-note-reaction big"><span>{picked.emoji}</span></span> {t('{name} reacted to your message', { name: whoOf(picked) })}</p>
                )}
                <article className="slk-msg slk-inbox-msg">
                  <div className="slk-gutter" aria-hidden="true">
                    {avatarFor(picked.message.kind === 'ai' ? 'ai' : '', faceOfMessage(picked.message))}
                  </div>
                  <div className="slk-body">
                    <div className="slk-meta">
                      <span className="slk-author">{picked.message.kind === 'ai' ? t('Your AI') : picked.message.mine ? t('You') : (picked.message.authorName || t('a teammate'))}</span>
                      <time className="slk-time" dateTime={picked.message.createdAt}>{when(picked.message.createdAt)}</time>
                    </div>
                    <div className="slk-text">{rich(picked.message.body)}</div>
                    {(picked.message.reactions || []).length > 0 && (
                      <div className="slk-reactions">
                        {(picked.message.reactions || []).map((r) => (
                          <span key={r.emoji} className={`slk-reaction${r.mine ? ' mine' : ''}`}><span className="slk-reaction-emoji">{r.emoji}</span><span className="slk-reaction-count">{r.count}</span></span>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              </div>
            </>
          )}
        </section>
      </div>
    )
  }

  /// How many people a conversation has: a public channel is everyone.
  const headCount = (th: Thread) => th.kind === 'group' ? (th.refs || []).length + 1
    : th.kind === 'channel' ? (th.private ? (th.memberCount || 1) : members.length) : 2
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
        const to = c.senderUserID === userId && c.recipientUserID !== userId ? nameOfRecipient(c) : ''
        out.push(block(c.id, { joined, at: c.createdAt, app: who.app, name: who.name, face: who.face, to, unread: isUnread(c) }, attachment(c)))
        prevWho = `card:${who.name}`
      } else {
        const m = item.msg
        if (m.kind === 'ai') {
          const card = m.cardId ? cardsById.get(m.cardId) : undefined
          out.push(block(m.id, { joined: false, at: m.createdAt, app: 'ai', name: t('Your AI'), badge: t('AI'), msgId: m.id, pinned: m.pinned, tools: toolsFor(thread.view!, m), onHold: holdFor(thread.view!, m) },
            <>
              <div className="slk-text">{rich(m.body)}</div>
              {card && attachment(card)}
              {jams[thread.view!]?.messageId === m.id && jamCard(thread.view!, jams[thread.view!])}
              {underneath(thread.view!, m)}
            </>))
          prevWho = 'ai'
        } else {
          const whoKey = `msg:${m.authorRef || m.authorName}`
          const joined = prevWho === whoKey && at - prevAt < 5 * 60000
          const name = m.mine ? t('You') : (m.authorName || t('a teammate'))
          out.push(block(m.id, {
            joined: joined && !m.pinned, at: m.createdAt, app: '', name, face: faceOfMessage(m), msgId: m.id, pinned: m.pinned, authorRef: m.mine ? null : m.authorRef,
            tools: toolsFor(thread.view!, m), onHold: holdFor(thread.view!, m),
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
            <Icon name="chevron-left" size={20} />
          </button>
          {lead(thread, 'head')}
          <div className="slk-head-text" onClick={!wide && thread.kind === 'channel' && thread.view ? () => openSide({ kind: 'details', tab: 'members' }) : undefined}>
            {thread.kind === 'person' && thread.view
              ? <h1><button type="button" className="slk-author link" onClick={() => void openProfile(thread.view!.slice(3))}>{thread.name}</button>
                  {(() => { const m = members.find((x) => thread.view === `dm:${x.ref}`); return m?.status ? <span className="slk-head-status"> {m.status.emoji} {m.status.text}</span> : null })()}
                  {(() => { const m = members.find((x) => thread.view === `dm:${x.ref}`); return m?.awayUntil ? <span className="slk-head-away"> · {t('Away until {when}', { when: new Date(m.awayUntil).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) })}</span> : null })()}
                </h1>
              : <h1>{thread.name}</h1>}
            <p>
              {!wide && (thread.kind === 'channel' || thread.kind === 'group') && <>{t('{n} members', { n: headCount(thread) })} · </>}
              {thread.cards.length ? t('{n} decisions', { n: thread.cards.length }) : t('No decisions here yet.')}
              {waitingHere > 0 && <> · <b>{t('{n} waiting on you', { n: waitingHere })}</b></>}
            </p>
          </div>
          {thread.view && (
            <div className="slk-head-actions">
              <button
                type="button"
                className={`slk-head-btn slk-context-button${side?.kind === 'journal' ? ' on' : ''}`}
                onClick={() => openSide({ kind: 'journal' })}
                aria-label={t('Context')} title={t('Context')} aria-expanded={side?.kind === 'journal'}
              >
                <Icon name="book" size={15} />
              </button>
              {thread.kind === 'channel' && (
                <button
                  type="button"
                  className={`slk-head-btn slk-automations-button${side?.kind === 'details' && side.tab === 'automations' ? ' on' : ''}`}
                  onClick={() => openSide({ kind: 'details', tab: 'automations' })}
                  aria-label={t('Automations ({n})', { n: automationCount[thread.view] ?? 0 })} title={t('Automations')}
                >
                  <Icon name="repeat" size={14} /><span>{automationCount[thread.view] ?? 0}</span>
                </button>
              )}
              <button
                type="button"
                className={`slk-head-btn slk-members-button${side?.kind === 'details' && side.tab === 'members' ? ' on' : ''}`}
                onClick={() => openSide({ kind: 'details', tab: 'members' })}
                aria-label={t('Members ({n})', { n: headCount(thread) })} title={t('Members')}
              >
                <Icon name="you" size={14} /><span>{headCount(thread)}</span>
              </button>
              {thread.kind !== 'app' && (
                <JamButton
                  state={jams[thread.view]}
                  inThis={Boolean(call && call.channel === thread.view)}
                  busy={jamBusy}
                  onStart={(opts) => void startJam(thread.view!, opts)}
                  onLeave={() => void leaveJam()}
                />
              )}
              <button
                type="button"
                className={`slk-head-btn slk-pins-button${pins ? ' on' : ''}`}
                onClick={() => void loadPins(thread.view!)}
                aria-label={t('Pinned messages')}
                aria-expanded={Boolean(pins)}
                title={t('Pinned messages')}
              >
                <Icon name="pin" size={14} />
                {(messages[thread.view] || []).filter((m) => m.pinned).length > 0 && <span>{(messages[thread.view] || []).filter((m) => m.pinned).length}</span>}
              </button>
              {/* A phone has room for the call and this; the rest is behind it. */}
              <button type="button" className="slk-head-btn slk-phone-more" onClick={() => setConvSheet(true)} aria-label={t('More')} aria-haspopup="dialog">
                <Icon name="more" size={18} />
              </button>
            </div>
          )}
          {thread.kind === 'channel' && thread.slug && (
            <button
              className="slk-more"
              onClick={() => { setSettings((v) => !v); setRenaming(null) }}
              aria-label={t('Channel settings')}
              aria-expanded={settings}
            >
              <Icon name="more" size={16} />
            </button>
          )}
        </header>
        {pins && thread.view && (
          <div className="slk-pins" role="dialog" aria-label={t('Pinned messages')}>
            <div className="slk-pins-head">
              <b>{t('Pinned messages')}</b>
              <button type="button" className="slk-pane-close" onClick={() => setPins(null)} aria-label={t('Close')}><Icon name="x" size={16} /></button>
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
        {call && !call.ended && (!jamShown || call.channel !== thread.view) && (
          <JamBar
            call={call}
            where={whereOf(call.channel)}
            onMute={(m) => call.setMuted(m)}
            onLeave={() => void leaveJam()}
            onShow={() => { setJamShown(true); const th = everything.find((x) => x.view === call.channel); if (th && th.key !== current?.key) choose(th.key) }}
          />
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
                <span className="cl-pref" role="group" aria-label={t('Notifications')}>
                  <span className="cl-pref-label">{t('Notify me about')}</span>
                  {(['all', 'mentions', 'mute'] as const).map((lv) => (
                    <button key={lv} type="button" className={`cl-nudge${(prefs[thread.view!] || 'all') === lv ? ' on' : ''}`} aria-pressed={(prefs[thread.view!] || 'all') === lv} onClick={() => void setPref(thread.view!, lv)}>
                      {lv === 'all' ? t('Everything') : lv === 'mentions' ? t('Mentions only') : t('Nothing (mute)')}
                    </button>
                  ))}
                </span>
                <button type="button" className="cl-nudge" onClick={() => void dailySummary(thread)}>{t('Daily summary to me')}</button>
                {thread.private && <button type="button" className="cl-nudge" onClick={() => setAddingTo(thread.view!)} data-add-people="1">{t('Add people')}</button>}
                {thread.private && <button type="button" className="cl-nudge" onClick={() => void leaveChannel(thread)} data-leave="1">{t('Leave channel')}</button>}
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
                <div className="slk-samples" aria-busy={aiSamples === null}>
                  {aiSamples === null
                    ? [0, 1, 2].map((i) => <span key={i} className="slk-sample skeleton" aria-hidden="true" />)
                    : aiSamples.map((x) => (
                      <button key={x} type="button" className="slk-sample" onClick={() => { setDraft(x); composer.current?.focus() }}>{x}</button>
                    ))}
                  {aiSamples !== null && (
                    <button type="button" className="slk-samples-more" onClick={() => void loadSamples(true)} disabled={samplesBusy}>
                      <Icon name="refresh" size={13} /> {t('Other suggestions')}
                    </button>
                  )}
                </div>
              </>
            ))
          )}
          {out}
          {thread.view && (notes[thread.view] || []).map((n) => (
            <div key={n.id} className="slk-note-row" role="status">
              <span className="slk-note-only">{t('Only visible to you')}</span>
              <span>{n.text}</span>
              <button type="button" onClick={() => setNotes((prev) => ({ ...prev, [thread.view!]: (prev[thread.view!] || []).filter((x) => x.id !== n.id) }))} aria-label={t('Dismiss')}><Icon name="x" size={12} /></button>
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
                  <span className="slk-clip-count"><Icon name="paperclip" size={13} /> {t('{n} messages clipped', { n: clip.length })}</span>
                  <span className="slk-clip-list">{clip.map((c) => <span key={c.id} className="slk-clip-chip" title={c.body}>{c.who}: {c.body.slice(0, 30)}<button type="button" onClick={() => setClip((p) => p.filter((x) => x.id !== c.id))} aria-label={t('Remove')}><Icon name="x" size={11} /></button></span>)}</span>
                  <button type="button" className="slk-send ai" onClick={() => void sendClip(thread.view!)}>{t('Make one decision')}</button>
                  <button type="button" className="cl-nudge" onClick={() => setClip([])}>{t('Clear')}</button>
                </div>
              )}
              {here.length > 0 && (
                <div className="slk-scheduled">
                  <button type="button" className="slk-scheduled-toggle" onClick={() => setScheduledOpen((o) => !o)} aria-expanded={scheduledOpen}>
                    <Icon name="clock" size={13} /> {here.length === 1 ? t('1 scheduled message') : t('{n} scheduled messages', { n: here.length })}
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
            <PendingUploads items={uploads.items} onRemove={uploads.remove} />
            <textarea
              ref={composer}
              onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); uploads.add(files, thread.view!) } }}
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
                // On a phone the keyboard's return is a new line and the
                // arrow sends, as in every phone chat app.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && wide) { e.preventDefault(); void send(thread.view!, e.metaKey || e.ctrlKey) }
              }}
              disabled={sending}
            />
            {mention.menu}
            <SlashMenu draft={draft} onPick={(name) => { setDraft(`/${name} `); composer.current?.focus() }} />
            <div className="slk-composer-bar">
              <button type="button" className="slk-attach" onClick={() => attachInput.current?.click()} aria-label={t('Attach files')} title={t('Attach files')}><Icon name="paperclip" size={17} /></button>
              <input ref={attachInput} type="file" multiple hidden data-attach="1" onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) uploads.add(files, thread.view!) }} />
              <FormatBar target={composer} value={draft} set={setDraft} />
              <span className="slk-composer-hint">{t('Enter to send · ⌘Enter sends and asks your AI for a decision · / for commands')}</span>
              <button type="button" className="slk-send ai" disabled={sending || !draft.trim()} onClick={() => void send(thread.view!, true)} aria-label={t('Send as a decision')} title={t('Send as a decision')}>
                <Icon name="sparkle" size={15} /><span className="slk-send-label">{t('Send as a decision')}</span>
              </button>
              <span className="slk-send-group">
                <button type="submit" className="slk-send" disabled={sending || uploads.busy || (!draft.trim() && !uploads.ids.length)} aria-label={t('Send')}>
                  <Icon name="send" size={16} />
                </button>
                <button type="button" className="slk-send more" disabled={sending || !draft.trim() || draft.trim().startsWith('/')} onClick={() => setScheduleOpen((o) => !o)} aria-label={t('Schedule message')} title={t('Schedule message')} aria-expanded={scheduleOpen}>
                  <Icon name="chevron-down" size={14} />
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
    { id: 'invite', done: members.length > 1, label: t('Invite a teammate'), go: () => setInviting('people') },
    { id: 'decide', done: decided.length > 0, label: t('Decide your first card'), go: () => { const w = everything.find((x) => x.unread > 0); if (w) choose(w.key) } },
    { id: 'tools', done: toolsSeen, label: t('Connect Gmail, Slack or another tool'), go: () => { try { localStorage.setItem(`onboard.tools:${api.orgId}`, '1') } catch {}; setToolsSeen(true); onOpenScreen?.('tools') } },
  ]
  const stepsDone = steps.filter((x) => x.done).length
  const checklist = !onboardHidden && stepsDone < steps.length ? (
    <section className="slk-onboard" aria-label={t('Getting started')}>
      <div className="slk-onboard-head">
        <b>{t('Getting started')}</b>
        <span>{stepsDone}/{steps.length}</span>
        <button type="button" onClick={() => { try { localStorage.setItem(onboardKey, '1') } catch {}; setOnboardHidden(true) }} aria-label={t('Hide')}><Icon name="x" size={14} /></button>
      </div>
      <div className="slk-onboard-bar"><i style={{ width: `${(stepsDone / steps.length) * 100}%` }} /></div>
      <ul>
        {steps.map((x) => (
          <li key={x.id} className={x.done ? 'done' : ''}>
            <button type="button" onClick={x.go} disabled={x.done} data-step={x.id}>
              <span className="cl-step-mark" aria-hidden="true">{x.done ? <Icon name="check" size={12} /> : null}</span>{x.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  ) : null

  // ---- A phone's own places ----

  /// DMs, as a phone lists them: a face, a name, the last thing said and
  /// when — your AI first, as Slack puts Slackbot.
  const dmsView = () => {
    const ai = apps.find((a) => a.app === 'ai')
    const rows = [...(ai ? [ai] : []), ...people]
    return (
      <div className="cl-dms" data-dms="1">
        <header className="cl-dms-head"><h1>{t('Direct messages')}</h1></header>
        <button className="cl-search" onClick={onSearch}>
          <Icon name="search" size={14} />
          <span>{t('Jump to or search…')}</span>
        </button>
        <ul>
          {rows.map((th) => {
            const a = th.view ? activity[th.view] : undefined
            const face = th.kind === 'person' ? members.find((m) => th.view === `dm:${m.ref}`) : undefined
            const at = a?.lastAt || (th.latest ? stamp(th.latest) : '')
            const said = a ? `${a.lastBy === 'me' ? `${t('You')}: ` : ''}${a.preview}` : th.latest ? titleOf(th.latest) : (th.app === 'ai' ? t('Tell your AI…') : t('Say hello'))
            return (
              <li key={th.key}>
                <button type="button" className={`cl-dm${th.unread || th.fresh ? ' unread' : ''}`} onClick={() => choose(th.key)}>
                  {th.app === 'ai'
                    ? <span className="cl-dm-face app" aria-hidden="true"><img src="/icon.svg" alt="" width={40} height={40} /></span>
                    : th.kind === 'group'
                      ? <span className="cl-dm-face group" aria-hidden="true">{lead(th, 'head')}</span>
                      : <span className="cl-dm-face" aria-hidden="true"><Avatar name={th.name} url={face?.avatarUrl} size={40} /></span>}
                  <span className="cl-dm-main">
                    <span className="cl-dm-line"><b>{th.name}</b>{at && <time dateTime={at}>{when(at)}</time>}</span>
                    <span className="cl-dm-said">{said}</span>
                  </span>
                  {th.unread > 0 && <span className="cl-badge">{th.unread}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
  const dmUnread = people.filter((th) => th.unread > 0 || th.fresh).length
  const phoneRoot = !wide && !current && !detail && !thread && !profile
  const tabOn = (which: 'home' | 'dms' | 'activity' | 'later') => (activityOpen ? 'activity' : laterOpen ? 'later' : phoneTab) === which
  const openLater = () => { setOpenKey(null); setActivityOpen(false); setLaterOpen(true); void loadLater() }
  /// Somebody to write to, from "New message": one person is a DM.
  const startWith = async (refs: string[]) => {
    setStarting(null)
    if (refs.length === 1) {
      const th = people.find((x) => x.view === `dm:${refs[0]}`)
      if (th) choose(th.key)
      return
    }
    const res = await fetch(`${api.httpBase}/channels/groups`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, refs }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => null) : null
    if (!res?.ok || !data?.view) { setProblem(data?.message || t('That did not work. Try again.')); return }
    setGroups((prev) => (prev.some((g) => g.view === data.view) ? prev : [...prev, { view: data.view, refs: data.refs || refs }]))
    setPhoneTab('dms')
    choose(`group:${data.view}`)
  }
  /// A private channel's people: bring somebody in, or leave.
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const addToChannel = async (view: string, refs: string[]) => {
    setAddingTo(null)
    const res = await fetch(`${api.httpBase}/channels/members`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: view, refs }),
    }).catch(() => null)
    if (!res?.ok) { setProblem(t('That did not work. Try again.')); return }
    window.dispatchEvent(new Event('honmaru:reload-businesses'))
  }
  const leaveChannel = async (th: Thread) => {
    if (!th.view || !window.confirm(t('Leave #{name}? You will need somebody inside to add you again.', { name: th.name }))) return
    const res = await fetch(`${api.httpBase}/channels/members`, {
      method: 'DELETE', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: th.view }),
    }).catch(() => null)
    if (!res?.ok) { setProblem(t('That did not work. Try again.')); return }
    choose(null)
    window.dispatchEvent(new Event('honmaru:reload-businesses'))
  }

  return (
    <div className={`classic slk${current || activityOpen || laterOpen ? ' in-thread' : ''}${phoneRoot ? ' phone-root' : ''}${detail || thread || profile ? ' with-pane' : ''}${sideHidden ? ' side-hidden' : ''}`}>
      <aside className="slk-side" aria-label={t('Conversations')}>
        {!wide && phoneTab === 'dms' ? dmsView() : <>
        <header className="cl-top">
          {workspaceMenu || (
            <button className="cl-workspace" onClick={onWorkspace} aria-label={t('Team')}>
              <span className="cl-workspace-name">{orgName || t('Your team')}</span>
              <span className="cl-caret" aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
            </button>
          )}
          <div className="cl-top-actions">
            <button className="cl-icon-button cl-invite" onClick={() => setInviting('people')} aria-label={t('Invite')} title={t('Invite')}><Icon name="invite" size={15} /></button>
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
                <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="bookmark" size={13} /></span>
                <span className="cl-title">{t('Later')}</span>
                {(laterItems || []).length > 0 && <span className="cl-count">{laterItems!.length}</span>}
              </button>
            </li>
          </ul>
          {section('channels', t('Channels'), channels, t('No channels yet. Make one, or let your AI file decisions under a business as they arrive.'), addChannel, addChannelForm)}
          {section('people', t('Direct messages'), people, t('Nobody has sent you a decision yet.'))}
          {section('apps', t('Apps'), apps, t('Connect Gmail or Slack under Tools and their decisions land here.'))}
        </nav>
        </>}
      </aside>
      <main className={`slk-main${dropping ? ' slk-dropping' : ''}`}
        onDragOver={(e) => { if (current?.view && current.kind !== 'app' && !activityOpen && !laterOpen && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false) }}
        onDrop={(e) => { setDropping(false); if (current?.view && current.kind !== 'app' && e.dataTransfer.files.length) { e.preventDefault(); uploads.add([...e.dataTransfer.files], current.view) } }}>
        {activityOpen ? activityView() : laterOpen ? laterView() : current ? conversation(current) : (
          <div className="slk-none"><p>{t('Pick a conversation.')}</p></div>
        )}
      </main>
      {phoneRoot && !activityOpen && !laterOpen && (
        <button type="button" className="cl-fab" onClick={() => setStarting('menu')} aria-label={t('New message')} data-fab="1">
          <Icon name="edit" size={22} />
        </button>
      )}
      {phoneRoot && (
        <nav className="cl-tabs" aria-label={t('Main')}>
          <button type="button" className={tabOn('home') ? 'on' : ''} aria-current={tabOn('home') ? 'page' : undefined} onClick={() => { choose(null); setPhoneTab('home') }} data-phone-tab="home">
            <Icon name="home" size={22} /><span>{t('Home')}</span>
          </button>
          <button type="button" className={tabOn('dms') ? 'on' : ''} aria-current={tabOn('dms') ? 'page' : undefined} onClick={() => { choose(null); setPhoneTab('dms') }} data-phone-tab="dms">
            <Icon name="message" size={22} /><span>{t('DMs')}</span>{dmUnread > 0 && <i className="cl-tab-badge">{dmUnread}</i>}
          </button>
          <button type="button" className={tabOn('activity') ? 'on' : ''} aria-current={tabOn('activity') ? 'page' : undefined} onClick={openActivity} data-phone-tab="activity">
            <Icon name="bell" size={22} /><span>{t('Activity')}</span>{activityUnread > 0 && <i className="cl-tab-badge">{activityUnread}</i>}
          </button>
          <button type="button" className={tabOn('later') ? 'on' : ''} aria-current={tabOn('later') ? 'page' : undefined} onClick={openLater} data-phone-tab="later">
            <Icon name="bookmark" size={22} /><span>{t('Later')}</span>
          </button>
          <button type="button" onClick={() => onOpenScreen?.('profile')} data-phone-tab="you">
            <Avatar name={myName || '?'} url={myAvatar} size={24} round /><span>{t('You')}</span>
          </button>
        </nav>
      )}
      {call && !call.ended && jamShown && (
        <JamPanel
          call={call}
          where={whereOf(call.channel)}
          api={api}
          faceOf={(ref) => memberByRef(ref)?.avatarUrl}
          me={{ name: myName || t('You'), avatarUrl: myAvatar }}
          onLeave={() => void leaveJam()}
          onHide={() => setJamShown(false)}
        />
      )}
      {sheet && (() => {
        const { channel, m, inThread } = sheet
        return (
          <MessageSheet
            message={m}
            inThread={inThread}
            onClose={() => setSheet(null)}
            onReact={(e) => react(channel, m, e)}
            onReply={() => void openThread(channel, m)}
            onPin={() => togglePin(channel, m)}
            onEdit={m.mine && m.kind === 'message' ? () => setEditing({ id: m.id, text: m.body }) : undefined}
            onDelete={m.mine && m.kind === 'message' ? () => void remove(channel, m) : undefined}
            onDecide={!m.cardId && m.kind === 'message' && !inThread ? () => void decideMessage(channel, m) : undefined}
            onLater={(at) => void saveLater(channel, m, at)}
            onCopyLink={() => copyLink(m)}
          />
        )
      })()}
      {starting === 'menu' && (
        <Sheet label={t('New')} onClose={() => setStarting(null)}>
          <div className="msheet-rows">
            <SheetRow icon="message" label={t('New message')} onClick={() => setStarting('people')} data="new-message" />
            <SheetRow icon="sparkle" label={t('Tell your AI')} hint={t('It becomes a card')} onClick={() => { setStarting(null); onCompose() }} data="tell-ai" />
            <SheetRow icon="hash" label={t('New channel')} onClick={() => { setStarting(null); setPhoneTab('home'); setAdding(true) }} data="new-channel" />
            <SheetRow icon="invite" label={t('Invite people')} onClick={() => { setStarting(null); setInviting('people') }} data="invite" />
          </div>
        </Sheet>
      )}
      {starting === 'people' && (
        <PeoplePicker
          members={members.filter((m) => !m.mine)}
          onClose={() => setStarting(null)}
          onStart={startWith}
        />
      )}
      {addingTo && (
        <PeoplePicker
          members={members.filter((m) => !m.mine)}
          onClose={() => setAddingTo(null)}
          onStart={(refs) => void addToChannel(addingTo, refs)}
          max={50}
          title={t('Add people')}
          go={t('Add')}
        />
      )}
      {convSheet && current?.view && (() => {
        const th = current
        const close = (fn: () => void) => () => { setConvSheet(false); fn() }
        return (
          <Sheet label={th.name} onClose={() => setConvSheet(false)}>
            <p className="msheet-title">{th.kind === 'channel' && !th.private ? `#${th.name}` : th.name}</p>
            <div className="msheet-rows">
              {(th.kind === 'channel' || th.kind === 'group') && <SheetRow icon="users" label={t('Members')} hint={String(headCount(th))} onClick={close(() => openSide({ kind: 'details', tab: 'members' }))} data="members" />}
              {th.kind === 'person' && <SheetRow icon="you" label={t('Profile')} onClick={close(() => void openProfile(th.view!.slice(3)))} data="profile" />}
              <SheetRow icon="book" label={t('Context')} onClick={close(() => openSide({ kind: 'journal' }))} data="context" />
              <SheetRow icon="pin" label={t('Pinned messages')} onClick={close(() => void loadPins(th.view!))} data="pins" />
              {th.kind === 'channel' && <SheetRow icon="repeat" label={t('Automations')} hint={String(automationCount[th.view!] ?? 0)} onClick={close(() => openSide({ kind: 'details', tab: 'automations' }))} data="automations" />}
              {th.kind === 'channel' && th.slug && <SheetRow icon="settings" label={t('Channel settings')} onClick={close(() => { setSettings(true); setRenaming(null) })} data="settings" />}
              {th.private && <SheetRow icon="invite" label={t('Add people')} onClick={close(() => setAddingTo(th.view!))} data="add-people" />}
              {th.private && <SheetRow icon="x" label={t('Leave channel')} onClick={close(() => void leaveChannel(th))} danger data="leave" />}
            </div>
          </Sheet>
        )
      })()}
      {toast && <div className="cl-toast" role="status">{toast}</div>}
      {ringing && createPortal(
        <div className="jam-ring" role="alertdialog" aria-label={t('{name} is calling you', { name: ringing.name })} data-jam-ring="1">
          <div className="jam-ring-who">
            <Avatar name={ringing.name} url={ringing.avatarUrl} size={40} round />
            <div><b>{ringing.name}</b><span>{t('is calling you in a Jam')}</span></div>
          </div>
          <div className="jam-ring-actions">
            <button type="button" className="later" onClick={() => { const st = jams[ringing.channel]; if (st?.startedAt) declined.current.add(`${ringing.channel}:${st.startedAt}`); setRinging(null); stopRing() }}>{t('Not now')}</button>
            <button type="button" className="join" onClick={() => {
              const target = ringing.channel
              const th = everything.find((x) => x.view === target)
              if (th) choose(th.key)
              void startJam(target, { mode: jams[target]?.mode || 'notes' })
            }}>{t('Join')}</button>
          </div>
        </div>,
        // Above everything, the tab bar included: the list sits inside a
        // fixed layer of its own, which no z-index inside it can climb out of.
        document.body,
      )}
      {detail && (
        <aside className="slk-pane" aria-label={t('Decision')}>
          <header className="slk-pane-head">
            <button className="slk-back pane" onClick={() => setDetailId(null)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
            <h2>{t('Decision')}</h2>
            {detail.business && <span className="slk-pane-where">#{nameOfBusiness(detail.business)}</span>}
            <button className="slk-pane-feed" onClick={() => onOpen(detail.id)} title={t('Open in Cards')}>{t('Open in Cards')}</button>
            <button className="slk-pane-close" onClick={() => setDetailId(null)} aria-label={t('Close')}><Icon name="x" size={16} /></button>
          </header>
          <div className="slk-pane-body">{renderCard(detail)}</div>
        </aside>
      )}
      {!detail && !thread && profile && (
        <aside className="slk-pane slk-profile" aria-label={t('Profile')}>
          <header className="slk-pane-head">
            <button className="slk-back pane" onClick={() => setProfile(null)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
            <h2>{t('Profile')}</h2>
            <button className="slk-pane-close" onClick={() => setProfile(null)} aria-label={t('Close')}><Icon name="x" size={16} /></button>
          </header>
          {!profile.data ? <p className="slk-empty">{t('Loading…')}</p> : (() => {
            const p = profile.data
            let local = ''
            try { if (p.timezone) local = new Date().toLocaleTimeString(locale, { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' }) } catch { /* unknown zone */ }
            return (
              <div className="slk-profile-body">
                <div className="slk-profile-avatar" aria-hidden="true">{p.name.charAt(0).toUpperCase()}</div>
                <h3>{p.name}</h3>
                {p.handle && <p className="slk-profile-handle">@{p.handle}</p>}
                <p className="slk-profile-title">{t(p.title.charAt(0).toUpperCase() + p.title.slice(1))}</p>
                {p.status && <p className="slk-profile-status">{p.status.emoji} {p.status.text}</p>}
                {p.awayUntil && <p className="slk-profile-away">{t('Away until {when}', { when: new Date(p.awayUntil).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) })}</p>}
                {local && <p className="slk-profile-local"><Icon name="clock" size={13} /> {t('{time} local time', { time: local })}</p>}
                <dl className="slk-profile-stats">
                  <div><dt>{t('Waiting on them')}</dt><dd>{p.stats.waiting}</dd></div>
                  <div><dt>{t('Decided (90 days)')}</dt><dd>{p.stats.decided90d}</dd></div>
                  <div><dt>{t('Typical answer')}</dt><dd>{p.stats.medianMinutes === null ? '—' : p.stats.medianMinutes < 60 ? t('{n} min', { n: p.stats.medianMinutes }) : p.stats.medianMinutes < 1440 ? t('{n} h', { n: Math.round(p.stats.medianMinutes / 60) }) : t('{n} days', { n: Math.round(p.stats.medianMinutes / 1440) })}</dd></div>
                </dl>
                {!p.mine && (
                  <div className="slk-profile-actions">
                    <button type="button" className="slk-send" onClick={() => { const th = everything.find((x) => x.view === `dm:${profile.ref}`); if (th) choose(th.key); setProfile(null) }}>{t('Message')}</button>
                    <button type="button" className="slk-send ai" onClick={() => { const th = everything.find((x) => x.view === `dm:${profile.ref}`); if (th) { choose(th.key); setTimeout(() => { setDraft('@AI '); composer.current?.focus() }, 50) } setProfile(null) }}>{t('Ask for a decision')}</button>
                  </div>
                )}
              </div>
            )
          })()}
        </aside>
      )}
      {!detail && !thread && !profile && side && current?.view && (
        side.kind === 'journal'
          ? (
            <ChannelJournal
              api={api} headers={authHeaders} view={current.view} locale={locale}
              title={current.kind === 'channel' ? `#${current.name}` : current.name}
              onCite={(c) => void goToCite(current.view!, c)}
              onClose={() => setSide(null)}
            />
          )
          : (
            <ChannelDetails
              api={api} headers={authHeaders} view={current.view} locale={locale}
              tab={side.tab}
              onTab={(tab) => setSide({ kind: 'details', tab })}
              level={prefs[current.view] || 'all'}
              onLevel={(lv) => void setPref(current.view!, lv)}
              onSettings={current.kind === 'channel' && current.slug ? () => { setSettings(true); setRenaming(null) } : null}
              onInvite={() => (current.private ? setAddingTo(current.view!) : setInviting('people'))}
              onProfile={(ref) => void openProfile(ref)}
              onJump={(id) => void goToCite(current.view!, { id, parentId: null, at: '' })}
              onCounts={(n) => setAutomationCount((prev) => ({ ...prev, [current.view!]: n.automations }))}
              onClose={() => setSide(null)}
            />
          )
      )}
      {!detail && thread && (
        <aside className="slk-pane slk-thread-pane" aria-label={t('Thread')}>
          <header className="slk-pane-head">
            <button className="slk-back pane" onClick={() => setThread(null)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
            <h2>{t('Thread')}</h2>
            {current && <span className="slk-pane-where">{current.kind === 'channel' ? `#${current.name}` : current.name}</span>}
            <button className="slk-pane-close" onClick={() => setThread(null)} aria-label={t('Close')}><Icon name="x" size={16} /></button>
          </header>
          <div className="slk-thread-log">
            {[thread.parent, ...thread.replies].map((m, i) => (
              <React.Fragment key={m.id}>
                {block(m.id, {
                  joined: false, at: m.createdAt, app: m.kind === 'ai' ? 'ai' : '', badge: m.kind === 'ai' ? t('AI') : undefined,
                  name: m.kind === 'ai' ? t('Your AI') : (m.mine ? t('You') : m.authorName || t('a teammate')),
                  face: m.kind !== 'ai' ? faceOfMessage(m) : null,
                  msgId: i === 0 ? `thread-${m.id}` : m.id,
                  tools: toolsFor(thread.channel, m, true), onHold: holdFor(thread.channel, m, true),
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
            <PendingUploads items={threadUploads.items} onRemove={threadUploads.remove} />
            <textarea
              ref={threadComposer}
              onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); threadUploads.add(files, thread.channel) } }}
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
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && wide) { e.preventDefault(); void send(thread.channel, e.metaKey || e.ctrlKey, thread.parent.id) }
              }}
              disabled={sending}
            />
            {threadMention.menu}
            <div className="slk-composer-bar">
              <button type="button" className="slk-attach" onClick={() => threadAttachInput.current?.click()} aria-label={t('Attach files')} title={t('Attach files')}><Icon name="paperclip" size={17} /></button>
              <input ref={threadAttachInput} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) threadUploads.add(files, thread.channel) }} />
              <FormatBar target={threadComposer} value={threadDraft} set={setThreadDraft} />
              <span className="slk-composer-hint" />
              <button type="submit" className="slk-send" disabled={sending || threadUploads.busy || (!threadDraft.trim() && !threadUploads.ids.length)} aria-label={t('Send')}>
                <Icon name="send" size={16} />
              </button>
            </div>
          </form>
        </aside>
      )}
      {inviting && (
        <InviteDialog httpBase={api.httpBase} orgId={api.orgId} sessionToken={api.sessionToken} orgName={orgName} initialTab={inviting} onClose={() => setInviting(null)} />
      )}
    </div>
  )
}

/// A Jam's running time, ticking by itself.
function JamClock({ from }: { from: string | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  if (!from) return <>0:00</>
  const s = Math.max(0, Math.floor((now - Date.parse(from)) / 1000))
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</>
}
