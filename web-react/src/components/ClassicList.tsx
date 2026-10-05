import { channelMessageCache, mergeLatestMessages } from '../utils/channelMessageCache'
import { ReadGuard } from '../utils/readGuard'
import { ChannelCanvas } from './ChannelCanvas'
import { AgentAvatar } from './AgentAvatar'
import { BookmarksBar } from './BookmarksBar'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { awaitsPost } from '../utils/automation'
import { hashForMessage, hashForView } from '../utils/route'
import { RowMenu } from './RowMenu'
import { SidebarSection } from './SidebarSection'
import { Dialog } from './Dialog'
import type { MenuEntry } from './RowMenu'
import type { DecisionCard, Business, ChannelMessage, FileRef, ReplyQuote } from '../types/card'
import { arrive, drawUnder, echoOf, isDoubleSend, isTemp, keepTemps, keptAsYours, keptUnsent, landedCopy, markFailed, markPending, outboxKey, provenYours, readUnsent, reconcile, refusedOutright, SEND_TIMEOUT, sendDeadline, sendTime, sharedOutboxKey, tempMessage, tempState, unsentAgain, wentAfterAll, withHeld } from '../utils/pendingSend'
import type { Unsent } from '../utils/pendingSend'
import { askingAboutData } from '../utils/authGuard'
import { draftToClear, withoutDraft } from '../utils/drafts'
import { getLocale } from '../utils/locale'
import { fullTime } from '../utils/ago'
import { deleteWarning, messageIdOf, messageKeyAction, othersReplied, previewText, skipsDeleteConfirm } from '../utils/messageKeys'
import { displayName, properName } from '../utils/names'
import { Icon } from './Icon'
import { BrandLogo, isBrand } from './BrandLogo'
import { useBackStack } from '../utils/backStack'
import { countNewBelow, isAtBottom, isLooking, isNewSince, leavesGap, mergeById, reachesPast, shouldFollow, waitToSay } from '../utils/chatScroll'
import { JumpToPresent, newBelowLabel } from './JumpToPresent'
import { useT } from '../utils/i18n'
import { useMembers, agentMentionables, agentsIn, mentionKind, mentionTarget } from '../utils/mentions'
import type { AgentFace } from '../utils/mentions'
import { meReader } from '../utils/mentionsMe'
import { useMentionMenu, useMentionHighlight } from './MentionMenu'
import { useCustomEmoji, loadCustomEmoji, customEmojiUrl } from '../utils/customEmoji'
import { messageContextEntries, messageMenuTriggers, type MessageMenuActions } from '../utils/messageMenu'
import { rememberEmoji, useQuickReactions } from '../utils/emojiSearch'
import { DailyReportDraft } from './DailyReport'
import { MessageActions, CardActions, Reactions, EmojiPicker, EmojiPickerAt, EmojiGlyph, FormatBar, continueBlock, renderRich, LinkCards, SlashMenu, SchedulePicker, parseScheduleCommand, TypingLine, ReplyQuoteLine, ThreadReplyLine, ReplyingBar, UnsentNote } from './MessageParts'
import { heard as heardTyping, said, expire, nextExpiry as nextTypingExpiry, typistsIn, typedIn, stoppedIn, sendTyping } from '../utils/typing'
import type { Typist, TypingEvent, Outgoing as TypingOut, Place, Signal } from '../utils/typing'
import { quoteOf, refreshQuotes } from '../utils/replies'
import { ChannelJournal, ChannelDetails, JamButton, JamBar } from './ChannelPanes'
import type { DetailsTab, JournalCite } from './ChannelPanes'
import { JamCall } from '../utils/jam'
import { JamPanel } from './JamPanel'
import type { JamMode, JamState } from '../utils/jam'
import { InviteDialog } from './InviteDialog'
import { Avatar } from './Avatar'
import { ProfileCard } from './ProfileCard'
import { isOnline, statusShown, awayShown, nextExpiry, localTime } from '../utils/people'
import { Sheet, SheetRow, MessageSheet, PeoplePicker, ForwardSheet, longPress } from './Sheet'
import { useUploads, PendingUploads, MessageFiles } from './Attachments'
import { configureMediaUrls } from '../utils/mediaUrls'
import { playSound, setOpenView, rememberLevels, rememberLevel, startRing, stopRing } from '../utils/sound'
import { closeMessageNotifications } from '../utils/notifications'
import { hasOlder } from '../utils/historyPage'
import { foldedRows, sectionBadge, visibleRows, stepRow, readFolds, writeFolds, withSectionFolds, withFold, unplacedAgents } from '../utils/sidebarSections'
import { placesFrom } from '../utils/places'
import type { Place as Conversation } from '../utils/places'
import { useAppearance } from '../utils/appearance'
import { visibleOrder, step, foldedHome } from '../utils/sidebarOrder'
import type { SidebarGroup } from '../utils/sidebarOrder'
import { isMacPlatform, formatCombo, hasPrimaryMod, composing, enterKey } from '../utils/keys'
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
  /// Take a card back: the sender before it is decided, the recipient any time.
  onDeleteCard?: (cardId: string) => void
  /// The conversation open now, for what shows beside it (the record), and
  /// whether you opened it — rather than the list putting one up by itself.
  onViewChange?: (view: string | null, name: string | null, opened: boolean) => void
  /// Open the record of the channel open now: its context and decisions.
  onOpenRecord?: () => void
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
  onOpenScreen?: (screen: 'team' | 'tools' | 'profile' | 'agents') => void
  /// Every conversation that can be opened, with what is unread in each,
  /// for ⌘K to jump to by name. Told again whenever the sidebar changes.
  onPlaces?: (places: Conversation[]) => void
  /// Your status, from the You tab along a phone's bottom — the only
  /// avatar a phone shows in the list, where the shell's top-bar avatar and
  /// its tab bar are hidden. Given the tab, for the popover to sit above
  /// and hand focus back to; the popover leads on to the You screen.
  onStatus?: (tab: HTMLButtonElement) => void
  /// That popover is open now, for the tab to say so.
  statusOpen?: boolean
  /// False while something of the shell's is over the list — the palette,
  /// a screen, a panel, the shortcuts sheet: the list's keys wait, so ⇧Esc
  /// typed there does not mark everything read underneath.
  active?: boolean
}

/// One conversation in the sidebar: a channel (a business), a person, or an app.
interface Thread {
  key: string
  /// A group is a DM with several people (`g:<id>`).
  kind: 'channel' | 'person' | 'group' | 'app' | 'agent'
  /// The agent, for a conversation with one (`ag:<id>`).
  agent?: AgentFace
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
/// A teammate's profile as GET /channels/member reads it: the pane shows all
/// of it, the popout their clock.
interface ProfileData { name: string; handle: string | null; title: string; timezone: string | null; status: Member['status']; awayUntil: string | null; joinedAt: string; mine: boolean; stats: { waiting: number; decided90d: number; medianMinutes: number | null } }
/// `last`: the message the preview is, as it arrived live — for its preview
/// to be put into the reader's language.
interface Activity { channel: string; lastAt: string; preview: string; lastBy: string | null; last?: ChannelMessage }
/// One of the team's agents answering somewhere.
interface AgentWriting { id: string; name: string; emoji: string | null; avatarUrl?: string | null; parentId: string | null; at?: number }
/// Whose face goes beside something: a name, and their photo if they have one.
/// `emoji`: an agent's face — a tile, not a person's photo.
interface Face { name: string; url?: string | null; emoji?: string | null; picture?: string | null }
/// One notification: somebody named you, replied in your thread, or reacted
/// to what you wrote.
/// A thread you are in: its first message, the last replies, how many.
interface ThreadItem { parent: ChannelMessage; replies: ChannelMessage[]; replyCount: number; lastReplyAt: string; unread: boolean }
/// Your sidebar's own arrangement.
interface SidebarLayout { starred: string[]; sections: Array<{ id: string; name: string; views: string[]; collapsed?: boolean }>; order?: string[] }
/// A group of the sidebar as it is drawn: its conversations, and what goes
/// around them.
interface SidebarSection extends SidebarGroup<Thread> {
  label: string
  /// Said when it holds nothing.
  empty: string
  /// Beside its heading: the "+" that adds to it, or the × that removes it.
  action?: React.ReactNode
  /// Under its rows: what that "+" opened.
  below?: React.ReactNode
  /// Its conversations, dragged into a new order.
  reorder?: (views: string[]) => void
}
/// A user group: "@handle" names everyone in it.
interface UserGroup { handle: string; name: string; refs: string[]; createdBy: string | null }
interface ActivityItem { key?: string; type: 'mention' | 'reply' | 'reaction' | 'keyword'; message: ChannelMessage; unread: boolean; at?: string; emoji?: string; by?: string | null; byAvatar?: string | null; keyword?: string }

async function hash16(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

const seenKey = (orgId: string, view: string) => `seen:${orgId}:${view}`
/// This browser's notifications for a conversation, taken down once it is
/// read — here or anywhere. A push is tagged with its workspace and the
/// conversation (two teams' #general are not one), or, from before, the
/// conversation alone.
function closeNotifications(orgId: string, view: string) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.getRegistration()
    .then((reg) => Promise.all([`${orgId}|${view}`, view].map((tag) => reg?.getNotifications({ tag }))))
    .then((lists) => { for (const n of lists.flat()) if (n) n.close() })
    .catch(() => { /* nothing shown, nothing to take down */ })
}

const messageIdsOf = (keys: string[]) => keys.filter((k) => k.startsWith('m:')).map((k) => k.slice(2))

function seenAt(orgId: string, view: string): string {
  try { return localStorage.getItem(seenKey(orgId, view)) || '' } catch { return '' }
}

/// ⇧Esc on a Mac, Shift+Esc elsewhere, where the list prints a key.
const isMac = isMacPlatform()

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
  onOpen, onNudge, onDecide, api, onSearch, onCompose, onTellAI, onDeleteCard, onViewChange, onOpenRecord, onImmersive, renderCard, onWorkspace, workspaceMenu,
  onCreateChannel, onRenameChannel, onDeleteChannel, onOpenScreen, onPlaces, onStatus, statusOpen, active = true,
}) => {
  // Files' addresses are renewed for the workspace open now (mediaUrls).
  useEffect(() => { configureMediaUrls(api) }, [api.httpBase, api.orgId, api.sessionToken])
  const t = useT()
  // Cozy or compact, as chosen on You: the stylesheet does the rest.
  const { density } = useAppearance()
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
  // know what you muted and what you are looking at. Written down only once
  // the server has said what they are for this workspace: until then the
  // levels last written down stay in force, rather than an empty map that
  // would let a muted conversation ring (and show its words) meanwhile.
  const prefsFor = useRef<string | null>(null)
  useEffect(() => { if (prefsFor.current === api.orgId) rememberLevels(api.orgId, prefs) }, [api.orgId, prefs])
  // This workspace's own emoji: fetched when it opens, and again when a
  // message — live or loaded — names one not yet in the list: somebody just
  // added it. A name asked about once is not asked about again for a minute,
  // so text that only looks like :this: costs one request, not one a render.
  useCustomEmoji()
  const emojiAsked = useRef<Map<string, number>>(new Map())
  useEffect(() => { emojiAsked.current.clear(); void loadCustomEmoji(api.httpBase, api.sessionToken, api.orgId) }, [api.httpBase, api.sessionToken, api.orgId])
  const maybeNewEmoji = useCallback((text: string) => {
    const now = Date.now()
    const unknown = (String(text || '').match(/:[a-z0-9_+-]{1,30}:/g) || [])
      .filter((n) => !customEmojiUrl(n) && now - (emojiAsked.current.get(n) || 0) > 60_000)
    if (!unknown.length) return
    for (const n of unknown) emojiAsked.current.set(n, now)
    void loadCustomEmoji(api.httpBase, api.sessionToken, api.orgId)
  }, [api.httpBase, api.sessionToken, api.orgId])
  // Read positions from the server: the same on the phone and the laptop.
  const [serverReads, setServerReads] = useState<Record<string, string>>({})
  const readAt = (v: string) => [seenAt(api.orgId, v), serverReads[v] || ''].sort().pop() || ''
  const authHeaders = useMemo(() => ({ 'x-session-token': api.sessionToken }), [api.sessionToken])
  /// What was last shown, for this account and workspace (#209): drawn at
  /// once when a list, a thread or a profile is opened again, and replaced
  /// by what the server says behind it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const views = useMemo(() => channelMessageCache(api).views, [api.httpBase, api.orgId, api.sessionToken])
  /// What this device has marked read, held against lists fetched before it
  /// (#217): an older answer never brings the unread back.
  const readGuard = useRef(new ReadGuard()).current
  // Your daily report's draft, waiting in the channel it is for.
  const dailyDrafts = useMemo(() => pending.filter((c) => c.dailyReport && awaitsPost(c) && c.dailyReport.status === 'draft'), [pending])
  const draftsFor = (view: string) => dailyDrafts.filter((c) => c.dailyReport!.channel === view)
  // Your own sidebar: what you starred and the sections you made, kept on
  // the server so the laptop and the phone arrange things alike.
  const [layout, setLayout] = useState<SidebarLayout>({ starred: [], sections: [] })
  // Which sections are folded: remembered by this browser for the
  // workspace, and your own sections' on the server with the rest of it.
  const [folded, setFolded] = useState<Record<string, boolean>>(() => readFolds(api.orgId))
  useEffect(() => { writeFolds(api.orgId, folded) }, [api.orgId, folded])
  useEffect(() => {
    let ignore = false
    fetch(`${api.httpBase}/channels/sidebar?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (ignore || !d?.sidebar) return
        setLayout(d.sidebar)
        setFolded((prev) => withSectionFolds(prev, d.sidebar.sections || []))
      }).catch(() => {})
    return () => { ignore = true }
  }, [api.httpBase, api.orgId, authHeaders])
  const saveLayout = (next: SidebarLayout) => {
    // An agent nothing has been said to yet is listed only for being
    // starred or in a section. Unstarred, or put back where it was, it
    // stays listed among the agents: open, it must not vanish from under you.
    const freed = unplacedAgents(layout, next)
    if (freed.length) setStartedAgents((prev) => [...prev, ...freed.filter((id) => !prev.includes(id))])
    setLayout(next)
    void fetch(`${api.httpBase}/channels/sidebar`, {
      method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, sidebar: next }),
    }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.sidebar) setLayout(d.sidebar) }).catch(() => {})
  }
  const isStarred = (view: string) => layout.starred.includes(view)
  /// Your channels in the order you dragged them into; any you have not
  /// placed follow, in the team's order.
  const inYourOrder = (list: Thread[]) => {
    const at = new Map((layout.order || []).map((v, i) => [v, i]))
    return list
      .map((th, i) => ({ th, i, rank: th.view && at.has(th.view) ? at.get(th.view)! : Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.th)
  }
  // Dragging a conversation to a new place in its list.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ view: string; after: boolean } | null>(null)
  /// The list with the dragged one moved to where it was dropped.
  const moved = (views: string[], from: string, to: { view: string; after: boolean }) => {
    if (from === to.view) return views
    const rest = views.filter((v) => v !== from)
    const i = rest.indexOf(to.view)
    if (i < 0) return views
    rest.splice(to.after ? i + 1 : i, 0, from)
    return rest
  }
  /// Not starred and in none of your sections: where it always was.
  const unplaced = (th: { view?: string }) => !th.view || (!layout.starred.includes(th.view) && !layout.sections.some((x) => x.views.includes(th.view!)))
  const toggleStar = (view: string) => saveLayout({ ...layout, starred: isStarred(view) ? layout.starred.filter((v) => v !== view) : [...layout.starred, view] })
  const sectionOf = (view: string) => layout.sections.find((x) => x.views.includes(view)) || null
  /// Into one of your sections (or back where it came from, with null).
  const moveTo = (view: string, sectionId: string | null) => saveLayout({
    ...layout,
    sections: layout.sections.map((x) => ({ ...x, views: x.id === sectionId ? [...x.views.filter((v) => v !== view), view] : x.views.filter((v) => v !== view) })),
  })
  const newSection = (name: string, view?: string) => {
    const id = Math.random().toString(36).slice(2, 10)
    const sections = layout.sections.map((x) => ({ ...x, views: view ? x.views.filter((v) => v !== view) : x.views }))
    saveLayout({ ...layout, sections: [...sections, { id, name, views: view ? [view] : [] }] })
  }
  /// Fold a section, or open it again. One of your own is saved folded on
  /// the server too, so the phone and the laptop agree — that flag and
  /// nothing else. A fold is a casual click, and this window may have been
  /// open since the morning: it must not save the stars and sections as it
  /// remembers them over what another window or the phone did since.
  const toggleFold = (id: string) => {
    const shut = !folded[id]
    setFolded((p) => ({ ...p, [id]: shut }))
    const own = layout.sections.find((x) => `sec:${x.id}` === id)
    if (!own) return
    // Here too, so the next star or move says the fold as it now is.
    setLayout((now) => ({ ...now, sections: withFold(now.sections, own.id, shut) }))
    void fetch(`${api.httpBase}/channels/sidebar/fold`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, id: own.id, collapsed: shut }),
    }).catch(() => {})
  }
  const [addingSection, setAddingSection] = useState<null | { view?: string }>(null)
  const [sectionName, setSectionName] = useState('')
  const [moveMenu, setMoveMenu] = useState(false)
  const [moveSheet, setMoveSheet] = useState<string | null>(null)
  // User groups: "@sales" in the composer, like a person.
  const [userGroups, setUserGroups] = useState<UserGroup[]>([])
  // The team's agents, and your own: "@hayao" answers in the thread.
  const [agents, setAgents] = useState<AgentFace[]>([])
  // Agents you started a conversation with here, before either of you said
  // anything: listed like the ones with something said.
  const [startedAgents, setStartedAgents] = useState<string[]>([])
  useEffect(() => {
    // Made, changed or deleted on the Agents screen: the names "@" offers follow.
    const on = () => {
      // The whole list — your own and the ones added to channels — as the
      // overview gives it.
      fetch(`${api.httpBase}/channels?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
        .then((r) => (r.ok ? r.json() : null)).then((d) => { if (Array.isArray(d?.agents)) setAgents(d.agents) }).catch(() => {})
    }
    window.addEventListener('honmaru:agents-changed', on)
    return () => window.removeEventListener('honmaru:agents-changed', on)
  }, [api.httpBase, api.orgId, authHeaders])
  // Somebody joined or left, or you set your status: the people in the
  // sidebar are read again too.
  useEffect(() => {
    const on = () => setChannelsTick((n) => n + 1)
    window.addEventListener('honmaru:members-changed', on)
    return () => window.removeEventListener('honmaru:members-changed', on)
  }, [])
  useEffect(() => {
    fetch(`${api.httpBase}/channels/usergroups?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.groups) setUserGroups(d.groups) }).catch(() => {})
  }, [api.httpBase, api.orgId, authHeaders])
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
        prefsFor.current = api.orgId
        setPrefs(data.prefs || {})
        if (Array.isArray(data.agents)) setAgents(data.agents)
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

  // A status runs out on its own: the list is drawn again when the next one
  // does, and statusShown leaves it out from then on.
  const [statusTick, setStatusTick] = useState(0)
  useEffect(() => {
    const next = nextExpiry(members, Date.now())
    if (next === null) return
    const id = setTimeout(() => setStatusTick((n) => n + 1), Math.min(next - Date.now() + 250, 2_147_483_647))
    return () => clearTimeout(id)
  }, [members, statusTick])

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

  const { channels, people, apps, agentConvos } = useMemo(() => {
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
      // An app's count is what came in since you last looked, on any
      // device — not everything still pending, which never goes away.
      .map((th) => ({ ...th, unread: th.cards.filter((c) => isUnread(c) && (c.createdAt || '') > readAt(th.key)).length }))

    // Conversations with the team's agents: each one you have talked to,
    // the one you just started, and one you starred or put in a section
    // before anything was said — newest first.
    const placed = new Set([...layout.starred, ...layout.sections.flatMap((x) => x.views)])
    const agentConvos = agents
      .filter((a) => activity[`ag:${a.id}`] || startedAgents.includes(a.id) || placed.has(`ag:${a.id}`))
      .map((a) => withTalk(build('agent', `agent:${a.id}`, a.name, { view: `ag:${a.id}`, agent: a }, [], true)!))
      .sort((a, b) => latestOf(b).localeCompare(latestOf(a)) || a.name.localeCompare(b.name))

    return { channels, people, apps, agentConvos }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, sent, decided, businesses, userId, locale, members, hashes, activity, seenTick, serverReads, prefs, groups, agents, startedAgents, layout])

  const everything = useMemo(() => [...channels, ...people, ...agentConvos, ...apps], [channels, people, agentConvos, apps])

  // The sidebar's lists, top to bottom: starred first, then your sections,
  // then the rest where they always were — what the starred and your
  // sections hold leaves the defaults. Drawn from here, and walked by
  // ⌥↑/⌥↓ in the same order.
  const byView = (v: string) => everything.find((x) => x.view === v)
  const starredRows = layout.starred.map(byView).filter((x): x is Thread => Boolean(x))
  const ownSections = layout.sections.map((x) => ({ ...x, threads: x.views.map(byView).filter((th): th is Thread => Boolean(th) && !isStarred(th!.view!)) }))
  const channelRows = inYourOrder(channels.filter(unplaced))
  const peopleRows = people.filter(unplaced)
  const agentRows = agentConvos.filter(unplaced)
  const sideLists = [
    { id: 'starred', threads: starredRows },
    ...ownSections.map((x) => ({ id: `sec:${x.id}`, threads: x.threads })),
    { id: 'channels', threads: channelRows },
    { id: 'people', threads: peopleRows },
    ...(agents.length > 0 ? [{ id: 'agents', threads: agentRows }] : []),
    { id: 'apps', threads: apps },
  ]

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
  // A conversation asked for before the list knew of it — a DM picked in ⌘K
  // or opened from a link while the team is still loading: opened once it
  // appears, if that is soon. Opening anything else first — another
  // conversation, Activity, Later, Threads, Sent, a channel's settings —
  // forgets it, so it does not take the screen from what you went to.
  const wantedView = useRef<{ view: string; until: number } | null>(null)
  const forgetWanted = () => { wantedView.current = null }
  // A conversation opened by hand, until the shell has been told. The one
  // the list puts up by itself — on a laptop, the first with something
  // waiting — is not somewhere you went, and ⌘K does not remember it.
  const chosenKey = useRef<string | null>(null)
  const choose = (key: string | null) => {
    forgetWanted()
    chosenKey.current = key
    setActivityOpen(false)
    setLaterOpen(false)
    setThreadsOpen(false)
    setSentOpen(false)
    setOpenKey(key)
    setProblem(null)
    setRenaming(null)
    setSettings(false)
    try { if (key) sessionStorage.setItem('list.open', key); else sessionStorage.removeItem('list.open') } catch {}
  }

  /// A conversation with one of the team's agents: listed, and open.
  const [agentPicking, setAgentPicking] = useState(false)
  const openAgent = (id: string) => {
    setAgentPicking(false)
    setStartedAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
    choose(`agent:${id}`)
  }

  /// What is told to your AI becomes a card for whoever decides — unless it
  /// calls one of the agents: then it is the agent's to do, and goes to a
  /// conversation with it, never to a person.
  const tellAI = (text: string) => {
    const called = agentsIn(agents, null).find((a) => {
      const h = a.handle.normalize('NFKC').toLowerCase()
      return (text.match(/[@＠][^\s@＠,，。、!?！？:;]+/g) || [])
        .some((tok) => { const w = tok.slice(1).normalize('NFKC').toLowerCase(); return w === h || w.replace(/[にへ]$/, '') === h || w.startsWith(`${h}に`) || w.startsWith(`${h}へ`) })
    })
    if (!called) { onTellAI(text); return }
    openAgent(called.id)
    void fetch(`${api.httpBase}/channels/messages`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: `ag:${called.id}`, body: text }),
    }).then((r) => { if (!r.ok) setToast(t('That did not send. Try again.')) }).catch(() => setToast(t('That did not send. Try again.')))
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
  // Threads: every thread you are in, the one with the newest reply first.
  const [threadsOpen, setThreadsOpen] = useState(false)
  // Drafts & sent: what you are still writing, and what you said.
  const [sentOpen, setSentOpen] = useState(false)
  const [sentTab, setSentTab] = useState<'drafts' | 'sent'>('drafts')
  const [sentItems, setSentItems] = useState<ChannelMessage[] | null>(() => views.get<ChannelMessage[]>('sent') ?? null)
  useEffect(() => { if (sentItems) views.set('sent', sentItems, { read: false }) }, [sentItems, views])
  const loadSent = useCallback(() => {
    return fetch(`${api.httpBase}/channels/sent?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) { views.set('sent', data.items || []); setSentItems(data.items || []) } })
      .catch(() => { /* the list stays as it was */ })
  }, [api.httpBase, api.orgId, authHeaders, views])
  const [threadItems, setThreadItems] = useState<ThreadItem[] | null>(() => views.get<ThreadItem[]>('threads') ?? null)
  useEffect(() => { if (threadItems) views.set('threads', threadItems, { read: false }) }, [threadItems, views])
  const loadThreads = useCallback(() => {
    const ticket = readGuard.ask('threads')
    return fetch(`${api.httpBase}/channels/threads?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !readGuard.fresh('threads', ticket)) return
        const list = readGuard.threadList<ThreadItem>(data.threads || [])
        views.set('threads', list); setThreadItems(list)
      })
      .catch(() => { /* the list stays as it was */ })
  }, [api.httpBase, api.orgId, authHeaders, views])
  useEffect(() => { void loadThreads() }, [loadThreads])
  const threadsUnread = (threadItems || []).filter((x) => x.unread).length
  /// Threads read up to a point, wherever that was done: each one whose
  /// newest reply is no later is no longer new.
  const threadsReadTo = useCallback((read: Array<{ thread: string; lastReadAt: string }>) => {
    const upTo = new Map(read.map((r) => [r.thread, r.lastReadAt]))
    for (const r of read) readGuard.readThread(r.thread, r.lastReadAt)
    setThreadItems((prev) => prev && prev.map((x) => {
      const at = upTo.get(x.parent.id)
      return x.unread && at && x.lastReplyAt <= at ? { ...x, unread: false } : x
    }))
    // Their replies, no later than that, are read in Activity too.
    setActivityItems((prev) => prev && prev.map((i) => {
      const at = i.message.parentId ? upTo.get(i.message.parentId) : undefined
      return i.unread && at && (i.at || i.message.createdAt) <= at ? { ...i, unread: false } : i
    }))
  }, [])
  const [activityItems, setActivityItems] = useState<ActivityItem[] | null>(() => views.get<ActivityItem[]>('activity') ?? null)
  useEffect(() => { if (activityItems) views.set('activity', activityItems, { read: false }) }, [activityItems, views])
  // What the Unread tab showed when you came to it stays in the list while
  // you are there, however many of them you have looked at since.
  const [unreadShown, setUnreadShown] = useState<Set<string>>(() => new Set())
  const [activityTab, setActivityTab] = useState<'all' | 'unread' | 'mentions'>('all')
  const [activityPick, setActivityPick] = useState<string | null>(null)
  const loadActivity = useCallback(() => {
    const ticket = readGuard.ask('activity')
    return fetch(`${api.httpBase}/channels/activity?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !readGuard.fresh('activity', ticket)) return
        const list = readGuard.activity<ActivityItem>(data.items || [], activityKey)
        views.set('activity', list); setActivityItems(list)
      })
      .catch(() => { /* nothing new is the same as nothing loaded */ })
  }, [api.httpBase, api.orgId, authHeaders, views])
  useEffect(() => { void loadActivity() }, [loadActivity])
  const stillNew = (i: ActivityItem) => i.unread
  const activityKey = (i: ActivityItem) => i.key || `${i.type}-${i.message.id}-${i.emoji || ''}-${i.at || ''}`
  // Looked at is read: here at once, and on the server for every other
  // device, which hears it and takes it down too.
  const markActivitySeen = useCallback((keys: string[]) => {
    const fresh = new Set(keys)
    if (!fresh.size) return
    readGuard.readItems(fresh)
    setActivityItems((prev) => prev && prev.map((i) => (i.unread && fresh.has(activityKey(i)) ? { ...i, unread: false } : i)))
    const serverKeys = keys.filter((k) => /^(m|r):/.test(k))
    if (!serverKeys.length) return
    closeMessageNotifications(messageIdsOf(serverKeys))
    void fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: 'activity', items: serverKeys }),
    }).then((r) => (r.ok ? r.json() : null))
      // A reply looked at here is read in its thread too: Threads agrees.
      .then((d) => { if (Array.isArray(d?.threads)) threadsReadTo(d.threads) })
      .catch(() => { /* seen here; the next load asks again */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.httpBase, api.orgId, authHeaders])
  const activityUnread = (activityItems || []).filter(stillNew).length
  /// Activity's "Mark all as read": every item new now is looked at, and the
  /// threads its replies are in are read up to them.
  const markAllActivityRead = () => {
    const keys = (activityItems || []).filter((i) => i.unread).map(activityKey)
    if (!keys.length) return
    readGuard.readItems(keys)
    setActivityItems((prev) => prev && prev.map((i) => (i.unread ? { ...i, unread: false } : i)))
    closeMessageNotifications(messageIdsOf(keys))
    void fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: 'activity' }),
    }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.threads)) threadsReadTo(d.threads) })
      .catch(() => { void loadActivity() })
  }
  /// Threads' "Mark all as read": each thread read up to its newest reply,
  /// and those replies read in Activity too.
  const markAllThreadsRead = () => {
    const open = (threadItems || []).filter((x) => x.unread)
    if (!open.length) return
    threadsReadTo(open.map((x) => ({ thread: x.parent.id, lastReadAt: x.lastReplyAt })))
    void fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: 'threads' }),
    }).catch(() => { void loadThreads() })
  }
  // Unread mentions per conversation: what still calls for you in a
  // conversation set to mentions only, or muted.
  const mentionsIn = useMemo(() => {
    const out: Record<string, number> = {}
    for (const i of activityItems || []) if (stillNew(i) && i.type === 'mention') out[i.message.channel] = (out[i.message.channel] || 0) + 1
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityItems])
  // What ⌘K jumps to: every conversation here with somewhere to open, each
  // with the second name it answers to — a teammate's or an agent's @handle,
  // a channel's slug.
  useEffect(() => {
    if (!onPlaces) return
    const handleOf = new Map<string, string | null>(members.map((m) => [`dm:${m.ref}`, m.handle || null]))
    onPlaces(placesFrom(everything.map((th) => ({
      ...th,
      handle: th.kind === 'channel' ? th.slug : th.kind === 'agent' ? th.agent?.handle : th.view ? handleOf.get(th.view) : null,
    })), mentionsIn))
  }, [everything, mentionsIn, members, onPlaces])
  const openActivity = () => {
    forgetWanted()
    setOpenKey(null)
    setLaterOpen(false)
    setThreadsOpen(false)
    setSentOpen(false)
    setActivityOpen(true)
    setDetailId(null)
    setActivityPick(null)
    setUnreadShown(new Set((activityItems || []).filter((i) => i.unread).map(activityKey)))
    void loadActivity()
  }
  // Seen is read: an unread row that stays in view for a moment, with the
  // app in front of you, is looked at — no ticking off.
  const activityRows = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = activityRows.current
    if (!activityOpen || !root || typeof IntersectionObserver === 'undefined') return
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.key
        if (!key) continue
        if (e.isIntersecting && e.intersectionRatio >= 0.6) {
          if (!timers.has(key)) timers.set(key, setTimeout(() => {
            timers.delete(key)
            if (document.visibilityState === 'visible') markActivitySeen([key])
          }, 900))
        } else {
          clearTimeout(timers.get(key)); timers.delete(key)
        }
      }
    }, { root, threshold: [0, 0.6, 1] })
    root.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => io.observe(el))
    return () => { io.disconnect(); for (const t of timers.values()) clearTimeout(t) }
  }, [activityOpen, activityItems, activityTab, markActivitySeen])
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

  /// What a folded section goes by: the mentions waiting, the row open now
  /// (none while Activity or another list is), and what is muted. A
  /// function: `special` is declared further down.
  const foldContext = () => ({ mentions: mentionsIn, currentKey: special ? null : current?.key ?? null, prefs })
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
    // For the sound and the notification decided at the socket, at once —
    // also when the list's own load has not come back (or failed).
    rememberLevel(api.orgId, v, level)
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

  // Right-click a conversation in the sidebar: what a desktop chat app
  // offers there — its details, copying its name or link, a star, a
  // section, how much it notifies you, and for a channel renaming it or
  // leaving. The same things as its settings and the phone's long press.
  const [rowMenu, setRowMenu] = useState<null | { thread: Thread; x: number; y: number; anchor: HTMLElement }>(null)
  const closeRowMenu = useCallback(() => setRowMenu(null), [])
  const [renameDialog, setRenameDialog] = useState<null | { slug: string; name: string; error?: string | null; busy?: boolean }>(null)
  // Archiving asks first, and says where to bring the channel back from.
  const [archiveDialog, setArchiveDialog] = useState<null | { thread: Thread; error?: string | null; busy?: boolean }>(null)
  const openBeside = (th: Thread, tab: DetailsTab) => {
    if (current?.key === th.key) { setDetailId(null); setThread(null); setProfile(null); setPins(null); setSide({ kind: 'details', tab }); return }
    sideOnOpen.current = { kind: 'details', tab }
    choose(th.key)
  }
  const copyText = (text: string, done: string) => {
    void navigator.clipboard?.writeText(text).then(() => setToast(done), () => setToast(text))
  }
  const rowMenuEntries = (th: Thread): MenuEntry[] => {
    const v = th.view!
    const isChannel = th.kind === 'channel'
    const level = (prefs[v] || 'all') as 'all' | 'mentions' | 'mute'
    const here = sectionOf(v)
    const shown = isChannel && !th.private ? `#${th.name}` : th.name
    const out: MenuEntry[] = []
    const others = freshViews().filter((x) => x !== v).length
    if (th.fresh || (mentionsIn[v] || 0) > 0) {
      out.push({ kind: 'item', label: t('Mark as read'), icon: 'check', onSelect: () => markViewRead(v), data: 'mark-read' })
    }
    if (others > 0) out.push({ kind: 'item', label: t('Mark all as read'), hint: formatCombo('Shift+Esc', isMac), onSelect: markEverythingRead, data: 'mark-all-read' })
    if (out.length) out.push({ kind: 'sep' })
    if (isChannel || th.kind === 'group') {
      out.push({ kind: 'item', label: isChannel ? t('Channel details') : t('Conversation details'), icon: 'users', data: 'details', submenu: [
        { kind: 'item', label: t('Members'), icon: 'users', onSelect: () => openBeside(th, 'members'), data: 'members' },
        { kind: 'item', label: t('Files'), icon: 'paperclip', onSelect: () => openBeside(th, 'attachments'), data: 'files' },
        ...(isChannel ? [{ kind: 'item' as const, label: t('Automations'), icon: 'repeat' as const, onSelect: () => openBeside(th, 'automations'), data: 'automations' }] : []),
        ...(isChannel && th.slug ? [{ kind: 'item' as const, label: t('Channel settings'), icon: 'settings' as const, onSelect: () => { choose(th.key); setSettings(true); setRenaming(null) }, data: 'settings' }] : []),
      ] })
    } else if (th.kind === 'person') {
      out.push({ kind: 'item', label: t('View profile'), icon: 'you', onSelect: () => { if (current?.key !== th.key) choose(th.key); void openProfile(v.slice(3)) }, data: 'profile' })
    }
    out.push({ kind: 'item', label: t('Copy'), icon: 'copy', data: 'copy', submenu: [
      { kind: 'item', label: t('Copy name'), onSelect: () => copyText(shown, t('Name copied')), data: 'copy-name' },
      { kind: 'item', label: t('Copy link'), onSelect: () => copyText(`${location.origin}${location.pathname}${hashForView(v)}`, t('Link copied')), data: 'copy-link' },
    ] })
    out.push({ kind: 'item', label: isStarred(v) ? (isChannel ? t('Unstar channel') : t('Unstar')) : (isChannel ? t('Star channel') : t('Star')), icon: 'star', onSelect: () => toggleStar(v), data: 'star' })
    out.push({ kind: 'item', label: t('Move to a section'), icon: 'folder', data: 'move', submenu: [
      ...layout.sections.map((x) => ({ kind: 'item' as const, label: x.name, checked: here?.id === x.id, onSelect: () => moveTo(v, x.id), data: `move-to:${x.name}` })),
      ...(here ? [{ kind: 'item' as const, label: t('Back to where it was'), onSelect: () => moveTo(v, null), data: 'move-back' }] : []),
      ...(layout.sections.length || here ? [{ kind: 'sep' as const }] : []),
      { kind: 'item', label: t('New section…'), icon: 'plus', onSelect: () => { setSectionName(''); setAddingSection({ view: v }) }, data: 'new-section' },
    ] })
    if (isChannel) {
      out.push({ kind: 'sep' })
      out.push({ kind: 'item', label: t('Daily summary to me'), icon: 'sparkle', onSelect: () => void dailySummary(th), data: 'summary' })
    }
    out.push({ kind: 'sep' }, { kind: 'head', label: t('Notify you about…') })
    out.push(
      { kind: 'item', label: t('All new posts'), checked: level === 'all', onSelect: () => void setPref(v, 'all'), data: 'notify-all' },
      { kind: 'item', label: t('Just mentions'), checked: level === 'mentions', onSelect: () => void setPref(v, 'mentions'), data: 'notify-mentions' },
      { kind: 'item', label: t('Mute'), checked: level === 'mute', onSelect: () => void setPref(v, 'mute'), data: 'notify-mute' },
    )
    if (isChannel && th.slug) {
      out.push({ kind: 'sep' })
      out.push({ kind: 'item', label: t('Rename channel…'), icon: 'edit', onSelect: () => setRenameDialog({ slug: th.slug!, name: th.name }), data: 'rename' })
      if (th.private) out.push({ kind: 'item', label: t('Add people…'), icon: 'invite', onSelect: () => setAddingTo(v), data: 'add-people' })
      out.push({ kind: 'sep' })
      out.push({ kind: 'item', label: t('Archive channel…'), icon: 'box', danger: true, onSelect: () => setArchiveDialog({ thread: th }), data: 'archive' })
      if (th.private) out.push({ kind: 'item', label: t('Leave channel'), danger: true, onSelect: () => void leaveChannel(th), data: 'leave' })
    }
    return out
  }
  const saveRename = async () => {
    if (!renameDialog || renameDialog.busy) return
    const name = renameDialog.name.trim()
    if (!name) return
    setRenameDialog({ ...renameDialog, busy: true, error: null })
    const err = await onRenameChannel(renameDialog.slug, name)
    if (err) { setRenameDialog((d) => d && { ...d, busy: false, error: err }); return }
    setRenameDialog(null)
    setToast(t('Renamed to #{name}', { name }))
  }
  const archiveChannel = async () => {
    if (!archiveDialog || archiveDialog.busy || !archiveDialog.thread.slug) return
    const th = archiveDialog.thread
    setArchiveDialog({ ...archiveDialog, busy: true, error: null })
    const res = await fetch(`${api.httpBase}/businesses/archive`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, slugs: [th.slug] }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => null) : null
    if (!res?.ok || !data?.archived) {
      setArchiveDialog((d) => d && { ...d, busy: false, error: data?.message || t('That did not work. Try again.') })
      return
    }
    setArchiveDialog(null)
    setSettings(false)
    if (current?.key === th.key) choose(null)
    window.dispatchEvent(new Event('honmaru:reload-businesses'))
    setToast(t('Archived #{name}', { name: th.name }))
  }

  // A teammate's profile, beside the conversation.
  const [profile, setProfile] = useState<null | { ref: string; data?: ProfileData; failed?: boolean }>(null)
  const readProfile = useCallback(async (ref: string): Promise<ProfileData | null> => {
    const res = await fetch(`${api.httpBase}/channels/member?orgId=${encodeURIComponent(api.orgId)}&ref=${encodeURIComponent(ref)}`, { headers: authHeaders }).catch(() => null)
    const d = res?.ok ? await res.json().catch(() => null) : null
    if (d?.member) views.set(`profile:${ref}`, d.member)
    return d?.member || null
  }, [api.httpBase, api.orgId, authHeaders, views])
  /// A profile opened again is drawn from what was read before, and read
  /// again behind it when that is more than half a minute old. Nothing kept
  /// and nothing read: said so, with a way to try again — never a
  /// "Loading…" that stays.
  const PROFILE_FRESH_MS = 30_000
  const cachedProfile = (ref: string) => views.get<ProfileData>(`profile:${ref}`)
  const openProfile = async (ref: string) => {
    setDetailId(null); setThread(null)
    const kept = cachedProfile(ref)
    setProfile({ ref, data: kept })
    if (kept && views.fresh(`profile:${ref}`, PROFILE_FRESH_MS)) return
    const data = await readProfile(ref)
    setProfile((prev) => (prev && prev.ref === ref ? (data ? { ref, data } : prev.data ? prev : { ref, failed: true }) : prev))
  }
  // Their card, popped out beside the face, name or @mention it was opened
  // from: what the member list knows at once, their clock once the same read
  // the pane makes is back. Over the conversation, so a thread open beside
  // it stays open. The same face or name again closes it.
  const [popout, setPopout] = useState<null | { ref: string; anchor: HTMLElement; name?: string; data?: ProfileData }>(null)
  const openPopout = (ref: string, anchor: HTMLElement, name?: string) => {
    if (popout && popout.ref === ref && popout.anchor === anchor) { setPopout(null); return }
    const kept = cachedProfile(ref)
    setPopout({ ref, anchor, name, data: kept })
    if (kept && views.fresh(`profile:${ref}`, PROFILE_FRESH_MS)) return
    void readProfile(ref).then((data) => { if (data) setPopout((prev) => (prev && prev.ref === ref && prev.anchor === anchor ? { ...prev, data } : prev)) })
  }
  /// Every @mention of a person presses like a button (MessageParts); this
  /// one handler, on the whole list, opens the card for whichever was
  /// pressed — in the conversation, a thread, Threads or Activity. It is
  /// still a word of the message: dragging across it to select it is not
  /// pressing it.
  const onMentionClick = (e: React.MouseEvent) => {
    const el = (e.target as Element).closest?.('[data-mention-ref]') as HTMLElement | null
    if (!el?.dataset.mentionRef) return
    const picked = window.getSelection()
    if (picked && !picked.isCollapsed && picked.containsNode(el, true)) return
    e.preventDefault()
    openPopout(el.dataset.mentionRef, el, el.textContent?.trim())
  }
  /// The same from the keyboard: Enter or Space on a mention that holds
  /// focus, as on any button. (Space would otherwise scroll the page.)
  const onMentionKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const el = e.target as HTMLElement
    if (!el.dataset?.mentionRef) return
    e.preventDefault()
    if (!e.repeat) openPopout(el.dataset.mentionRef, el, el.textContent?.trim())
  }
  // A status set — yours, from your avatar — or somebody joining or
  // leaving: the profile open beside the conversation is read again, as
  // the sidebar is.
  const profileRef = profile?.ref
  useEffect(() => {
    const stale = () => views.stale('profile:')
    window.addEventListener('honmaru:members-changed', stale)
    if (!profileRef) return () => window.removeEventListener('honmaru:members-changed', stale)
    const on = () => { void readProfile(profileRef).then((data) => { if (data) setProfile((prev) => (prev && prev.ref === profileRef ? { ref: profileRef, data } : prev)) }) }
    window.addEventListener('honmaru:members-changed', on)
    return () => { window.removeEventListener('honmaru:members-changed', on); window.removeEventListener('honmaru:members-changed', stale) }
  }, [profileRef, readProfile, views])

  // Keys a chat client has: ⌥↑/⌥↓ between conversations in the order the
  // sidebar shows them (a folded group's are out of sight, and skipped),
  // ⌥⇧↑/⌥⇧↓ between the ones with something new — a fold does not hide
  // those: the jump opens the group — ⌘⇧A Activity, ⌘⇧D the sidebar. None
  // of them while the shell has something over the list.
  const [sideHidden, setSideHidden] = useState(false)
  /// Set when a key, not a click, chose the conversation: its row can be past
  /// the edge of a long sidebar, and is brought into view once it is drawn
  /// (after the render that lights it, and unfolds its group).
  const walked = useRef(false)
  useLayoutEffect(() => {
    if (!walked.current) return
    walked.current = false
    document.querySelector('.slk-sections .cl-section .cl-thread.on')?.scrollIntoView({ block: 'nearest' })
  })
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      const mod = hasPrimaryMod(e, isMac)
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // With no conversation at all the keys are not the list's to take.
        const all = visibleOrder(sidebarGroups, {})
        if (!all.length) return
        e.preventDefault()
        // Under Activity or Later no row is lit: down starts at the top.
        const here = special ? null : current?.key ?? null
        // The unread jump looks inside folded groups too: a folded heading
        // counts the cards waiting in it, and a dot or an @ in one shows
        // nowhere else, so "Nothing unread" there would be untrue.
        const list = e.shiftKey ? all : visibleOrder(sidebarGroups, folded)
        const next = step(list, here, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey ? hasNews : undefined)
        if (!next) { setToast(e.shiftKey ? t('Nothing unread') : t('Every section is folded')); return }
        // The only one with something new is the one open.
        if (next.key === here) { if (e.shiftKey) setToast(t('Nothing else unread')); return }
        const home = foldedHome(sidebarGroups, folded, next.key)
        if (home) setFolded((p) => ({ ...p, [home]: false }))
        walked.current = true
        choose(next.key)
      } else if (mod && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault(); openActivity()
      } else if (mod && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault(); setSideHidden((h) => !h)
      } else if (e.shiftKey && e.key === 'Escape' && !composing(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); markEverythingRead()
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
    if (thread.kind === 'agent') {
      return <AgentAvatar className={`cl-lead cl-agent sz-${size}`} agent={thread.agent} />
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

  const row = (thread: Thread, reorder?: (to: { view: string; after: boolean }, from: string) => void) => {
    const on = !special && current?.key === thread.key
    const hasDraft = Boolean(thread.view && draftsFor(thread.view).length)
    const view = thread.view
    const drop = reorder && view && dropAt?.view === view && dragging && dragging !== view ? (dropAt.after ? ' drop-after' : ' drop-before') : ''
    const drag = reorder && view && wide ? {
      draggable: true,
      onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-honmaru-view', view); setDragging(view) },
      onDragOver: (e: React.DragEvent) => {
        if (!dragging || !e.dataTransfer.types.includes('text/x-honmaru-view')) return
        e.preventDefault(); e.dataTransfer.dropEffect = 'move'
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const after = e.clientY > box.top + box.height / 2
        if (dropAt?.view !== view || dropAt.after !== after) setDropAt({ view, after })
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const from = e.dataTransfer.getData('text/x-honmaru-view') || dragging
        if (from && dropAt) reorder(dropAt, from)
        setDragging(null); setDropAt(null)
      },
      onDragEnd: () => { setDragging(null); setDropAt(null) },
    } : {}
    return (
      <li key={thread.key} data-view={thread.view} {...drag} onContextMenu={wide && view ? (e) => { e.preventDefault(); setRowMenu({ thread, x: e.clientX, y: e.clientY, anchor: e.currentTarget }) } : undefined} className={`cl-row cl-thread${thread.unread || (thread.fresh && !on) ? ' unread' : ''}${on ? ' on' : ''}${thread.view && prefs[thread.view] === 'mute' ? ' muted' : ''}${dragging === view ? ' dragging' : ''}${drop}`}>
        <button className="cl-open" onClick={() => choose(thread.key)} aria-current={on ? 'true' : undefined}>
          {lead(thread, 'row')}
          <span className="cl-title">{thread.name}</span>
          {thread.kind === 'person' && (() => {
            const m = members.find((x) => thread.view === `dm:${x.ref}`)
            if (!m) return null
            const status = statusShown(m.status, Date.now())
            const away = awayShown(m.awayUntil, Date.now())
            return <>{status?.emoji && <span className="cl-status" title={status.text || ''}>{status.emoji}</span>}{away && <span className="cl-away" title={t('Away until {when}', { when: new Date(away).toLocaleDateString(locale) })}>{t('away')}</span>}</>
          })()}
          {thread.view && prefs[thread.view] === 'mute' && <span className="cl-muted" role="img" aria-label={t('Muted')}><Icon name="bell-off" size={13} /></span>}
          {thread.view && (mentionsIn[thread.view] || 0) > 0 && thread.unread === 0 && <span className="cl-badge mention">@{mentionsIn[thread.view]}</span>}
          {thread.unread > 0 && <span className="cl-badge">{thread.unread}</span>}
          {thread.unread === 0 && thread.fresh && !on && <span className="cl-fresh" aria-label={t('New messages')} />}
          {!on && thread.view && (drafts[thread.view] || hasDraft) && <span className={`cl-draft${hasDraft ? ' daily' : ''}`} title={hasDraft ? t('Your daily report is waiting to be posted') : t('Draft')} aria-label={t('Draft')} data-has-daily={hasDraft ? '1' : undefined}><Icon name="edit" size={12} /></span>}
        </button>
        {thread.view && isFresh(thread) && (
          // The @ or the dot, cleared from the list itself: hover or focus
          // the row, and it is one press (#213).
          <button type="button" className="cl-clear" onClick={() => markViewRead(thread.view!)} title={t('Mark as read')} aria-label={t('Mark {name} as read', { name: thread.name })} data-clear={thread.view}>
            <Icon name="check" size={13} />
          </button>
        )}
      </li>
    )
  }

  const section = (id: string, label: string, threads: readonly Thread[], empty: string, action?: React.ReactNode, below?: React.ReactNode, reorder?: (views: string[]) => void) => {
    const views = threads.map((th) => th.view).filter((v): v is string => Boolean(v))
    const place = reorder ? (to: { view: string; after: boolean }, from: string) => { if (views.includes(from)) reorder(moved(views, from, to)) } : undefined
    const shut = Boolean(folded[id])
    // Folded, it still shows the one open and what calls for you, as a chat
    // client's collapsed category does; the header counts what that is.
    const context = foldContext()
    const shown = shut ? foldedRows(threads, context) : threads
    const badge = sectionBadge(shown, mentionsIn, context.currentKey)
    return (
      <SidebarSection key={id} id={id} label={label} shut={shut} onFold={() => toggleFold(id)} badge={badge}
        rows={shown.map((th) => row(th, place))} empty={empty} action={action} below={below} />
    )
  }

  const addChannel = (
    <button type="button" className="cl-add" onClick={() => { setAdding((a) => !a); setProblem(null) }} aria-label={t('New channel')} aria-expanded={adding}>
      <Icon name="plus" size={14} />
    </button>
  )
  // A conversation with an agent: "+" lists every agent you can call.
  const addAgent = (
    <button type="button" className="cl-add" onClick={() => setAgentPicking((v) => !v)} aria-label={t('Talk to an agent')} title={t('Talk to an agent')} aria-expanded={agentPicking} data-add-agent="1">
      <Icon name="plus" size={14} />
    </button>
  )
  const agentPicker = agentPicking ? (
    <ul className="cl-agent-pick" role="menu" aria-label={t('Talk to an agent')}>
      {agents.map((a) => (
        <li key={a.id}>
          <button type="button" role="menuitem" className="cl-agent-option" onClick={() => openAgent(a.id)} data-pick-agent={a.id}>
            <AgentAvatar className="cl-lead cl-agent sz-row" agent={a} />
            <span className="cl-agent-option-name">{a.name}</span>
            <span className="cl-agent-option-handle">@{a.handle}</span>
          </button>
        </li>
      ))}
      <li>
        <button type="button" role="menuitem" className="cl-agent-option cl-agent-manage" onClick={() => { setAgentPicking(false); onOpenScreen?.('agents') }} data-manage-agents="1">
          <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="settings" size={13} /></span>
          <span className="cl-agent-option-name">{t('Make or change agents')}</span>
        </button>
      </li>
    </ul>
  ) : null
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
        onKeyDown={(e) => { if (e.key === 'Escape' && !composing(e)) { setAdding(false); setNewName('') } }}
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

  /// The sidebar's groups, top to bottom as drawn: Starred, your sections,
  /// Channels in your order, direct messages, Agents, Apps. The sidebar is
  /// drawn from this and the keys walk it, so the two cannot disagree.
  const starredThreads = layout.starred.map(byView).filter((x): x is Thread => Boolean(x))
  const sidebarGroups: SidebarSection[] = [
    // Starred first, then your sections; what they hold leaves the defaults.
    ...(starredThreads.length > 0 ? [{ id: 'starred', label: t('Starred'), items: starredThreads, empty: '', reorder: (views: string[]) => saveLayout({ ...layout, starred: views }) }] : []),
    ...layout.sections.map((x) => ({
      id: `sec:${x.id}`,
      label: x.name,
      items: x.views.map(byView).filter((th): th is Thread => Boolean(th) && !isStarred(th!.view!)),
      empty: t('Move a conversation here from its header.'),
      action: (
        <button type="button" className="cl-add cl-section-remove" onClick={() => { if (window.confirm(t('Remove the section “{name}”? Its conversations go back where they were.', { name: x.name }))) saveLayout({ ...layout, sections: layout.sections.filter((y) => y.id !== x.id) }) }} aria-label={t('Remove section')} title={t('Remove section')}>
          <Icon name="x" size={12} />
        </button>
      ),
      reorder: (views: string[]) => saveLayout({ ...layout, sections: layout.sections.map((y) => (y.id === x.id ? { ...y, views: [...views, ...y.views.filter((v) => !views.includes(v))] } : y)) }),
    })),
    {
      id: 'channels', label: t('Channels'), items: inYourOrder(channels.filter(unplaced)),
      empty: t('No channels yet. Make one, or let your AI file decisions under a business as they arrive.'),
      action: addChannel, below: addChannelForm,
      // Drag to reorder: the channels shown here in their new order,
      // then any placed elsewhere, as they were.
      reorder: (views: string[]) => saveLayout({ ...layout, order: [...views, ...inYourOrder(channels).map((th) => th.view!).filter((v) => v && !views.includes(v))] }),
    },
    { id: 'people', label: t('Direct messages'), items: people.filter(unplaced), empty: t('Nobody has sent you a decision yet.') },
    ...(agents.length > 0 ? [{ id: 'agents', label: t('Agents'), items: agentConvos.filter(unplaced), empty: t('Talk to one of your team’s agents: it answers you here.'), action: addAgent, below: agentPicker }] : []),
    { id: 'apps', label: t('Apps'), items: apps, empty: t('Connect Gmail or Slack under Tools and their decisions land here.') },
  ]

  // ---- What is said ----

  const cardsById = useMemo(() => {
    const map = new Map<string, DecisionCard>()
    for (const c of [...pending, ...sent, ...decided]) map.set(c.id, c)
    return map
  }, [pending, sent, decided])
  const messageCache = useMemo(() => channelMessageCache(api), [api.httpBase, api.orgId, api.sessionToken])
  const cacheScope = useRef<typeof messageCache | null>(messageCache)
  cacheScope.current = messageCache
  const [messages, setMessages] = useState<Record<string, ChannelMessage[]>>(() => ({ ...messageCache.messages }))
  /// A message sent from here stays drawn under its temporary id's key once
  /// the server's copy has taken its place (server id → temp id): the same
  /// element carries on, so nothing is redrawn and a picture in it is not
  /// loaded twice.
  const drawnAs = useRef(new Map<string, string>())
  const keyOf = (m: ChannelMessage) => drawnAs.current.get(m.id) || m.id
  const [draft, setDraft] = useState('')
  // An inline reply being written (Discord's Reply, not a thread): the
  // message the next one answers, in the conversation it was started in.
  const [replyingTo, setReplyingTo] = useState<{ view: string; quote: ReplyQuote } | null>(null)
  // Files going up with the next message: the conversation's, and a thread's.
  const uploads = useUploads(api, setProblem)
  const threadUploads = useUploads(api, setProblem)
  const [dropping, setDropping] = useState(false)
  const attachInput = useRef<HTMLInputElement>(null)
  const threadAttachInput = useRef<HTMLInputElement>(null)
  // Conversations where the AI is writing a card right now.
  // …and which step it is on: reading, routing, writing.
  const [thinking, setThinking] = useState<Record<string, string | false>>({})
  // The team's agents writing, per conversation: "🎨 Hayao is writing…"
  // in the thread it answers in.
  const [agentsWriting, setAgentsWriting] = useState<Record<string, AgentWriting[]>>({})
  const agentDone = useCallback((channel: string, id?: string | null) => {
    if (!id) return
    setAgentsWriting((prev) => (prev[channel]?.some((a) => a.id === id) ? { ...prev, [channel]: prev[channel].filter((a) => a.id !== id) } : prev))
  }, [])
  const composer = useRef<HTMLTextAreaElement>(null)
  const view = current?.view
  useEffect(() => {
    const opened = Boolean(current && current.key === chosenKey.current)
    chosenKey.current = null
    onViewChange?.(current?.view || null, current?.name || null, opened)
  // openKey too: choosing the conversation already on screen is opening it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.view, current?.name, openKey, onViewChange])
  // Whether there is more above what is loaded, per conversation: the
  // Worker's `more`, or, from one that does not say, a full page of PAGE.
  const [more, setMore] = useState<Record<string, boolean>>(() => ({ ...messageCache.more }))
  useEffect(() => {
    cacheScope.current = messageCache
    // Events are not received by this component while it is unmounted.
    return () => { cacheScope.current = null; messageCache.invalidate() }
  }, [messageCache])
  useEffect(() => { messageCache.remember(messages, more) }, [messageCache, messages, more])
  const PAGE = 150
  /// The newest page, laid over what is loaded rather than in place of it:
  /// it is read again on every answer from the AI and after a reconnect, and
  /// replacing took away the older pages somebody had scrolled up to read.
  /// Whether there is more above stays loadOlder's to say once those are
  /// loaded; only a hole too big to join starts again from the page.
  const loadMessages = useCallback((channel: string, force = true) => messageCache.load(channel, async (isCurrent) => {
    const before = messagesRef.current[channel] || []
    return fetch(`${api.httpBase}/channels/messages?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}`, { headers: authHeaders })
      .then((r) => {
        if ([401, 403, 404].includes(r.status) && isCurrent() && cacheScope.current === messageCache) {
          messageCache.forget(channel)
          setMessages((prev) => { const next = { ...prev }; delete next[channel]; return next })
        }
        return r.ok ? r.json() : null
      })
      .then((data) => {
        if (!data || !isCurrent() || cacheScope.current !== messageCache) return false
        // What is still on its way, or did not go, is only here: kept —
        // and what did not go before this page loaded, back where it was.
        const page = (data.messages || []) as ChannelMessage[]
        const had = messagesRef.current[channel]
        const back = heldFor(channel, undefined, page)
        setMessages((prev) => ({ ...prev, [channel]: withHeld(mergeLatestMessages(prev[channel] || [], page, before, leavesGap(prev[channel], page, PAGE), !hasOlder(data, PAGE)), back) }))
        if (!hasOlder(data, PAGE) || leavesGap(had, page, PAGE) || !reachesPast(had, page)) setMore((prev) => ({ ...prev, [channel]: hasOlder(data, PAGE) }))
        maybeNewEmoji(page.map((m) => `${m.body || ''} ${(m.reactions || []).map((r) => r.emoji).join(' ')}`).join(' '))
        return true
      })
      .catch(() => false) // Keep cached messages visible offline; failed loads may retry.
  }, force), [api.httpBase, api.orgId, authHeaders, maybeNewEmoji, messageCache])
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
      // A place is kept only for a page that puts something above. One that
      // adds nothing (the conversation had exactly a page) changes no length,
      // and the place kept would be used by whatever arrived next — a jump
      // back up to where the older page was asked for.
      const had = new Set(list.map((m) => m.id))
      if (older.some((m) => !had.has(m.id))) keepScroll.current = logRef.current ? logRef.current.scrollHeight - logRef.current.scrollTop : null
      setMessages((prev) => {
        const cur = prev[channel] || []
        const known = new Set(cur.map((m) => m.id))
        return { ...prev, [channel]: [...older.filter((m) => !known.has(m.id)), ...cur] }
      })
      setMore((prev) => ({ ...prev, [channel]: hasOlder(data, PAGE) }))
    } catch { /* try again on the next scroll */ } finally {
      loadingOlder.current = false
    }
  }, [api.httpBase, api.orgId, authHeaders, more])
  useEffect(() => { if (view) void loadMessages(view, false) }, [view, loadMessages])
  // Where you were up to when you opened it: the red "New" line goes there.
  const [newSince, setNewSince] = useState<{ view: string; at: string } | null>(null)
  useEffect(() => {
    if (!view) { setNewSince(null); return }
    setNewSince({ view, at: readAt(view) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  // Where the reader is: at the bottom, reading along, or up in the history
  // since the newest thing they had was said. Up there, what arrives waits
  // below them — not read, and counted — until they come back down.
  const [readingUp, setReadingUp] = useState<{ view: string; since: string } | null>(null)
  const atBottom = !readingUp || readingUp.view !== view
  /// The log scrolled: whether that left the bottom, or came back to it.
  const noteWhere = (v: string, el: HTMLElement) => {
    if (isAtBottom(el)) { if (readingUp) setReadingUp(null); return }
    if (readingUp?.view === v) return
    const list = messages[v] || []
    setReadingUp({ view: v, since: list[list.length - 1]?.createdAt || '' })
  }
  // Whether anybody is looking at the page. What is open is read only
  // then, and read again the moment they come back to it.
  const [looking, setLooking] = useState(() => typeof document === 'undefined' || isLooking(document))
  useEffect(() => {
    const look = () => setLooking(isLooking(document))
    // Focus going into a frame on the page blurs the window before the
    // frame has it; asked a moment later, the page still has focus.
    const blurred = () => { setTimeout(look, 0) }
    document.addEventListener('visibilitychange', look)
    window.addEventListener('focus', look)
    window.addEventListener('blur', blurred)
    return () => {
      document.removeEventListener('visibilitychange', look)
      window.removeEventListener('focus', look)
      window.removeEventListener('blur', blurred)
    }
  }, [])
  // An app looked at is read: its count goes, here and on every device —
  // and again when something new arrives while it is open.
  // Only when there is something new to clear: every write counts against
  // the same allowance as sending a message.
  const appOpen = current?.kind === 'app' ? current.key : null
  const appNew = current?.kind === 'app' ? current.unread : 0
  useEffect(() => {
    if (!appOpen || appNew === 0 || !looking) return
    const now = new Date().toISOString()
    try { localStorage.setItem(seenKey(api.orgId, appOpen), now) } catch { /* the server remembers */ }
    setSeenTick((n) => n + 1)
    void fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: appOpen, at: now }),
    }).then(() => setServerReads((prev) => ({ ...prev, [appOpen]: now }))).catch(() => { /* this device still remembers */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appOpen, appNew, api.orgId, looking])
  // Opened is read — here, and on the server for your other devices —
  // unless you just marked it unread and are still looking at it.
  const heldUnread = useRef<string | null>(null)
  useEffect(() => { if (heldUnread.current && heldUnread.current !== view) heldUnread.current = null }, [view])
  /// Read up to now, here and on the server for your other devices: the
  /// conversation's count goes, its notifications close, and what was said
  /// in it is no longer new in Activity (a reply waits for its thread).
  const readOnServer = (v: string, now: string) => {
    readGuard.readChannel(v, now)
    fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: v, at: now }),
    }).then(() => setServerReads((prev) => ({ ...prev, [v]: now }))).catch(() => { /* this device still remembers */ })
    closeNotifications(api.orgId, v)
    setActivityItems((prev) => prev && prev.map((i) => (i.unread && i.message.channel === v && !i.message.parentId && (i.at || i.message.createdAt) <= now ? { ...i, unread: false } : i)))
  }
  const readHere = (v: string) => {
    const now = new Date().toISOString()
    try { localStorage.setItem(seenKey(api.orgId, v), now) } catch { /* private mode: nothing remembered */ }
    setSeenTick((n) => n + 1)
    return now
  }
  /// "Mark as read" from the sidebar, without opening it.
  /// Its @ goes with it: every unread mention of you in it, its threads'
  /// included — and nothing of any other conversation (#213).
  const markViewRead = (v: string) => {
    readOnServer(v, readHere(v))
    const mentions = (activityItems || []).filter((i) => i.unread && i.type === 'mention' && i.message.channel === v).map(activityKey)
    if (mentions.length) markActivitySeen(mentions)
  }
  /// A dot or an @ waiting in it.
  const isFresh = (th: Thread) => Boolean(th.view && (th.fresh || (mentionsIn[th.view] || 0) > 0))
  /// Where ⌥⇧↑/⌥⇧↓ stop: a dot or an @, or cards waiting on you, which
  /// reading does not clear.
  const hasNews = (th: Thread) => th.unread > 0 || isFresh(th)
  /// Everything new, read at once — ⇧Esc, as in Slack: every conversation
  /// with a dot or an @ waiting, and Activity with them.
  const freshViews = () => everything.filter(isFresh).map((th) => th.view!)
  const markEverythingRead = () => {
    const views = freshViews()
    const activityNew = (activityItems || []).some((i) => i.unread)
    if (!views.length && !activityNew) { setToast(t('Nothing new to mark as read')); return }
    for (const v of views) markViewRead(v)
    if (activityNew) markAllActivityRead()
    setToast(views.length ? t('Marked {n} conversations as read', { n: views.length }) : t('Activity marked as read'))
  }
  /// The server's half of a read, sent a moment after this device's. Once
  /// this device has stored a conversation read, the server hears it too —
  /// scrolling up in that moment, or more arriving, does not take it back
  /// (more arriving moves it on to now). Another conversation, leaving, or
  /// marking it unread meanwhile does.
  const serverRead = useRef<{ view: string; now: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const dropServerRead = () => {
    if (serverRead.current) clearTimeout(serverRead.current.timer)
    serverRead.current = null
  }
  // Read as Discord reads it: on opening, and then as things arrive only
  // while you are at the bottom to see them. Scrolled up in the history, it
  // stays unread until you come back down.
  useEffect(() => {
    if (!view || heldUnread.current === view || !atBottom || !looking) return
    const now = readHere(view)
    if (serverRead.current?.view === view) { serverRead.current.now = now; return }
    dropServerRead()
    const timer = setTimeout(() => {
      const due = serverRead.current
      serverRead.current = null
      if (due && heldUnread.current !== due.view) readOnServer(due.view, due.now)
    }, 600)
    serverRead.current = { view, now, timer }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, api.orgId, messages[view || '']?.length, atBottom, looking])
  useEffect(() => dropServerRead, [view, api.orgId])
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
      maybeNewEmoji(`${m.body || ''} ${reactions.map((r) => r.emoji).join(' ')}`)
      if (m.parentId) {
        // A reply: into the thread if it is open — our own, back before the
        // answer to the send, in place of the copy on its way. Its parent's
        // count comes as an event of its own.
        setThread((prev) => {
          if (!prev || prev.parent.id !== m.parentId) return prev
          if (m.deleted) return { ...prev, replies: prev.replies.filter((x) => x.id !== m.id) }
          const held = echoOf(prev.replies, msg)
          if (held) drawnAs.current.set(m.id, held.id)
          // One that looked failed got there: not kept to send again.
          if (held?.failed) queueMicrotask(() => settle(held.id))
          return { ...prev, replies: arrive(prev.replies, msg) }
        })
        // Sent to the conversation too: there as well.
        if (m.alsoChannel) inConversationToo(m.channel, msg)
        if (m.kind === 'ai') setThinking((prev) => ({ ...prev, [m.channel]: false }))
        if (m.kind === 'agent') agentDone(m.channel, m.agent?.id)
        return
      }
      if (m.channel.startsWith('g:') && !groupsRef.current.some((g) => g.view === m.channel)) setChannelsTick((n) => n + 1)
      let isNew = false
      setMessages((prev) => {
        const list = prev[m.channel]
        if (!list) return prev
        const has = list.some((x) => x.id === m.id)
        isNew = !has
        // Deleted is gone — its thread with it — never a "was deleted" line;
        // a reply quoting it says so instead, and one quoting an edit
        // quotes the new words.
        if (m.deleted) return { ...prev, [m.channel]: refreshQuotes(list.filter((x) => x.id !== m.id), msg) }
        // Our own, back before the answer to the send, takes the place of
        // the copy on its way rather than showing twice.
        const held = echoOf(list, msg)
        if (held) drawnAs.current.set(m.id, held.id)
        if (held?.failed) queueMicrotask(() => settle(held.id))
        return { ...prev, [m.channel]: refreshQuotes(arrive(list, msg), msg) }
      })
      setReplyingTo((prev) => (prev?.quote.id === m.id ? { ...prev, quote: quoteOf(msg) } : prev))
      setThread((prev) => (prev && prev.parent.id === m.id ? (m.deleted ? null : { ...prev, parent: msg }) : prev))
      if (!m.deleted && !m.editedAt && (isNew || !messagesRef.current[m.channel])) {
        setActivity((prev) => ({ ...prev, [m.channel]: { channel: m.channel, lastAt: m.createdAt, preview: m.body.slice(0, 120), lastBy: mine ? 'me' : m.authorName, last: msg } }))
      }
      if (m.kind === 'ai') {
        setThinking((prev) => ({ ...prev, [m.channel]: false }))
        void loadMessages(m.channel)
      }
      if (m.kind === 'agent') agentDone(m.channel, m.agent?.id)
    }
    window.addEventListener('honmaru:channel-message', on)
    return () => window.removeEventListener('honmaru:channel-message', on)
  }, [members, loadMessages, maybeNewEmoji, agentDone])
  // The AI's steps, as it takes them.
  useEffect(() => {
    const on = (e: Event) => {
      const p = (e as CustomEvent<{ channel: string; step: string; parentId?: string | null; agent?: { id: string; name: string; emoji?: string | null; avatarUrl?: string | null } }>).detail
      if (!p?.channel) return
      // One of the team's agents: its own line, not the AI's steps.
      if (p.agent?.id) {
        const a = p.agent
        if (p.step === 'agent') {
          setAgentsWriting((prev) => ({
            ...prev,
            [p.channel]: [...(prev[p.channel] || []).filter((x) => x.id !== a.id), { id: a.id, name: a.name, emoji: a.emoji || null, avatarUrl: a.avatarUrl || null, parentId: p.parentId || null, at: Date.now() }],
          }))
          // A "done" that never came does not leave it writing forever. A
          // long research says it is still at it every round; only silence
          // for two minutes ends the line.
          setTimeout(() => setAgentsWriting((prev) => {
            const still = prev[p.channel]?.find((x) => x.id === a.id)
            if (!still || Date.now() - (still.at || 0) < 119_000) return prev
            return { ...prev, [p.channel]: prev[p.channel].filter((x) => x.id !== a.id) }
          }), 120_000)
        } else agentDone(p.channel, a.id)
        return
      }
      setThinking((prev) => ({ ...prev, [p.channel]: p.step === 'done' || p.step === 'failed' ? false : p.step }))
    }
    window.addEventListener('honmaru:channel-progress', on)
    return () => window.removeEventListener('honmaru:channel-progress', on)
  }, [agentDone])

  /// Who you are in this workspace, once the team has loaded: whose name
  /// what you send goes under, and whose what is kept here must be.
  const myRef = members.find((m) => m.mine)?.ref
  /// A message on its way, or one that did not go, by its temporary id:
  /// what Retry sends again, and (`landing`) the server's copy an edit begun
  /// on it waits for. Its words are in the log with it. `abort` gives up on
  /// it while it goes — Delete, offered once it is still going at `lateAt`.
  /// `going`: in line or sent, with no answer yet, so a Retry pressed twice
  /// sends it once. `said` is how it was first drawn, and `failed` and
  /// `refused` how it stands: kept in this browser (keepOutbox) so that a
  /// reload or a closed tab does not lose it. `restored`: kept from before
  /// this page loaded, and not drawn yet.
  type Outgoing = {
    tempId: string; channel: string; body: string; decide: boolean; parentId?: string; files: FileRef[]; said: ChannelMessage
    landing?: Promise<ChannelMessage | null>; abort?: () => void; lateAt?: number; going?: boolean
    failed?: string; refused?: boolean; restored?: boolean
  }
  const outbox = useRef(new Map<string, Outgoing>())
  /// Every message this tab has sent, or done something with — Retry,
  /// Delete, Edit, or found it got there — gone since or not: what it keeps
  /// in this browser is only ever these, never another tab's. One kept from
  /// before this page loaded is not among them until then: every open tab
  /// brings it back, and one that has not touched it must not write it back
  /// after another tab has sent it or thrown it away.
  const heldHere = useRef(new Set<string>())
  /// The outbox as it is now, kept in this browser for a reload or the next
  /// visit: this tab's messages as they stand, and any other — another
  /// tab's, or one brought back that this tab has not touched — left as it
  /// is kept. `tempId`: one this tab does something with now, so its own.
  const keepOutbox = (tempId?: string) => {
    // Signed out (or someone else signed in) while a send was still going:
    // a failure that lands now must not write the words back to disk.
    try { if (localStorage.getItem('userId') !== userId) return } catch { return }
    if (tempId) heldHere.current.add(tempId)
    const now: Unsent[] = []
    for (const o of outbox.current.values())
      now.push({ said: o.said, decide: o.decide, ...(o.failed ? { failed: o.failed } : {}), ...(o.refused ? { refused: true } : {}) })
    const key = outboxKey(api.orgId, userId)
    try {
      const kept = keptUnsent(readUnsent(localStorage.getItem(key)), now, heldHere.current)
      if (kept.length) localStorage.setItem(key, JSON.stringify(kept)); else localStorage.removeItem(key)
    } catch { /* not kept: this tab still has them */ }
  }
  /// One kept in this browser from before this page loaded, back in the
  /// outbox: failed, and not drawn yet — nor this tab's (heldHere) until it
  /// does something with it.
  const restore = (u: Unsent) => {
    if (outbox.current.has(u.said.id)) return
    outbox.current.set(u.said.id, {
      tempId: u.said.id, channel: u.said.channel, body: u.said.body, decide: u.decide, parentId: u.said.parentId || undefined, files: u.said.files || [], said: u.said,
      failed: u.failed || t('That did not send. Try again.'), refused: u.refused, restored: true,
    })
  }
  // What did not go before this page loaded: back in the outbox, failed,
  // drawn where it was sent once that conversation or thread is loaded.
  // Only yours — kept under your own key, not the workspace's, so what
  // someone else signed in here left unsent is never drawn as yours.
  useEffect(() => {
    let kept: Unsent[] = []
    try { kept = readUnsent(localStorage.getItem(outboxKey(api.orgId, userId))) } catch { /* nothing kept */ }
    for (const u of kept) if (keptAsYours(u.said, myRef)) restore(u)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.orgId, userId])
  // Once the team has loaded, who you are is known. One kept for you that
  // names someone else as its author is let go — never drawn as yours, nor
  // sent under your name. What was kept for the whole workspace, before it
  // was kept per person, comes back only where it names you; the rest, and
  // the old key with it, is dropped.
  useEffect(() => {
    if (!myRef) return
    for (const o of [...outbox.current.values()]) {
      if (keptAsYours(o.said, myRef)) continue
      o.abort?.()
      drop(o.tempId, o.channel, o.parentId)
    }
    let shared: Unsent[] = []
    try {
      shared = readUnsent(localStorage.getItem(sharedOutboxKey(api.orgId)))
      localStorage.removeItem(sharedOutboxKey(api.orgId))
    } catch { /* nothing kept there */ }
    const yours = shared.filter((u) => provenYours(u.said, myRef))
    // Taken from a key that is gone now: this tab keeps them, under yours.
    for (const u of yours) { restore(u); heldHere.current.add(u.said.id) }
    if (yours.length) keepOutbox()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myRef])
  // Leaving while something is still on its way: asked first, as it may not
  // get there. What did not go is kept for next time, so is not asked about.
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => {
      if (![...outbox.current.values()].some((o) => o.going)) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', leaving)
    return () => window.removeEventListener('beforeunload', leaving)
  }, [])
  /// Ours for one conversation (`parentId` unset) or one thread, as they are
  /// to be drawn: on their way or failed as they stand. One kept from before
  /// this page loaded is let go instead when `fresh`, what the server has
  /// there, shows it got there after all; one the socket's copy has already
  /// taken the place of is drawn as that.
  const heldFor = (channel: string, parentId: string | undefined, fresh: ChannelMessage[]): ChannelMessage[] => {
    const back: ChannelMessage[] = []
    const taken = new Set(drawnAs.current.values())
    let settled = false
    for (const o of [...outbox.current.values()]) {
      const here = parentId ? o.parentId === parentId : !o.parentId && o.channel === channel
      if (!here || taken.has(o.tempId)) continue
      const fromBefore = o.restored
      if (o.restored) o.restored = false
      // Failed, and not on its way: a page that already has it means the
      // send landed and the answer was lost. Sending it again would post it twice.
      if (!o.going && !o.refused && (fromBefore || o.failed) && wentAfterAll(o.said, fresh)) {
        outbox.current.delete(o.tempId); heldHere.current.add(o.tempId); settled = true; continue
      }
      back.push(o.failed ? unsentAgain(o, o.failed) : { ...o.said, pending: true, failed: undefined, refused: undefined })
    }
    if (settled) keepOutbox()
    return back
  }
  /// One that looked failed but got there: the socket's copy has taken its
  /// place, so it is no longer kept to be sent again.
  const settle = (tempId: string) => {
    const o = outbox.current.get(tempId)
    if (!o || o.going) return
    outbox.current.delete(tempId)
    keepOutbox(tempId)
  }
  /// The same words to the same place a moment ago: a second Enter or a
  /// double tap before the box has cleared does not send them twice. Said
  /// again on purpose, they go again (isDoubleSend).
  const justSent = useRef(new Map<string, number>())
  /// A message for later, waiting for the server's answer: the box still
  /// holds it until then, so Enter again meanwhile does not schedule it twice.
  const scheduling = useRef(new Set<string>())
  const goingKey = (o: Pick<Outgoing, 'channel' | 'parentId' | 'body' | 'files'>) => [o.channel, o.parentId || '', o.body, o.files.map((f) => f.id).join(',')].join('\n')
  /// A conversation's messages go one after another, in the order they were
  /// sent — as they did from the box that locked — or two sent in a blink
  /// could reach the server, and be kept, the other way round.
  const inLine = useRef(new Map<string, Promise<unknown>>())

  const send = async (channel: string, decide: boolean, parentId?: string, sendAt?: string) => {
    let body = (parentId ? threadDraft : draft).trim()
    const up = parentId ? threadUploads : uploads
    if (!body && !up.ids.length) return
    if (up.busy) { setProblem(t('Wait for the files to finish uploading.')); return }
    if (sendAt && up.ids.length) { setProblem(t('A scheduled message cannot carry files yet.')); return }
    // A command, not a message: done here, with a note only you see.
    const cmd = !parentId && !sendAt ? /^\/(\w+)\s*([\s\S]*)$/.exec(body) : null
    if (cmd) {
      const [, name, rest] = cmd
      const done = await runCommand(channel, name.toLowerCase(), rest.trim())
      if (done === 'send-decide') { body = rest.trim(); decide = true }
      else if (done === 'send-later') return
      else { if (done) clearDraftOf(channel); return }
      if (!body) return
    }
    const files = up.items.flatMap((i) => (i.state === 'done' && i.file ? [i.file] : []))
    const key = goingKey({ channel, parentId, body, files })
    if (sendAt ? scheduling.current.has(key) : isDoubleSend(justSent.current, key)) return
    setProblem(null)
    // Written now, sent later: nothing shows in the conversation until it
    // goes, so this one still waits for the server's answer.
    if (sendAt) {
      scheduling.current.add(key)
      const res = await fetch(`${api.httpBase}/channels/messages`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel, body, decide, ...(parentId ? { parentId, ...(threadAlso ? { alsoChannel: true } : {}) } : {}), sendAt }),
      }).catch(() => null)
      const data = res ? await res.json().catch(() => ({})) : {}
      scheduling.current.delete(key)
      if (!res?.ok || !data.scheduled) { setProblem(res && !res.ok ? refusal(data) : t('That did not send. Try again.')); return }
      if (parentId) { setThreadDraft(''); setThreadAlso(false) } else clearDraftOf(channel)
      setScheduled((prev) => [...prev, data.scheduled].sort((a, b) => a.sendAt.localeCompare(b.sendAt)))
      note(channel, t('Scheduled for {when}.', { when: new Date(data.scheduled.sendAt).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }))
      return
    }
    // In the conversation at once, marked as on its way, and the box free
    // for the next line while it goes — the files in it are already up.
    // The conversation's own box answers the message it is replying to: the
    // quote rides on the copy shown at once, and on a retry or a reload.
    const quoting = !parentId && replyingTo?.view === channel ? replyingTo.quote : null
    const temp = { ...tempMessage({ channel, body, parentId, files }, { name: myName || null, ref: myRef || null, avatar: myAvatar }, sendTime(parentId ? undefined : messagesRef.current[channel])), ...(quoting ? { replyTo: quoting } : {}), ...(parentId && threadAlso ? { alsoChannel: true } : {}) }
    if (quoting) setReplyingTo(null)
    // Sent: nobody is typing in this box any more.
    stoppedTyping({ channel, parentId: parentId || null })
    if (parentId) {
      setThreadDraft('')
      setThreadAlso(false)
      setThread((prev) => (prev && prev.parent.id === parentId ? { ...prev, replies: [...prev.replies, temp] } : prev))
    } else {
      clearDraftOf(channel)
      setMessages((prev) => ({ ...prev, [channel]: [...(prev[channel] || []), temp] }))
    }
    up.clear()
    if (parentId) threadComposer.current?.focus(); else composer.current?.focus()
    const out: Outgoing = { tempId: temp.id, channel, body, decide, parentId, files, said: temp, lateAt: Date.now() + SEND_TIMEOUT }
    outbox.current.set(temp.id, out)
    out.landing = deliver(out)
    keepOutbox(temp.id)
    await out.landing
  }

  /// Send what shows as on its way, once whatever went before it in that
  /// conversation has had its answer.
  const deliver = (out: Outgoing): Promise<ChannelMessage | null> => {
    out.going = true
    const turn = (inLine.current.get(out.channel) || Promise.resolve()).then(() => post(out)).finally(() => { out.going = false })
    inLine.current.set(out.channel, turn.catch(() => null))
    return turn
  }
  /// The server's copy takes the place of ours. No answer in SEND_TIMEOUT
  /// and it is given up on as a dropped connection would be — with Retry —
  /// and the next in line goes; a request that hangs holds nothing up.
  const post = async (out: Outgoing): Promise<ChannelMessage | null> => {
    const { tempId, channel, body, decide, parentId, files } = out
    // Deleted while it waited its turn: it never goes.
    if (outbox.current.get(tempId) !== out) return null
    const ctrl = new AbortController()
    out.abort = () => ctrl.abort()
    const stopClock = sendDeadline(ctrl, SEND_TIMEOUT, askingAboutData)
    const res = await fetch(`${api.httpBase}/channels/messages`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, body, decide, clientId: tempId, ...(parentId ? { parentId, ...(out.said.alsoChannel ? { alsoChannel: true } : {}) } : {}), ...(out.said.replyTo?.id ? { replyTo: out.said.replyTo.id } : {}), ...(files.length ? { files: files.map((f) => f.id) } : {}) }),
      signal: ctrl.signal,
    }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    stopClock()
    out.abort = undefined
    const msg = res?.ok ? (data.message as ChannelMessage | undefined) : undefined
    // Deleted while it went, and it did not land: nothing more to say.
    if (!msg?.id && outbox.current.get(tempId) !== out) return null
    if (!msg?.id) {
      // Unsent while this was on its way: back in the box, to go as a plain
      // message if it is sent again.
      if (res && !res.ok && data.code === 'reply_gone') { out.said = { ...out.said, replyTo: null }; refuse(out, t('The message you were replying to is gone. Send again to post this on its own.')) }
      else if (res && !res.ok && refusedOutright(res.status)) refuse(out, refusal(data))
      else fail(out, res && !res.ok ? refusal(data) : t('That did not send. Try again.'))
      return null
    }
    outbox.current.delete(tempId)
    keepOutbox(tempId)
    // An edit begun on it while it went carries on, on the server's copy.
    setEditing((e) => (e && e.id === tempId ? { ...e, id: msg.id } : e))
    // Sent: a small confirmation, in a direct conversation — as Slack does.
    if (channel.startsWith('dm:') || channel.startsWith('ag:')) playSound('sent')
    // Drawn on in ours' place — unless something else already took it.
    if (parentId) {
      setThread((prev) => {
        if (!prev || prev.parent.id !== parentId) return prev
        drawUnder(drawnAs.current, msg.id, tempId, prev.replies)
        return { ...prev, replies: reconcile(prev.replies, tempId, msg) }
      })
      // The parent as the server now has it: its count is a fact, not
      // one more than whatever the live event already made it.
      const parent = data.parent as ChannelMessage | undefined
      setMessages((prev) => ({ ...prev, [channel]: (prev[channel] || []).map((x) => (x.id !== parentId ? x
        : parent ? { ...x, replyCount: Math.max(parent.replyCount || 0, x.replyCount || 0), lastReplyAt: parent.lastReplyAt || msg.createdAt, replyRefs: parent.replyRefs || x.replyRefs }
          : { ...x, replyCount: (x.replyCount || 0) + 1, lastReplyAt: msg.createdAt })) }))
      if (msg.alsoChannel) inConversationToo(channel, msg)
      if (data.deciding) setThinking((prev) => ({ ...prev, [channel]: 'reading' }))
      return msg
    }
    setMessages((prev) => {
      const list = prev[channel] || []
      drawUnder(drawnAs.current, msg.id, tempId, list)
      return { ...prev, [channel]: reconcile(list, tempId, msg) }
    })
    if (data.deciding) setThinking((prev) => ({ ...prev, [channel]: 'reading' }))
    return msg
  }

  /// It did not go: it stays where it was, marked, with why. Moved on from
  /// there since, you are told where you are now as well. A reply whose
  /// thread has closed is kept, and is back in the thread when it is opened
  /// again. `refused`: the server said no to the words, so it waits to be
  /// edited, not retried.
  const fail = (out: Outgoing, why: string, refused = false) => {
    const { tempId, channel, parentId } = out
    out.failed = why
    out.refused = refused || undefined
    keepOutbox(tempId)
    if (parentId) {
      if (shownNow.current.thread !== parentId) { setProblem(why); return }
      setThread((prev) => (prev && prev.parent.id === parentId ? { ...prev, replies: markFailed(prev.replies, tempId, why, refused) } : prev))
      return
    }
    setMessages((prev) => (prev[channel] ? { ...prev, [channel]: markFailed(prev[channel], tempId, why, refused) } : prev))
    if (shownNow.current.view !== channel) setProblem(why)
  }
  /// Refused for what it says — a data rule, a thread that has gone: back
  /// into the box it was written in, files and all, with why above it, when
  /// that box is on screen and empty. With something else written there by
  /// now, it stays where it was with Edit, so neither is lost.
  const refuse = (out: Outgoing, why: string) => {
    const { tempId, channel, parentId, body, files } = out
    const box = parentId
      ? shownNow.current.thread === parentId && !boxes.current.thread.trim() && !boxes.current.threadFiles
      : shownNow.current.view === channel && draftView.current === channel && !boxes.current.draft.trim() && !boxes.current.files
    if (!box) { fail(out, why, true); return }
    drop(tempId, channel, parentId)
    if (parentId) { setThreadDraft(body); threadUploads.restore(files) } else { setDraft(body); uploads.restore(files) }
    setProblem(why)
  }
  /// Edit, under one that was refused: its words and files back in the box
  /// it was written in, after whatever is there already, and it goes from
  /// the conversation — it was only ever here.
  const writeAgain = (m: ChannelMessage) => {
    const after = (was: string) => (was.trim() ? `${was.replace(/\s+$/, '')}\n${m.body}` : m.body)
    if (m.parentId) { setThreadDraft(after); threadUploads.restore(m.files || []) } else { setDraft(after); uploads.restore(m.files || []) }
    discard(m)
    ;(m.parentId ? threadComposer : composer).current?.focus()
  }
  /// Retry: the same words, files and thread, on their way again from
  /// where they are.
  const retry = (m: ChannelMessage) => {
    const fresh = (m.parentId
      ? (thread?.parent.id === m.parentId ? thread.replies : [])
      : (messages[m.channel] || [])).filter((x) => !isTemp(x))
    const real = landedCopy(m, fresh)
    if (real && !m.refused) {
      if (m.parentId) setThread((prev) => (prev && prev.parent.id === m.parentId ? { ...prev, replies: reconcile(prev.replies, m.id, real) } : prev))
      if (m.parentId && real.alsoChannel) inConversationToo(m.channel, real)
      else if (!m.parentId) setMessages((prev) => (prev[m.channel] ? { ...prev, [m.channel]: reconcile(prev[m.channel], m.id, real) } : prev))
      settle(m.id)
      return
    }
    const out: Outgoing = outbox.current.get(m.id) || { tempId: m.id, channel: m.channel, body: m.body, decide: false, parentId: m.parentId || undefined, files: m.files || [], said: m }
    if (out.going) return
    out.lateAt = Date.now() + SEND_TIMEOUT
    out.failed = undefined
    out.refused = undefined
    outbox.current.set(m.id, out)
    if (out.parentId) setThread((prev) => (prev && prev.parent.id === out.parentId ? { ...prev, replies: markPending(prev.replies, m.id) } : prev))
    else setMessages((prev) => (prev[out.channel] ? { ...prev, [out.channel]: markPending(prev[out.channel], m.id) } : prev))
    out.landing = deliver(out)
    keepOutbox(m.id)
  }
  /// The server's id for one of yours sent from here: waited for while it
  /// is on its way, none when it did not go.
  const landedId = async (tempId: string) => {
    const out = outbox.current.get(tempId)
    if (out) return (await out.landing)?.id || null
    for (const [id, drawn] of drawnAs.current) if (drawn === tempId) return id
    return null
  }
  /// One only ever held here, gone from where it was drawn.
  const drop = (tempId: string, channel: string, parentId?: string | null) => {
    outbox.current.delete(tempId)
    keepOutbox(tempId)
    if (parentId) setThread((prev) => (prev && prev.parent.id === parentId ? { ...prev, replies: prev.replies.filter((x) => x.id !== tempId) } : prev))
    if (parentId) setMessages((prev) => (prev[channel]?.some((x) => x.id === tempId) ? { ...prev, [channel]: prev[channel].filter((x) => x.id !== tempId) } : prev))
    else setMessages((prev) => (prev[channel] ? { ...prev, [channel]: prev[channel].filter((x) => x.id !== tempId) } : prev))
  }
  /// Delete: it was only ever here, so it just goes — still on its way, it
  /// is given up on first, or dropped from the line before its turn.
  const discard = (m: ChannelMessage) => {
    outbox.current.get(m.id)?.abort?.()
    drop(m.id, m.channel, m.parentId)
  }

  // ---- Time and gathering: drafts, scheduled sends, Later, clips, notes ----
  // A draft per conversation, kept in this browser, as in any chat client.
  const draftKey = (v: string) => `draft:${api.orgId}:${v}`
  const [drafts, setDrafts] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {}
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ''; if (k.startsWith(`draft:${api.orgId}:`) && localStorage.getItem(k)) out[k.slice(`draft:${api.orgId}:`.length)] = true } } catch { /* none kept */ }
    return out
  })
  // Where a draft is kept: the conversation's channel, or — for Your AI,
  // which has a box but no channel — its row (`app:ai`). Without that, what
  // was written to your AI was never kept, and went the moment you looked
  // somewhere else.
  const draftId = current?.view || (current?.app === 'ai' ? current.key : undefined)
  const isDraftOf = (x: Thread, v: string) => x.view === v || (x.app === 'ai' && x.key === v)
  const draftCount = Object.keys(drafts).filter((v) => drafts[v] && everything.some((x) => isDraftOf(x, v))).length
  const draftView = useRef<string | undefined>(undefined)
  // Before paint, so a conversation never shows an empty box first.
  useLayoutEffect(() => {
    // Leaving a conversation keeps what was being written there; arriving
    // brings back what was being written here.
    draftView.current = draftId
    let kept = ''
    try { kept = draftId ? localStorage.getItem(draftKey(draftId)) || '' : '' } catch {}
    setDraft(kept)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId])
  useEffect(() => {
    const v = draftView.current
    if (!v || v !== draftId) return
    try { if (draft) localStorage.setItem(draftKey(v), draft); else localStorage.removeItem(draftKey(v)) } catch {}
    setDrafts((prev) => (Boolean(prev[v]) === Boolean(draft) ? prev : { ...prev, [v]: Boolean(draft) }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  /// What was sent leaves the box it was written in. Moved on to another
  /// conversation while it went, only what that one kept goes — never the
  /// draft of the conversation open now, which the box holds by then.
  const clearDraftOf = (v: string) => {
    if (draftToClear(v, draftView.current) === 'box') { setDraft(''); return }
    try { localStorage.removeItem(draftKey(v)) } catch { /* nothing kept */ }
    setDrafts((prev) => withoutDraft(prev, v))
  }

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
  // One of the lists that is not a conversation is on screen.
  const special = activityOpen || laterOpen || threadsOpen || sentOpen
  // Which conversation is on screen, for the sound a new message makes.
  const openView = !special ? (current?.view || null) : null
  useEffect(() => { setOpenView(openView); return () => { setOpenView(null) } }, [openView])
  const [laterItems, setLaterItems] = useState<Array<{ id: string; remindAt: string | null; remindedAt: string | null; message: ChannelMessage }> | null>(null)
  // Marked done here: kept out of the list even when a load that began
  // before the Done lands after it.
  const laterDone = useRef<Set<string>>(new Set())
  const loadLater = useCallback(() => {
    return fetch(`${api.httpBase}/channels/later?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setLaterItems(((d.items || []) as Array<{ id: string; remindAt: string | null; remindedAt: string | null; message: ChannelMessage }>).filter((x) => !laterDone.current.has(x.id))) })
      .catch(() => {})
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
    laterDone.current.add(id)
    setLaterItems((prev) => (prev || []).filter((x) => x.id !== id))
    const res = await fetch(`${api.httpBase}/channels/later`, { method: 'DELETE', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, id }) }).catch(() => null)
    // It did not go: back in the list, and said so.
    if (!res?.ok) { laterDone.current.delete(id); setProblem(t('That did not save.')); void loadLater() }
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
    setClip([]); clearDraftOf(channel)
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
  /// Why a message did not go, in the reader's language where it is ours to say.
  const refusal = (data: { code?: string; rules?: string[]; files?: string[]; message?: string }) => (data.code === 'dlp-blocked'
    ? t("This can't be sent here: it looks like it contains {what}. Take it out and try again.", { what: (data.rules || []).map((r) => t(r)).join(', ') + (data.files?.length ? ` (${data.files.join(', ')})` : '') })
    : data.message || t('That did not send. Try again.'))
  const sendAtTime = async (channel: string, at: string, text?: string) => {
    const body = (text ?? draft).trim()
    if (!body) return
    // Said, not dropped: a scheduled message would go without its quote.
    if (replyingTo?.view === channel) { setProblem(t('A scheduled message cannot be a reply yet.')); return }
    const res = await fetch(`${api.httpBase}/channels/messages`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, body, sendAt: at }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    if (!res?.ok) { setProblem(refusal(data)); return }
    clearDraftOf(channel)
    setScheduled((prev) => [...prev, data.scheduled].sort((a, b) => a.sendAt.localeCompare(b.sendAt)))
    note(channel, t('Scheduled for {when}.', { when: new Date(data.scheduled.sendAt).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }))
  }

  // ---- What you can do to a message ----
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [toolsOpen, setToolsOpen] = useState<string | null>(null)
  // Which copy of a message the picker under it is open on: a thread's
  // first message is drawn in the channel and in the thread, and the one
  // whose + was pressed is the one that opens it, not both at once.
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const pickerKey = (m: ChannelMessage, inThread: boolean) => `${inThread ? 'thread:' : ''}${m.id}`
  // `loading` while its replies are being read (the count the conversation
  // showed stands meanwhile, never a "0 replies"); `failed` when they could
  // not be (#216).
  const [thread, setThread] = useState<{ channel: string; parent: ChannelMessage; replies: ChannelMessage[]; loading?: boolean; failed?: boolean } | null>(null)
  // The thread as it stands — replies sent, edited, arrived live — kept for
  // the next time it is opened.
  useEffect(() => {
    if (thread) views.set(`thread:${thread.channel}:${thread.parent.id}`, thread.replies.filter((r) => !isTemp(r)), { read: false })
  }, [thread, views])

  // Messages in another language, in yours: translated once on the server
  // and kept; the words they were translated from, so an edit asks again.
  // "Show original" per message. Off when the person turned it off.
  const readerLang = locale.slice(0, 2).toLowerCase()
  const [translations, setTranslations] = useState<Record<string, { from: string; text: string }>>({})
  const [originals, setOriginals] = useState<Set<string>>(new Set())
  const [translateOff, setTranslateOff] = useState(false)
  const asking = useRef<Set<string>>(new Set())
  // Asked for and not back yet — "Translating…" under the message — and
  // asked for and not had: "Couldn't translate · Try again". Each by the
  // words asked about, so an edit starts over.
  const [translating, setTranslating] = useState<Record<string, string>>({})
  const [untranslated, setUntranslated] = useState<Record<string, string>>({})
  // Anything not in the language you set is translated into it — "latn"
  // (Latin letters too few to name the language) included.
  const needsTranslation = (m: ChannelMessage) => !translateOff && !m.deleted && Boolean(m.lang) && m.lang !== readerLang
    && translations[m.id]?.from !== m.body && !asking.current.has(`${m.id}:${m.body}`)
  const translate = useCallback(async (channel: string, list: ChannelMessage[]) => {
    const want = list.filter(needsTranslation).slice(0, 60)
    if (!want.length) return
    for (const m of want) asking.current.add(`${m.id}:${m.body}`)
    const mark = (set: typeof setTranslating, on: boolean) => set((prev) => {
      const next = { ...prev }
      for (const m of want) { if (on) next[m.id] = m.body; else delete next[m.id] }
      return next
    })
    mark(setTranslating, true)
    mark(setUntranslated, false)
    const res = await fetch(`${api.httpBase}/channels/translate`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, ids: want.map((m) => m.id), locale: readerLang }),
    }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    mark(setTranslating, false)
    // Not reached, or the answer unreadable: said so, with a way to ask
    // again. An answer that leaves a message out (no translator here,
    // nothing to change) is no failure — the message just stays as it is.
    if (!data) {
      for (const m of want) asking.current.delete(`${m.id}:${m.body}`)
      mark(setUntranslated, true)
      return
    }
    if (data?.off) { setTranslateOff(true); return }
    if (data?.translations) {
      setTranslations((prev) => {
        const next = { ...prev }
        for (const m of want) if (data.translations[m.id]) next[m.id] = { from: m.body, text: data.translations[m.id] }
        return next
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.httpBase, api.orgId, authHeaders, translations, translateOff, readerLang])
  // Whatever is on screen: the open conversation, and the thread beside it.
  useEffect(() => {
    if (!view) return
    const id = setTimeout(() => { void translate(view, messages[view] || []) }, 250)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, messages[view || ''], translateOff])
  useEffect(() => {
    if (!thread) return
    const id = setTimeout(() => { void translate(thread.channel, [thread.parent, ...thread.replies]) }, 250)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, translateOff])
  // Activity and Threads, when they are open: their messages too, by
  // the conversation each is in.
  useEffect(() => {
    const byChannel = new Map<string, ChannelMessage[]>()
    const add = (m: ChannelMessage) => { if (!m.mine) byChannel.set(m.channel, [...(byChannel.get(m.channel) || []), m]) }
    if (activityOpen) for (const i of activityItems || []) add(i.message)
    if (threadsOpen) for (const x of threadItems || []) { add(x.parent); for (const r of x.replies) add(r) }
    if (laterOpen) for (const x of laterItems || []) add(x.message)
    if (!byChannel.size) return
    const id = setTimeout(() => { for (const [channel, list] of byChannel) void translate(channel, list) }, 300)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityOpen, threadsOpen, laterOpen, activityItems, threadItems, laterItems, translateOff])
  // A preview that arrived live, in another language: translated too.
  useEffect(() => {
    const id = setTimeout(() => {
      for (const a of Object.values(activity)) if (a.last && !a.last.mine) void translate(a.channel, [a.last])
    }, 400)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, translateOff])
  /// What to show for a message: its translation, unless asked for the original.
  const shownBody = (m: ChannelMessage) => {
    const tr = translations[m.id]
    // A "translation" that is the message itself was yours already.
    return tr && tr.from === m.body && tr.text.trim() !== m.body.trim() && !originals.has(m.id) ? { text: tr.text, translated: true } : { text: m.body, translated: false }
  }
  const translationNote = (m: ChannelMessage) => {
    if (translateOff || m.deleted) return null
    if (translating[m.id] === m.body) {
      return <span className="slk-translating" role="status">{t('Translating…')}</span>
    }
    if (untranslated[m.id] === m.body) {
      return (
        <button type="button" className="slk-translated slk-translate-failed"
          onClick={() => void translate(m.channel, [m])}>
          {t("Couldn't translate · Try again")}
        </button>
      )
    }
    const tr = translations[m.id]
    if (!tr || tr.from !== m.body || tr.text.trim() === m.body.trim()) return null
    const showing = !originals.has(m.id)
    return (
      <button type="button" className="slk-translated" data-translated={showing ? '1' : '0'}
        onClick={() => setOriginals((prev) => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n })}>
        {showing ? t('Translated · Show original') : t('Show translation')}
      </button>
    )
  }
  /// The thread open beside the conversation, whose agents write there.
  const threadOpenParent = thread?.parent.id || null
  const [threadDraft, setThreadDraft] = useState('')
  /// "Also send to #channel" under the thread's box: for the next reply only.
  const [threadAlso, setThreadAlso] = useState(false)
  /// A thread reply sent to the conversation too, put there as well — or,
  /// unsent, taken from there — when the conversation is loaded.
  const inConversationToo = (channel: string, msg: ChannelMessage) => {
    setMessages((prev) => {
      const list = prev[channel]
      if (!list) return prev
      if (msg.deleted) return list.some((x) => x.id === msg.id) ? { ...prev, [channel]: list.filter((x) => x.id !== msg.id) } : prev
      return { ...prev, [channel]: arrive(list, msg) }
    })
  }
  const threadComposer = useRef<HTMLTextAreaElement>(null)
  // A reply being written in a thread is kept too, per thread: it used to
  // start empty every time the thread was opened, so a half-written reply
  // was gone the moment you looked at something else.
  const threadDraftKey = (parentId: string) => draftKey(`thread:${parentId}`)
  const threadDraftOf = useRef<string | null>(null)
  const threadParentId = thread?.parent.id || null
  useLayoutEffect(() => {
    if (threadDraftOf.current === threadParentId) return
    threadDraftOf.current = threadParentId
    let kept = ''
    try { kept = threadParentId ? localStorage.getItem(threadDraftKey(threadParentId)) || '' : '' } catch { /* none kept */ }
    setThreadDraft(kept)
    setThreadAlso(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadParentId])
  useEffect(() => {
    const id = threadDraftOf.current
    if (!id || id !== threadParentId) return
    try { if (threadDraft) localStorage.setItem(threadDraftKey(id), threadDraft); else localStorage.removeItem(threadDraftKey(id)) } catch { /* not kept */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadDraft])
  // A thread's box grows with what is written, as the channel's does: it stayed one line tall and scrolled from the
  // second line on.
  useEffect(() => {
    const el = threadComposer.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [threadDraft, thread?.channel, thread?.parent?.id])

  // ---- Who is typing ----
  // Others typing where this person can read, heard from the relay: ended
  // by a stop, by their message arriving there, or by silence.
  const [typists, setTypists] = useState<Typist[]>([])
  // The thread on screen as last drawn, for telling a reply in it from news
  // about one already there.
  const threadNow = useRef(thread)
  threadNow.current = thread
  useEffect(() => {
    const on = (e: Event) => setTypists((prev) => heardTyping(prev, (e as CustomEvent<TypingEvent>).detail, Date.now()))
    const arrived = (e: Event) => {
      const m = (e as CustomEvent<ChannelMessage>).detail
      // Something new said, not an old message edited, reacted to, pinned
      // or replied under.
      if (!m?.channel || m.kind !== 'message' || m.editedAt || m.deleted) return
      const open = threadNow.current
      const known = m.parentId ? (open?.parent.id === m.parentId ? open.replies : undefined) : messagesRef.current[m.channel]
      setTypists((prev) => said(prev, m, known))
    }
    window.addEventListener('honmaru:typing', on)
    window.addEventListener('honmaru:channel-message', arrived)
    return () => { window.removeEventListener('honmaru:typing', on); window.removeEventListener('honmaru:channel-message', arrived) }
  }, [])
  useEffect(() => {
    const at = nextTypingExpiry(typists)
    if (at === null) return
    const id = setTimeout(() => setTypists((prev) => expire(prev, Date.now())), Math.max(0, at - Date.now()) + 50)
    return () => clearTimeout(id)
  }, [typists])
  /// Who is typing in one place, first to start first, never yourself.
  const typingHere = (channel: string, parentId: string | null) =>
    typistsIn(typists, { channel, parentId }, Date.now(), members.find((m) => m.mine)?.ref).map((x) => x.name)
  // This person's own typing, as the relay has been told it.
  const typingOut = useRef<TypingOut | null>(null)
  const tellTyping = useCallback((step: { next: TypingOut | null; send: Signal[] }) => {
    typingOut.current = step.next
    for (const s of step.send) sendTyping(s)
  }, [])
  const typed = (place: Place, text: string) => tellTyping(typedIn(typingOut.current, place, text, Date.now()))
  const stoppedTyping = useCallback((place?: Place) => tellTyping(stoppedIn(typingOut.current, place)), [tellTyping])
  // Leaving a conversation or a thread is done typing there.
  useEffect(() => () => stoppedTyping(), [view, thread?.channel, thread?.parent?.id, stoppedTyping])
  const [pins, setPins] = useState<ChannelMessage[] | null>(null)
  // The pinned list, in your language too.
  useEffect(() => {
    if (!pins?.length) return
    const byChannel = new Map<string, ChannelMessage[]>()
    for (const m of pins) if (!m.mine) byChannel.set(m.channel, [...(byChannel.get(m.channel) || []), m])
    for (const [channel, list] of byChannel) void translate(channel, list)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, translateOff])
  const [flash, setFlash] = useState<string | null>(null)
  // On a phone: a long press on a message brings up what you can do to it.
  const [sheet, setSheet] = useState<{ channel: string; m: ChannelMessage; inThread: boolean } | null>(null)
  // On a laptop: a right-click on a message, or the menu key on one with
  // the focus, opens the same things where the pointer is, with the quick
  // reactions along the top. `anchor` is the message's element, kept lit.
  const [msgMenu, setMsgMenu] = useState<{ channel: string; m: ChannelMessage; inThread: boolean; x: number; y: number; anchor: string } | null>(null)
  const closeMsgMenu = useCallback(() => setMsgMenu(null), [])
  // The whole emoji picker, from the smile along the top of that menu:
  // where the menu was, rather than under the message, which may be far
  // down the page or drawn twice (a thread's first message).
  const [reactAt, setReactAt] = useState<{ channel: string; m: ChannelMessage; x: number; y: number; anchor: string } | null>(null)
  const closeReactAt = useCallback(() => setReactAt(null), [])
  const [forwarding, setForwarding] = useState<{ channel: string; m: ChannelMessage } | null>(null)
  /// "Mark unread from here": the conversation (or the thread) is read only
  /// up to just before this message, on every device.
  const markUnread = async (channel: string, m: ChannelMessage) => {
    const res = await fetch(`${api.httpBase}/channels/unread`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, messageId: m.id }),
    }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) as { lastReadAt: string; thread: string | null } | null : null
    if (!data) { setProblem(t('That did not save.')); return }
    if (data.thread) { void loadThreads(); setToast(t('Marked unread')); return }
    heldUnread.current = channel
    try { localStorage.setItem(seenKey(api.orgId, channel), data.lastReadAt) } catch { /* the server remembers */ }
    setServerReads((prev) => ({ ...prev, [channel]: data.lastReadAt }))
    setSeenTick((n) => n + 1)
    setToast(t('Marked unread'))
    // On a phone, back to the list, where it now shows as unread.
    if (!wide) choose(null)
  }
  /// Forward into another conversation. From a closed one only a link goes.
  const isClosed = (view: string) => view.startsWith('dm:') || view.startsWith('g:') || view.startsWith('ag:') || Boolean(everything.find((x) => x.view === view)?.private)
  const forwardTo = async (from: string, m: ChannelMessage, to: string, comment: string) => {
    const link = `${location.origin}${location.pathname}${hashForMessage(m.id, api.orgId)}`
    const src = everything.find((x) => x.view === from)
    const who = m.kind === 'ai' ? t('Your AI') : (m.authorName || t('a teammate'))
    const quoted = m.body ? m.body.slice(0, 600).split('\n').map((l) => `> ${l}`).join('\n') : '> 📎'
    const body = isClosed(from)
      ? [comment, link].filter(Boolean).join('\n')
      : [comment, quoted, `— ${who}${src?.kind === 'channel' ? `, #${src.name}` : ''}`, link].filter(Boolean).join('\n')
    const res = await fetch(`${api.httpBase}/channels/messages`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: to, body }),
    }).catch(() => null)
    if (!res?.ok) { setProblem(t('That did not send. Try again.')); return false }
    const dest = everything.find((x) => x.view === to)
    setToast(t('Forwarded to {name}', { name: dest ? (dest.kind === 'channel' ? `#${dest.name}` : dest.name) : '' }))
    void loadMessages(to)
    return true
  }
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  /// Where you are now, for a send that answers after you may have moved on.
  const shownNow = useRef({ view: openView, thread: threadOpenParent })
  shownNow.current = { view: openView, thread: threadOpenParent }
  /// What is in the boxes now — words, and files going with them — for an
  /// answer that comes after more may have been written.
  const boxes = useRef({ draft, thread: threadDraft, files: uploads.items.length, threadFiles: threadUploads.items.length })
  boxes.current = { draft, thread: threadDraft, files: uploads.items.length, threadFiles: threadUploads.items.length }
  const nameOfRef = (ref: string) => (ref === myRef ? t('You') : members.find((m) => m.ref === ref)?.name || t('a teammate'))

  /// Put a changed message wherever it shows: the log, the thread, the pins.
  const replaceMessage = (channel: string, msg: ChannelMessage) => {
    if (msg.parentId) {
      setThread((prev) => (prev && prev.parent.id === msg.parentId
        ? { ...prev, replies: msg.deleted ? prev.replies.filter((x) => x.id !== msg.id) : prev.replies.map((x) => (x.id === msg.id ? msg : x)) }
        : prev))
      if (msg.alsoChannel) inConversationToo(channel, msg)
      return
    }
    setMessages((prev) => {
      const list = prev[channel] || []
      if (msg.deleted && !msg.replyCount) return { ...prev, [channel]: refreshQuotes(list.filter((x) => x.id !== msg.id), msg) }
      return { ...prev, [channel]: refreshQuotes(list.map((x) => (x.id === msg.id ? msg : x)), msg) }
    })
    setReplyingTo((prev) => (prev?.quote.id === msg.id ? { ...prev, quote: quoteOf(msg) } : prev))
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
  const react = (channel: string, m: ChannelMessage, emoji: string) => {
    // Adding one (not taking yours back) makes it a recent one.
    if (!m.reactions?.some((r) => r.emoji === emoji && r.mine)) rememberEmoji(emoji)
    void act('POST', '/channels/reactions', channel, { messageId: m.id, emoji })
  }
  const saveEdit = async (channel: string) => {
    if (!editing) return
    const text = editing.text.trim()
    if (!text) return
    // Begun while it was on its way: saved to the server's copy once it has
    // landed — not at all if it did not go.
    const id = isTemp(editing) ? await landedId(editing.id) : editing.id
    if (!id) { setProblem(t('That did not save.')); return }
    const done = await act('PUT', '/channels/messages', channel, { messageId: id, body: text })
    if (done) setEditing(null)
  }
  /// The message an edit is open on. Begun on one of yours still on its way,
  /// it stays open on the server's copy that took its place.
  const editingThis = (m: ChannelMessage) => Boolean(editing && (editing.id === m.id || editing.id === drawnAs.current.get(m.id)))
  /// Delete a message, after asking in the app — not the browser's own box,
  /// unstyled and in the browser's language. ⇧ skips the question, as in
  /// Discord; somebody else's words in the thread go only when you say so
  /// outright, so that one is always asked. `others`: the server found
  /// replies from others that this page did not know of.
  const [deleting, setDeleting] = useState<null | { channel: string; m: ChannelMessage; others?: boolean; busy?: boolean; error?: string | null }>(null)
  /// The question was answered and the server is deleting: it can no longer
  /// be taken back. A ref, for Esc — the dialog keeps the onClose it opened
  /// with — and for a second click before the button is drawn disabled.
  const deleteBusy = useRef(false)
  const deleteCancel = useRef<HTMLButtonElement>(null)
  /// Messages the server is deleting right now. A second press of the key
  /// before it answers is not a second delete: the server would say "No
  /// such message" of one that went as asked, and focus would be let go.
  const unsending = useRef(new Set<string>())
  const remove = (channel: string, m: ChannelMessage, skipConfirm = false) => {
    // Picked by a key before the server answered the send: deleted once it
    // has landed, under the id the server gave it — or, never landed, given up.
    if (isTemp(m)) {
      void landedId(m.id).then((id) => { if (id) remove(channel, { ...m, id }, skipConfirm); else discard(m) })
      return
    }
    if (unsending.current.has(m.id)) return
    if (!skipsDeleteConfirm(skipConfirm, m, myRef)) { setDeleting({ channel, m }); return }
    // Nobody was asked, so nobody said others' replies may go: the server
    // is asked without them, and when it finds some the question is asked
    // after all — with the warning that names them.
    void unsend(channel, m, false).then((r) => {
      // (Never over a question already open about another message.)
      if (r.others) { setDeleting((cur) => cur ?? { channel, m, others: true }); return }
      if (r.gone) return
      // Still here: focus stays on it rather than waiting for it to go.
      dropKeyReturn('delete')
      if (r.error) setProblem(r.error)
    })
  }
  /// Ask the server to delete it. `withThread` lets other people's replies
  /// go with it, and is only said once the question that names them was
  /// answered: without it the server refuses (`others`) rather than take
  /// them. It is the server that knows who replied — replyRefs leaves out
  /// anyone who has since left, and is behind when a live event was missed.
  const unsend = async (channel: string, m: ChannelMessage, withThread: boolean): Promise<{ gone: boolean; others?: boolean; error?: string }> => {
    if (unsending.current.has(m.id)) return { gone: false }
    unsending.current.add(m.id)
    setProblem(null)
    let res: Response | null = null
    let data: { message?: unknown; code?: string } = {}
    try {
      res = await fetch(`${api.httpBase}/channels/messages`, {
        method: 'DELETE',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel, messageId: m.id, withThread }),
      })
      data = await res.json().catch(() => ({}))
    } catch {
      res = null
    }
    unsending.current.delete(m.id)
    if (res?.status === 409 && data.code === 'thread_has_replies') return { gone: false, others: true }
    setEditing((cur) => (cur?.id === m.id ? null : cur))
    if (!res?.ok) return { gone: false, error: (typeof data.message === 'string' && data.message) || t('That did not work. Try again.') }
    if (data.message && typeof data.message === 'object') replaceMessage(channel, data.message as ChannelMessage)
    // Gone here at once, and its thread with it.
    if (m.alsoChannel) setMessages((prev) => (prev[channel] ? { ...prev, [channel]: prev[channel].filter((x) => x.id !== m.id) } : prev))
    if (!m.parentId) {
      setMessages((prev) => (prev[channel] ? { ...prev, [channel]: prev[channel].filter((x) => x.id !== m.id) } : prev))
      setThread((prev) => (prev && prev.parent.id === m.id ? null : prev))
    }
    return { gone: true }
  }
  const confirmDelete = async () => {
    if (!deleting || deleteBusy.current) return
    const { channel, m } = deleting
    deleteBusy.current = true
    setDeleting({ ...deleting, busy: true, error: null })
    // Their replies go only when the question on show named them.
    const r = await unsend(channel, m, Boolean(deleting.others) || othersReplied(m, myRef))
    deleteBusy.current = false
    // Only the question that was answered is closed, or told what went
    // wrong — it stays open to say so, and to be answered again. Others
    // replied and it had not said so: nothing went, and now it does.
    setDeleting((cur) => {
      if (cur?.m.id !== m.id) return cur
      if (r.gone) return null
      if (r.others) return { ...cur, busy: false, others: true, error: t('Others replied in this thread, so nothing was deleted. Delete again to delete their replies too.') }
      return { ...cur, busy: false, error: r.error || t('That did not work. Try again.') }
    })
    // The buttons are live again, and focus left them when they were not:
    // back to Cancel, where it was when the question opened.
    if (!r.gone) requestAnimationFrame(() => deleteCancel.current?.focus())
  }
  /// Not while it is being deleted: the question would look withdrawn, and
  /// the message would go all the same.
  const cancelDelete = () => {
    if (deleteBusy.current) return
    dropKeyReturn('delete')
    setDeleting(null)
  }

  /// A message a key acted on (see logKeys): focus goes back to it when the
  /// edit box or the picker the key opened closes, and to the one beside it
  /// once it is deleted — never taken from wherever you went meanwhile.
  const keyReturn = useRef<{ kind: 'edit' | 'react' | 'delete'; row: HTMLElement; near: HTMLElement | null } | null>(null)
  const dropKeyReturn = (kind: 'edit' | 'react' | 'delete') => { if (keyReturn.current?.kind === kind) keyReturn.current = null }
  /// The message the arrow keys last picked: the one whose letters work.
  const keyPicked = useRef<HTMLElement | null>(null)
  // After every render: what closes it, or takes the message away, is any
  // of several states (the edit, the picker, the list, the thread).
  useEffect(() => {
    const r = keyReturn.current
    if (!r || deleting) return
    const active = document.activeElement
    const lost = !active || active === document.body || r.row.contains(active)
    if (r.row.isConnected) {
      if (r.kind === 'delete' || (r.kind === 'edit' ? editing : pickerFor)) return
      keyReturn.current = null
      if (lost) r.row.focus({ preventScroll: true })
      return
    }
    keyReturn.current = null
    if (lost && r.near?.isConnected) {
      keyPicked.current = r.near
      r.near.focus({ preventScroll: true })
      r.near.scrollIntoView({ block: 'nearest' })
    }
  })
  const togglePin = (channel: string, m: ChannelMessage) => void act('POST', '/channels/pins', channel, { messageId: m.id, pinned: !m.pinned })
  const openThread = async (channel: string, m: ChannelMessage): Promise<void> => {
    // A reply shown in the conversation opens the thread it is in.
    if (m.parentId) {
      const head = (messagesRef.current[channel] || []).find((x) => x.id === m.parentId)
      return openThread(channel, head || { id: m.parentId, channel, kind: m.threadParent?.kind || 'message', body: m.threadParent?.excerpt || '', authorName: m.threadParent?.authorName || null, authorRef: m.threadParent?.authorRef || null, createdAt: m.createdAt } as ChannelMessage)
    }
    setDetailId(null)
    setProfile(null)
    // The replies read last time, at once; the server's, when they come.
    const kept = views.get<ChannelMessage[]>(`thread:${channel}:${m.id}`) || []
    setThread((prev) => ({ channel, parent: m, replies: prev && prev.parent.id === m.id ? keepTemps(kept, prev.replies) : kept, loading: true }))
    const res = await fetch(`${api.httpBase}/channels/thread?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&messageId=${encodeURIComponent(m.id)}`, { headers: authHeaders }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (!data) setThread((prev) => (prev && prev.parent.id === m.id ? { ...prev, loading: false, failed: true } : prev))
    // Replies of yours still on their way, or that did not go — sent while
    // it was open before, or before this page loaded — back in it.
    const back = data ? heldFor(channel, m.id, data.replies || []) : []
    if (data) setThread((prev) => (prev && prev.parent.id === m.id ? { channel, parent: data.parent, replies: withHeld(keepTemps(data.replies || [], prev.replies), back) } : prev))
    requestAnimationFrame(() => threadComposer.current?.focus())
    markThreadRead(channel, m.id)
  }
  /// A thread shown in Activity: loaded whole, read, and the message you
  /// picked picked out in it.
  const threadInActivity = useRef(false)
  // Leaving Activity leaves its thread behind: it is not the one a
  // conversation opened.
  useEffect(() => {
    if (!activityOpen && threadInActivity.current) { threadInActivity.current = false; setThread(null) }
  }, [activityOpen])
  const showThreadIn = async (channel: string, parentId: string, focusId: string) => {
    const res = await fetch(`${api.httpBase}/channels/thread?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&messageId=${encodeURIComponent(parentId)}`, { headers: authHeaders }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (!data?.parent) { setThread(null); return }
    threadInActivity.current = true
    const back = heldFor(channel, parentId, data.replies || [])
    setThread((prev) => ({ channel, parent: data.parent, replies: withHeld(keepTemps(data.replies || [], prev && prev.parent.id === parentId ? prev.replies : undefined), back) }))
    markThreadRead(channel, parentId)
    requestAnimationFrame(() => {
      const id = focusId === parentId ? `thread-${focusId}` : focusId
      const el = document.querySelector(`.slk-inbox-thread #${CSS.escape(`msg-${id}`)}`)
      if (el) { el.scrollIntoView({ block: 'center' }); setFlash(id); setTimeout(() => setFlash(null), 1600) }
    })
  }
  /// Read this thread, here and on every other device: Threads stops
  /// calling it unread.
  const markThreadRead = (channel: string, parentId: string) => {
    // Read up to the newest reply on screen, not the server's now: one that
    // lands while this is on its way stays new.
    const seenUpTo = threadItems?.find((x) => x.parent.id === parentId)?.lastReplyAt || new Date().toISOString()
    setThreadItems((prev) => prev && prev.map((x) => (x.parent.id === parentId ? { ...x, unread: false } : x)))
    // Its replies, and its first message where it named you, in Activity too.
    setActivityItems((prev) => prev && prev.map((i) => (i.unread && (i.message.parentId === parentId || (i.message.id === parentId && i.type !== 'reaction')) ? { ...i, unread: false } : i)))
    void fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel, thread: parentId, at: seenUpTo }),
    }).catch(() => {})
  }
  // Read on another device (or another tab): the same here, at once —
  // the conversation, the thread, the Activity items — and this browser's
  // notifications for it come down.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ items?: string[]; threads?: Array<{ thread: string; lastReadAt: string }>; view?: string; thread?: string | null; lastReadAt?: string; unread?: boolean }>).detail || {}
      if (Array.isArray(d.items)) {
        const keys = new Set(d.items)
        setActivityItems((prev) => prev && prev.map((i) => (i.unread && keys.has(activityKey(i)) ? { ...i, unread: false } : i)))
        if (Array.isArray(d.threads)) threadsReadTo(d.threads)
        closeMessageNotifications(messageIdsOf(d.items))
        return
      }
      const v = d.view
      const at = d.lastReadAt
      if (!v || !at) return
      if (d.thread) {
        const parentId = d.thread
        if (d.unread) { void loadThreads(); return }
        setThreadItems((prev) => prev && prev.map((x) => (x.parent.id === parentId ? { ...x, unread: false } : x)))
        setActivityItems((prev) => prev && prev.map((i) => (i.unread && i.message.parentId === parentId && (i.at || i.message.createdAt) <= at ? { ...i, unread: false } : i)))
        return
      }
      if (d.unread) {
        try { localStorage.setItem(seenKey(api.orgId, v), at) } catch { /* the server remembers */ }
        setServerReads((prev) => ({ ...prev, [v]: at }))
        setSeenTick((n) => n + 1)
        return
      }
      setServerReads((prev) => ({ ...prev, [v]: [prev[v] || '', at].sort().pop() || at }))
      setActivityItems((prev) => prev && prev.map((i) => (i.unread && i.message.channel === v && !i.message.parentId && (i.at || i.message.createdAt) <= at ? { ...i, unread: false } : i)))
      closeNotifications(api.orgId, v)
    }
    window.addEventListener('honmaru:reads-changed', on)
    return () => window.removeEventListener('honmaru:reads-changed', on)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.orgId])
  // Back from a dropped connection or a sleep (Dashboard says so): what was
  // said meanwhile never came over the socket. The sidebar, the open
  // conversation's newest page — merged, so older pages stay — the open
  // thread, Activity and Threads are read again. Waking can bring both
  // signals at once; a moment's wait makes them one.
  const resyncNow = useRef<() => void>(() => {})
  resyncNow.current = () => {
    messageCache.invalidate()
    setChannelsTick((n) => n + 1)
    if (view) void loadMessages(view)
    if (thread) {
      const { channel, parent } = thread
      fetch(`${api.httpBase}/channels/thread?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&messageId=${encodeURIComponent(parent.id)}`, { headers: authHeaders })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { if (data?.parent) setThread((prev) => (prev && prev.parent.id === parent.id ? { ...prev, parent: data.parent, replies: data.replies || [] } : prev)) })
        .catch(() => { /* the thread stays as it was */ })
    }
    if (activityItems) void loadActivity()
    if (threadItems) void loadThreads()
  }
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const on = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => resyncNow.current(), 300)
    }
    window.addEventListener('honmaru:resync', on)
    return () => {
      window.removeEventListener('honmaru:resync', on)
      if (timer) clearTimeout(timer)
    }
  }, [])
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
  useEffect(() => { setEditing(null); setThread(null); setPins(null); setPickerFor(null); setReplyingTo(null); setMsgMenu(null); setReactAt(null); uploads.clear() }, [current?.key])
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
      // The reply itself, found in the thread once it has loaded.
      void openThread(j.view, parent).then(() => requestAnimationFrame(() => {
        const el = document.querySelector(`.slk-thread-pane #${CSS.escape(`msg-${j.id}`)}`)
        if (el) { el.scrollIntoView({ block: 'center' }); setFlash(j.id); setTimeout(() => setFlash(null), 1600) }
      }))
    } else {
      requestAnimationFrame(() => jumpTo(j.id))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.view, messages[current?.view || '']?.length, tick])
  // Somebody named you, answered in your thread, or replied to you: the
  // inbox refreshes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const on = (e: Event) => {
      const m = (e as CustomEvent<ChannelMessage>).detail
      const toMe = Boolean(m?.replyTo?.authorRef && m.replyTo.authorRef === membersRef.current.find((x) => x.mine)?.ref)
      if (!m || m.mine || (!m.parentId && !toMe && !/[@＠]/.test(m.body || ''))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void loadActivity(); if (m.parentId) void loadThreads() }, 800)
    }
    window.addEventListener('honmaru:channel-message', on)
    return () => { window.removeEventListener('honmaru:channel-message', on); if (timer) clearTimeout(timer) }
  }, [loadActivity, loadThreads])
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
  // "Join this Jam", from a link (the phone app's web view opens one): the
  // conversation, then the call. In the app, leaving says so, and the app
  // closes the view.
  useEffect(() => {
    const go = (view: string) => {
      const th = everything.find((x) => x.view === view)
      if (!th) { setToast(t('That conversation is not somewhere you can read.')); return }
      choose(th.key)
      void startJam(view, { mode: jams[view]?.mode || 'off' })
    }
    const on = (e: Event) => { try { sessionStorage.removeItem('list.jamView') } catch {}; go(String((e as CustomEvent).detail || '')) }
    window.addEventListener('honmaru:join-jam', on)
    try {
      const saved = sessionStorage.getItem('list.jamView')
      if (saved && everything.length) { sessionStorage.removeItem('list.jamView'); setTimeout(() => go(saved), 300) }
    } catch { /* nothing to join */ }
    return () => window.removeEventListener('honmaru:join-jam', on)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everything.length])
  // A conversation to open, from a link or another screen ("Message" on an
  // agent): one with an agent opens even before anything is said in it.
  useEffect(() => {
    const go = (view: string) => {
      if (view.startsWith('ag:')) { setPhoneTab('home'); openAgent(view.slice(3)); return }
      const th = everything.find((x) => x.view === view)
      if (th) choose(th.key)
      else wantedView.current = { view, until: Date.now() + 10_000 }
    }
    const on = (e: Event) => { try { sessionStorage.removeItem('list.openView') } catch {}; go(String((e as CustomEvent).detail || '')) }
    window.addEventListener('honmaru:open-view', on)
    try {
      const saved = sessionStorage.getItem('list.openView')
      if (saved && (saved.startsWith('ag:') || everything.length)) { sessionStorage.removeItem('list.openView'); go(saved) }
    } catch { /* nothing to open */ }
    return () => window.removeEventListener('honmaru:open-view', on)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everything.length])
  useEffect(() => {
    const want = wantedView.current
    if (!want) return
    if (Date.now() > want.until) { wantedView.current = null; return }
    const th = everything.find((x) => x.view === want.view)
    if (th) choose(th.key)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everything])
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
  const [side, setSide] = useState<null | { kind: 'journal' } | { kind: 'canvas' } | { kind: 'details'; tab: DetailsTab }>(null)
  const openSide = (next: { kind: 'journal' } | { kind: 'canvas' } | { kind: 'details'; tab: DetailsTab }) => {
    setDetailId(null); setThread(null); setProfile(null); setPins(null)
    setSide((prev) => (prev && prev.kind === next.kind && (prev.kind === 'journal' || prev.kind === 'canvas' || (next.kind === 'details' && prev.kind === 'details' && prev.tab === next.tab)) ? null : next))
  }
  // What to open beside a conversation chosen from somewhere else (the
  // sidebar's right-click menu): set before choosing, applied once it opens.
  const sideOnOpen = useRef<null | { kind: 'details'; tab: DetailsTab }>(null)
  useEffect(() => { setSide(sideOnOpen.current); sideOnOpen.current = null }, [current?.key])
  // A card stands beside something in the conversation that was left.
  useEffect(() => { setPopout(null) }, [current?.key])
  // Back closes what was opened last, not the list (utils/backStack): on a
  // phone the conversation itself, then whatever is open over it.
  useBackStack([
    [!wide && !!current, () => choose(null)],
    [activityOpen || laterOpen || threadsOpen || sentOpen, () => { setActivityOpen(false); setLaterOpen(false); setThreadsOpen(false); setSentOpen(false) }],
    [!!side, () => setSide(null)],
    [!!profile, () => setProfile(null)],
    [!!thread, () => setThread(null)],
    [!!detailId, () => setDetailId(null)],
    // A teammate's card stands over all of these.
    [!!popout, () => setPopout(null)],
  ])
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
  /// Whether the message was found.
  const goToCite = async (channel: string, cite: JournalCite): Promise<boolean> => {
    if (cite.parentId) {
      const list = messagesRef.current[channel] || []
      const parent = list.find((m) => m.id === cite.parentId) || ({ id: cite.parentId, channel, kind: 'message', body: '', authorName: null, authorRef: null, mine: false, cardId: null, createdAt: '' } as ChannelMessage)
      setSide(null)
      void openThread(channel, parent)
      return true
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
      older = hasOlder(data, PAGE)
    }
    // Pages loaded around what was held; what is only here is as it is now.
    const merged = list.filter((m) => !isTemp(m))
    setMessages((prev) => ({ ...prev, [channel]: keepTemps(merged, prev[channel]) }))
    setMore((prev) => ({ ...prev, [channel]: Boolean(older) }))
    setTimeout(() => jumpTo(cite.id), 80)
    return list.some((m) => m.id === cite.id)
  }
  /// An inline reply's quote, pressed: to the original where it is on
  /// screen, loading back to it when it is further up — and a word, not
  /// nothing, when it cannot be found.
  const goToQuoted = async (channel: string, id: string) => {
    if (document.getElementById(`msg-${id}`)) { jumpTo(id); return }
    if (!(await goToCite(channel, { id, parentId: null, at: '' }))) setToast(t('Could not find the original message.'))
  }

  // ---- Jam ----
  // Who is talking in which channel, and the call this tab is in.
  const [jams, setJams] = useState<Record<string, JamState>>({})
  const [call, setCall] = useState<JamCall | null>(null)
  // In the phone app's web view: tell the app when the call is over.
  const hadCall = useRef(false)
  useEffect(() => {
    if (call) { hadCall.current = true; return }
    if (!hadCall.current) return
    hadCall.current = false
    try { (window as unknown as { webkit?: { messageHandlers?: { honmaruJam?: { postMessage: (m: unknown) => void } } } }).webkit?.messageHandlers?.honmaruJam?.postMessage({ type: 'left' }) } catch { /* not in the app */ }
  }, [call])
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
  // Escape closes the pane — unless the shell has something over the list:
  // that Escape is for the screen or panel on top, not the pane under it.
  useEffect(() => {
    if (!active || (!detailId && !thread)) return
    const onKey = (e: KeyboardEvent) => {
      // An Escape a menu has already taken (a right-click menu over a
      // reply) closes that menu, not the thread under it as well.
      if (e.key === 'Escape' && !e.defaultPrevented && !composing(e) && !(e.target as HTMLElement)?.closest('textarea, input')) { setDetailId(null); setThread(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, detailId, thread])
  // A phone gives a conversation, or a decision, the whole screen.
  // A conversation, a card or a thread takes the whole phone; Activity and
  // Later are tabs, with the tab bar under them.
  useEffect(() => { onImmersive(!wide && (Boolean(current && !special) || Boolean(detail) || Boolean(thread))) }, [wide, current?.key, detail?.id, thread, special, onImmersive])
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
  // Who is online, by the hash of their login the member list carries.
  const onlineKeys = useMemo(() => {
    const on = new Set<string>()
    for (const [login, state] of Object.entries(presence)) if (state === 'online' && hashes.get(login)) on.add(hashes.get(login)!)
    return on
  }, [presence, hashes])
  // The same people by ref, for a channel's member list.
  const onlineRefs = useMemo(() => new Set(members.filter((m) => isOnline(m, onlineKeys)).map((m) => m.ref)), [members, onlineKeys])
  const withAI = useMemo(() => {
    const view = current?.view || ''
    // Who is in the conversation being written in: everyone, in a public
    // channel; its people, in a private one, a group or a DM.
    const privateKeys = current?.kind === 'channel' && current.private ? new Set(businesses.find((b) => b.slug === current.slug)?.memberKeys || []) : null
    const inside = (m: (typeof mentionable)[number]) => {
      if (m.mine) return true
      if (current?.kind === 'channel') return privateKeys ? Boolean(m.presence && privateKeys.has(m.presence)) : true
      if (view.startsWith('dm:')) return view === `dm:${m.ref}`
      if (current?.kind === 'group') return Boolean(current.refs?.includes(m.ref))
      return true
    }
    const people = mentionable.map((m) => ({ ...m, online: Boolean(m.presence && onlineKeys.has(m.presence)), outside: privateKeys && !privateKeys.size ? false : !inside(m) }))
    const here = agentMentionables(agentsIn(agents, view), mentionable)
    const everyone = people.filter((m) => !m.outside && !m.mine).length
    const onlineHere = people.filter((m) => !m.outside && !m.mine && m.online).length
    return [
      { ref: '__here', name: 'here', handle: 'here', special: 'here', detail: t('Notifies the {n} people online here', { n: onlineHere }) } as (typeof mentionable)[number],
      { ref: '__channel', name: 'channel', handle: 'channel', special: 'channel', detail: t('Notifies all {n} people in this conversation', { n: everyone }) } as (typeof mentionable)[number],
      { ref: '__all', name: 'all', handle: 'all', special: 'channel', detail: t('Notifies all {n} people in this conversation', { n: everyone }) } as (typeof mentionable)[number],
      ...(here.length ? [{ ref: '__agents', name: 'agents', handle: 'agents', special: 'agents', handles: here.map((a) => a.handle!), detail: t('Calls all {n} agents in this conversation', { n: here.length }) } as (typeof mentionable)[number]] : []),
      { ref: '__ai', name: 'AI' } as (typeof mentionable)[number],
      ...people,
      ...userGroups.map((g) => ({ ref: `group:${g.handle}`, name: g.name, handle: g.handle, title: t('{n} people', { n: g.refs.length }) }) as (typeof mentionable)[number]),
      ...here,
    ]
  }, [mentionable, userGroups, agents, current, businesses, onlineKeys, t])
  const mention = useMentionMenu(composer, draft, setDraft, withAI)
  const threadMention = useMentionMenu(threadComposer, threadDraft, setThreadDraft, withAI)
  // @names that reach somebody light up as they are typed. What sits over
  // the box — the "Replying to" bar, files waiting to go — moves it when it
  // comes or goes, and the colour moves with it.
  const draftHl = useMentionHighlight(composer, draft, withAI, `${replyingTo?.quote.id || ''}|${uploads.items.length}`)
  const threadHl = useMentionHighlight(threadComposer, threadDraft, withAI, threadUploads.items.length)
  // Whether a message calls you and whether an @name is yours, asked of
  // every message each time the conversation is drawn — every keystroke in
  // the composer — so each answer is kept until the team or its groups
  // change.
  const readsMe = useMemo(() => meReader({ people: mentionable, groups: userGroups }), [mentionable, userGroups])
  // A right-click's row of reactions: the ones you used last, as on the bar.
  const quickReactions = useQuickReactions()

  // The newest message in view when a conversation opens, as in any chat —
  // and kept in view while what is above it settles: the conversation drawn
  // again once it has loaded, pictures arriving, a translation taking the
  // place of the words, a link growing a preview. Scrolled to once, it was
  // pushed out of sight by all of that. Scrolling up yourself lets go; back
  // at the bottom, it holds again. Something new arriving follows the same
  // rule: up in the history, a teammate's message waits below; your own
  // takes you to it.
  const logRef = useRef<HTMLDivElement | null>(null)
  const [logEl, setLogEl] = useState<HTMLDivElement | null>(null)
  const logAt = useCallback((el: HTMLDivElement | null) => { logRef.current = el; setLogEl(el) }, [])
  const pinned = useRef(true)
  useEffect(() => { pinned.current = true; setReadingUp(null) }, [current?.key])
  // What the log was last drawn for: another log or another conversation is
  // one just opened, and a newest message later than the newest then just
  // arrived (not one left newest by a deletion).
  const followed = useRef<{ el: HTMLDivElement | null; key?: string; newestAt: string }>({ el: null, newestAt: '' })
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const list = messages[current?.view || ''] || []
    const newest = list[list.length - 1]
    const last = followed.current
    const opened = last.el !== el || last.key !== current?.key
    const newestIsMine = Boolean(newest?.mine && newest.createdAt > last.newestAt)
    followed.current = { el, key: current?.key, newestAt: newest?.createdAt || '' }
    const restoring = keepScroll.current !== null
    if (shouldFollow({ opened, atBottom: pinned.current, restoring, newestIsMine })) {
      keepScroll.current = null
      el.scrollTop = el.scrollHeight
      pinned.current = true
    } else if (restoring) {
      el.scrollTop = el.scrollHeight - keepScroll.current!
      keepScroll.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logEl, current?.key, current?.cards.length, messages[current?.view || '']?.length, thinking[current?.view || '']])
  useEffect(() => {
    const el = logEl
    if (!el) return
    const settle = () => { if (pinned.current && keepScroll.current === null) el.scrollTop = el.scrollHeight }
    const onScroll = () => { pinned.current = isAtBottom(el) }
    const changed = new MutationObserver(settle)
    changed.observe(el, { childList: true, subtree: true, characterData: true })
    const sized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(settle) : null
    sized?.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    // A picture's load does not bubble; caught on the way down.
    el.addEventListener('load', settle, true)
    return () => {
      changed.disconnect()
      sized?.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('load', settle, true)
    }
  }, [logEl])
  /// "Jump to present": down to the newest, which reads it on arriving.
  /// Smoothly, unless the reader asked for less motion. The focus goes on to
  /// the composer when focusAfterJump says, since the pill goes away under it.
  const goToPresent = (handOn: boolean) => {
    const el = logRef.current
    if (!el) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' })
    if (handOn) composer.current?.focus({ preventScroll: true })
  }
  // What waits below, told to a screen reader in the pill's own words: the
  // pill is out of sight of one, and its count changes silently. Politely,
  // and no more often than waitToSay allows.
  const newBelow = readingUp && readingUp.view === view ? countNewBelow(messages[view] || [], readingUp.since) : 0
  const [heard, setHeard] = useState(0)
  const heardAt = useRef(0)
  useEffect(() => {
    if (newBelow === 0) { setHeard(0); return }
    const id = setTimeout(() => { heardAt.current = Date.now(); setHeard(newBelow) }, waitToSay(heardAt.current, Date.now()))
    return () => clearTimeout(id)
  }, [newBelow])
  // ⇧PageDown goes to the present from anywhere the keys are not writing —
  // an empty composer included, where there is nothing for it to select.
  // (Esc already closes what is open, and ⇧Esc reads everything.)
  useEffect(() => {
    if (atBottom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'PageDown' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const field = (e.target as HTMLElement | null)?.closest?.('textarea, input, select, [contenteditable="true"]')
      if (field && !(field === composer.current && composer.current.value === '')) return
      e.preventDefault()
      goToPresent(Boolean(document.activeElement?.closest('.slk-present')))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atBottom])

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
  /// Who wrote a message, as its line says: your AI, one of the team's
  /// agents by its own name, you, or a teammate.
  const whoSaid = (m: ChannelMessage) => (m.kind === 'ai' ? t('Your AI')
    : m.kind === 'agent' ? (m.agent?.name || m.authorName || t('Agent'))
    : m.mine ? t('You') : (m.authorName || t('a teammate')))
  /// Who an inline reply answers, as this reader calls them: your AI, you
  /// by your own name (Discord's way), a teammate or an agent by theirs.
  const quoteName = (q: ReplyQuote) => (q.kind === 'ai' ? t('Your AI')
    : q.authorRef && q.authorRef === myRef ? (myName || t('You'))
    : (q.authorName || t('a teammate')))
  /// Reply, pressed: the bar over the composer, and the caret in the box.
  /// An edit open on another message stays open — its words live nowhere
  /// else, and answering one message is no reason to lose them.
  const startReply = (channel: string, m: ChannelMessage) => {
    setReplyingTo({ view: channel, quote: quoteOf(m) })
    requestAnimationFrame(() => composer.current?.focus())
  }
  /// The face beside a message: yours, or whoever wrote it.
  const faceOfMessage = (m: ChannelMessage): Face => (m.kind === 'agent'
    ? { name: whoSaid(m), emoji: m.agent?.emoji || '🤖', picture: m.agent?.avatarUrl || null }
    : m.mine
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
    : face?.emoji ? <AgentAvatar className="slk-avatar agent" agent={{ emoji: face.emoji, avatarUrl: face.picture }} />
    : <span className="slk-avatar face"><Avatar name={face?.name || '?'} url={face?.url} size={36} /></span>

  /// One block of a conversation: a gutter, a name and a time — or, joined
  /// to the one before, just the words — then what was said. Somebody
  /// else's face and name open their card, and their face says whether
  /// they are here. (Yours says nothing: the relay never tells you of you.)
  /// One that calls you (`mentionsMe`) is tinted and barred, to be found in
  /// a busy channel, and says so to a screen reader, which sees no tint.
  /// `quote`: the line an inline reply shows above its author, as a pin's
  /// mark sits there. `state`: yours, shown before the server has it — on
  /// its way, or failed.
  const block = (key: string, opts: { joined: boolean; at: string; app: string; name: string; face?: Face | null; badge?: string; to?: string; unread?: boolean; tools?: React.ReactNode; msgId?: string; pinned?: boolean; authorRef?: string | null; onHold?: () => void; onMenu?: (at: { x: number; y: number }, anchor: string) => void; mentionsMe?: boolean; quote?: React.ReactNode; state?: 'pending' | 'failed' }, body: React.ReactNode) => (
    <article key={key} id={opts.msgId ? `msg-${opts.msgId}` : undefined} tabIndex={opts.msgId ? -1 : undefined}
      {...(!wide ? longPress(opts.onHold) : messageMenuTriggers(opts.onMenu))}
      className={`slk-msg${opts.joined ? ' joined' : ''}${opts.unread ? ' unread' : ''}${opts.msgId && toolsOpen === opts.msgId ? ' tools-open' : ''}${opts.msgId && [msgMenu?.anchor, reactAt?.anchor].includes(`msg-${opts.msgId}`) ? ' menu-open' : ''}${opts.msgId && editing?.id === opts.msgId ? ' editing' : ''}${opts.pinned ? ' pinned' : ''}${opts.mentionsMe ? ' mentions-me' : ''}${opts.msgId && flash === opts.msgId ? ' flash' : ''}${opts.state ? ` ${opts.state}` : ''}`}>
      <div className="slk-gutter" aria-hidden={opts.joined || !opts.authorRef ? 'true' : undefined}>
        {opts.joined ? <span className="slk-hover-time" title={fullTime(opts.at, locale)}>{clock(opts.at)}</span>
          : opts.authorRef ? (
            <button type="button" className="slk-face-button" aria-label={t('Profile of {name}', { name: opts.name })} aria-haspopup="dialog"
              onClick={(e) => openPopout(opts.authorRef!, e.currentTarget, opts.name)}>
              {avatarFor(opts.app, opts.face || { name: opts.name })}
              <span className={`cl-presence${isOnline(memberByRef(opts.authorRef), onlineKeys) ? ' on' : ''}`} aria-hidden="true" />
            </button>
          )
          : avatarFor(opts.app, opts.face || { name: opts.name })}
      </div>
      <div className="slk-body">
        {opts.pinned && <div className="slk-pin-mark"><Icon name="pin" size={12} /> {t('Pinned')}</div>}
        {opts.quote}
        {!opts.joined && (
          <div className="slk-meta">
            {opts.authorRef
              ? <button type="button" className="slk-author link" aria-haspopup="dialog" onClick={(e) => openPopout(opts.authorRef!, e.currentTarget, opts.name)}>{opts.name}</button>
              : <span className="slk-author">{opts.name}</span>}
            {opts.badge && <span className={`slk-app-badge${opts.face?.emoji ? ' agent' : ''}`}>{opts.badge}</span>}
            {opts.to && <span className="slk-to">→ {opts.to}</span>}
            <time className="slk-time" dateTime={opts.at} title={fullTime(opts.at, locale)}>{clock(opts.at)}</time>
          </div>
        )}
        {opts.mentionsMe && <span className="sr-only slk-calls-me">{t('Mentions you')}</span>}
        {body}
      </div>
      {opts.tools && <div className="slk-tools">{opts.tools}</div>}
    </article>
  )

  /// Words as written, with Slack's formatting read back: lines kept,
  /// links clickable, @names marked.
  const agentHandles = new Set(agents.map((a) => a.handle.normalize('NFKC').toLowerCase()))
  // Only an @name that reaches somebody is drawn as a mention; one that
  // names nobody stays a word, so a typo reads as one.
  // A person's opens their card: the ref goes with it, for onMentionClick.
  const rich = (text: string) => renderRich(text, (part) => {
    const kind = mentionKind(part, withAI)
    if (!kind) return ''
    if (kind === 'ai') return 'slk-mention ai'
    if (kind === 'agent' || agentHandles.has(part.replace(/^[@＠]/, '').replace(/[にへ]$/, '').normalize('NFKC').toLowerCase())) return 'slk-mention agent'
    // Your own name, stronger than anyone else's.
    if (kind === 'person' && readsMe.namesMe(part)) return 'slk-mention me'
    // "@agents" and the like read as a person to mentionKind; only somebody
    // on the team has a card.
    const who = kind === 'person' ? memberByRef(mentionTarget(part, withAI)?.ref) : undefined
    if (who) return { className: 'slk-mention', ref: who.ref }
    return `slk-mention${kind === 'group' ? ' group' : ''}`
  })
  /// Whether a message calls you (utils/mentionsMe.ts): read from what was
  /// written, not a translation of it; an unsent one calls nobody.
  const callsMe = (m: ChannelMessage) => !m.deleted && readsMe.mentionsMe(m)

  /// One face beside "3 replies": the AI's mark, an agent's emoji, your own
  /// photo, or a teammate's.
  const replyFace = (r: string) => {
    if (r === 'ai') return <img key={r} className="slk-face slk-face-ai" src="/icon.svg" alt="" width={20} height={20} />
    if (r.startsWith('agent:')) {
      const a = agents.find((x) => `agent:${x.id}` === r)
      return <AgentAvatar key={r} className="slk-face slk-face-agent" agent={a} />
    }
    const mine = r === myRef
    return <Avatar key={r} className="slk-face" name={mine ? (myName || t('You')) : nameOfRef(r)} url={mine ? myAvatar : memberByRef(r)?.avatarUrl} size={20} />
  }

  /// What sits under a message's words: its reactions and its thread — or,
  /// one of yours the server does not have yet, that it is on its way or
  /// why it did not go (from the keyboard, back to the box it came from).
  const underneath = (channel: string, m: ChannelMessage, inThread = false) => (
    <>
      <UnsentNote message={m} onRetry={() => retry(m)} onDelete={() => discard(m)} onEdit={() => writeAgain(m)} lateAt={outbox.current.get(m.id)?.lateAt}
        refocus={() => (m.parentId ? threadComposer : composer).current?.focus()} />
      {!m.deleted && m.kind === 'message' && !m.previewsHidden && !isTemp(m) && (
        <LinkCards text={m.body} httpBase={api.httpBase} orgId={api.orgId} token={api.sessionToken}
          onHide={m.mine ? () => void act('POST', '/channels/previews', channel, { messageId: m.id, hidden: true }) : undefined} />
      )}
      {!m.deleted && (
        <Reactions message={m} nameOf={nameOfRef} onToggle={(e) => react(channel, m, e)} onAdd={() => setPickerFor(pickerKey(m, inThread))} />
      )}
      {pickerFor === pickerKey(m, inThread) && <div className="slk-picker-anchor"><EmojiPicker onPick={(e) => react(channel, m, e)} onClose={() => setPickerFor(null)} /></div>}
      {!inThread && (m.replyCount || 0) > 0 && (
        <button type="button" className="slk-thread-link" onClick={() => void openThread(channel, m)}>
          <span className="slk-thread-faces" aria-hidden="true">
            {(m.replyRefs || []).slice(0, 3).map((r) => replyFace(r))}
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
    if (editing && editingThis(m)) {
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
              if (e.key === 'Escape' && !composing(e)) { e.preventDefault(); setEditing(null) }
              if (enterKey(e) && !e.shiftKey) { e.preventDefault(); void saveEdit(channel) }
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
            {rich(shownBody(m).text)}
            {m.editedAt && <span className="slk-edited" title={new Date(m.editedAt).toLocaleString(locale)}> {t('(edited)')}</span>}
          </div>
        )}
        {translationNote(m)}
        <MessageFiles files={m.files} base={api.httpBase} />
      </>
    )
  }
  /// What this reader may do to one message, said once: the ⋯ menu over
  /// it, a phone's long press and a right-click all offer exactly this.
  const actionsFor = (channel: string, m: ChannelMessage, inThread: boolean): MessageMenuActions => ({
    inThread,
    onQuote: inThread ? undefined : () => startReply(channel, m),
    onReply: () => void openThread(channel, m),
    onPin: () => togglePin(channel, m),
    onEdit: m.mine && m.kind === 'message' ? () => setEditing({ id: m.id, text: m.body }) : undefined,
    onDelete: m.mine && m.kind === 'message' ? (skipConfirm?: boolean) => remove(channel, m, skipConfirm) : undefined,
    onDecide: !m.cardId && m.kind === 'message' && !inThread ? () => void decideMessage(channel, m) : undefined,
    onLater: (at) => void saveLater(channel, m, at),
    onClip: () => toggleClip(channel, m),
    clipped: clip.some((x) => x.id === m.id),
    onUnread: m.mine ? undefined : () => void markUnread(channel, m),
    onForward: m.kind === 'message' || m.kind === 'ai' ? () => setForwarding({ channel, m }) : undefined,
    onCopyLink: () => copyLink(m),
  })
  // Nothing to do to a message only held here: the server has no such id.
  const toolsFor = (channel: string, m: ChannelMessage, inThread = false) => (m.deleted || editingThis(m) || isTemp(m)) ? undefined : (
    <MessageActions
      message={m}
      {...actionsFor(channel, m, inThread)}
      onReact={(e) => react(channel, m, e)}
      onOpenChange={(open) => setToolsOpen((cur) => (open ? m.id : cur === m.id ? null : cur))}
    />
  )

  /// A long press, on a phone: the same things, in a sheet from the bottom.
  const holdFor = (channel: string, m: ChannelMessage, inThread = false) => (m.deleted || editingThis(m) || isTemp(m))
    ? undefined
    : () => setSheet({ channel, m, inThread })
  /// A right-click, on a laptop: the same things again, at the pointer.
  const menuFor = (channel: string, m: ChannelMessage, inThread = false) => (m.deleted || editing?.id === m.id || isTemp(m))
    ? undefined
    : (at: { x: number; y: number }, anchor: string) => setMsgMenu({ channel, m, inThread, ...at, anchor })
  /// Keys on a log, as in Discord. On the log itself ↑ picks its last
  /// message; on a message, ↑ ↓ move to the one beside it, E T P + ⌫ do
  /// what its ⋯ menu does (⇧⌫ without asking), and Esc goes back to the box
  /// to write in. Only a message itself answers: a key typed in its edit
  /// box, or pressed on one of its buttons, is that box's or button's.
  /// A click focuses a message too, but its letters wait until an arrow
  /// has picked it (keyPicked, which a press of the mouse in the log lets
  /// go): what is typed after a click was meant for the composer, and a "p"
  /// in it would pin the message for everyone. Esc waits the same way: on
  /// what was only clicked it is still the app's, which closes the thread
  /// or the decision beside the conversation, as it did before a message
  /// had keys — and it closes a menu or a picker open on the message first.
  const unpick = () => { keyPicked.current = null }
  /// Tab onto a log picks the log, as an arrow picks a message: it shows
  /// the ring, and Esc goes to the box to write in. A click on its blank
  /// space focuses it too and picks nothing. Asked as focus arrives: once a
  /// key is down a browser may show the ring on what the mouse focused.
  const pickLog = (e: React.FocusEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    try {
      if (e.currentTarget.matches(':focus-visible')) keyPicked.current = e.currentTarget
    } catch {
      // A browser without :focus-visible shows no ring: nothing is picked.
    }
  }
  /// A key that did something to a message, still held down: its repeats
  /// are nobody's until it comes up, or another key goes down. Focus has
  /// often moved by then — a held E would type "eee" into the edit box it
  /// opened, a held T into the thread's box, and ⇧⌫ would reach the message
  /// focus went to when this one was deleted.
  const holdKey = () => {
    const swallow = (ev: KeyboardEvent) => {
      if (!ev.repeat) { release(); return }
      ev.preventDefault()
      ev.stopPropagation()
    }
    const release = () => {
      window.removeEventListener('keydown', swallow, true)
      window.removeEventListener('keyup', release, true)
      window.removeEventListener('blur', release)
    }
    window.addEventListener('keydown', swallow, true)
    window.addEventListener('keyup', release, true)
    window.addEventListener('blur', release)
  }
  const logKeys = (channel: string, list: ChannelMessage[], box: React.RefObject<HTMLTextAreaElement>, inThread = false) => (e: React.KeyboardEvent<HTMLElement>) => {
    const log = e.currentTarget
    const target = e.target as HTMLElement
    const rows = () => Array.from(log.querySelectorAll<HTMLElement>('article.slk-msg[id^="msg-"]'))
    const show = (el: HTMLElement | undefined) => {
      if (!el) return
      keyPicked.current = el
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }
    if (target === log) {
      const action = messageKeyAction(e.nativeEvent, null)
      if (action === 'prev') { const all = rows(); if (all.length) { e.preventDefault(); show(all[all.length - 1]) } }
      if (action === 'composer' && box.current && keyPicked.current === log) { e.preventDefault(); e.stopPropagation(); box.current.focus() }
      return
    }
    if (target.closest('input, textarea, select, button, a, audio, video, iframe, [contenteditable], [role="button"]')) return
    const row = target.closest<HTMLElement>('article.slk-msg[id^="msg-"]')
    if (!row || !log.contains(row)) return
    const id = messageIdOf(row.id)
    const found = list.find((x) => x.id === id)
    // A card, or a message with its edit box open, is only moved past.
    const m = found && editing?.id !== found.id ? found : null
    const action = messageKeyAction(e.nativeEvent, m, inThread)
    if (!action) return
    const moving = action === 'prev' || action === 'next'
    if (!moving && keyPicked.current !== row) return
    // Esc closes what is open over the messages before it leaves them: the
    // ⋯ menu and the pickers listen on the document, further out than this.
    if (action === 'composer' && (toolsOpen || pickerFor)) return
    e.preventDefault()
    // Esc on a picked message is not the window's too, which closes the thread.
    e.stopPropagation()
    const all = rows()
    const at = all.indexOf(row)
    if (action === 'prev') { show(all[at - 1]); return }
    if (action === 'next') { show(all[at + 1]); return }
    if (action === 'composer') { box.current?.focus(); return }
    if (!m) return
    holdKey()
    if (action === 'edit') { keyReturn.current = { kind: 'edit', row, near: null }; setEditing({ id: m.id, text: m.body }) }
    else if (action === 'thread') void openThread(channel, m)
    else if (action === 'pin') togglePin(channel, m)
    else if (action === 'react') {
      keyReturn.current = { kind: 'react', row, near: null }
      setPickerFor(m.id)
      requestAnimationFrame(() => row.querySelector<HTMLElement>('.slk-picker .slk-picker-emoji')?.focus())
    } else if (action === 'delete') {
      keyReturn.current = { kind: 'delete', row, near: all[at + 1] || all[at - 1] || null }
      remove(channel, m, e.shiftKey)
    }
  }
  /// A link to one message that opens it for anyone who can read it — the
  /// message's id, not the conversation's name, which differs per reader.
  const copyLink = (m: ChannelMessage) => {
    // With the workspace: someone in two opens it in the right one.
    const url = `${location.origin}${location.pathname}${hashForMessage(m.id, api.orgId)}`
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

  /// "🎨 Hayao is writing…": the team's agents answering, in the thread
  /// they answer in — or, from the conversation, whichever are not open.
  const agentLines = (channel: string, only?: { parentId?: string; except?: string | null }) => {
    const list = (agentsWriting[channel] || []).filter((a) => (only?.parentId ? a.parentId === only.parentId : !only?.except || a.parentId !== only.except))
    if (!list.length) return null
    return (
      <div className="slk-typing slk-agent-typing" role="status" aria-live="polite">
        {list.map((a) => (
          <span key={a.id} className="slk-agent-writing" data-agent-writing={a.id}>
            <span className="slk-dots" aria-hidden="true"><i /><i /><i /></span>
            <AgentAvatar agent={a} /> {t('{name} is writing…', { name: a.name })}
          </span>
        ))}
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
              <span className="slk-act-line"><b>{whoSaid(m)}</b><span className="slk-act-when">{when(m.createdAt)}</span></span>
              <span className="slk-act-body">{shownBody(m).text.slice(0, 280)}</span>
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

  /// Threads: each thread you started, answered or were named in, the
  /// newest reply first — its first message, how many replies, the last two.
  const threadsView = () => (
    <>
      <header className="slk-head slk-later-head slk-threads-head">
        <button className="slk-back" onClick={() => setThreadsOpen(false)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
        <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="message" size={16} /></span>
        <div className="slk-head-text">
          <h1>{t('Threads')}</h1>
          <p>{t('Threads you started, answered or were named in. The newest reply first.')}</p>
        </div>
        {threadsUnread > 0 && <button type="button" className="cl-nudge slk-mark-all" onClick={markAllThreadsRead} data-mark-all="threads">{t('Mark all as read')}</button>}
      </header>
      <div className="slk-log slk-activity slk-threads">
        {threadItems === null && <p className="slk-empty">{t('Loading…')}</p>}
        {threadItems && threadItems.length === 0 && (
          <div className="slk-start">
            <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="message" size={16} /></span>
            <h2>{t('No threads yet')}</h2>
            <p>{t('Reply in a thread, or be named in one, and it is kept here.')}</p>
          </div>
        )}
        {(threadItems || []).map((x) => {
          const th = everything.find((y) => y.view === x.parent.channel)
          const who = whoSaid
          const open = () => { markThreadRead(x.parent.channel, x.parent.id); openAt({ view: x.parent.channel, id: x.parent.id, parentId: x.parent.id }) }
          return (
            <article key={x.parent.id} className={`slk-thread-card${x.unread ? ' unread' : ''}`} data-thread={x.parent.id}>
              <button type="button" className="slk-thread-where" onClick={open}>
                {th?.kind === 'channel' ? <Icon name="hash" size={12} /> : <Icon name="message" size={12} />}
                {th ? th.name : ''}
                {x.unread && <span className="slk-thread-dot" aria-label={t('New replies')} />}
              </button>
              {[x.parent, ...x.replies].map((m, i) => (
                <div key={m.id} className={`slk-thread-line${i === 0 ? ' first' : ''}`}>
                  <span className="slk-thread-face" aria-hidden="true">{avatarFor(m.kind === 'ai' ? 'ai' : '', faceOfMessage(m))}</span>
                  <span className="slk-thread-text">
                    <span className="slk-act-line"><b>{who(m)}</b><span className="slk-act-when">{when(m.createdAt)}</span></span>
                    <span className="slk-text">{(() => { const b = shownBody(m).text; return rich(b.length > 400 ? `${b.slice(0, 400)}…` : b) })()}</span>
                  </span>
                  {i === 0 && x.replyCount > x.replies.length && (
                    <button type="button" className="slk-thread-more" onClick={open}>{t('{n} more replies', { n: x.replyCount - x.replies.length })}</button>
                  )}
                </div>
              ))}
              <div className="slk-act-actions">
                <button type="button" className="cl-nudge" onClick={open} data-open-thread="1">{t('Reply')}</button>
              </div>
            </article>
          )
        })}
      </div>
    </>
  )

  /// Drafts & sent: what you started writing and left, each where it
  /// waits, and what you said, newest first — as a chat client keeps them.
  const draftList = () => Object.keys(drafts).filter((v) => drafts[v]).flatMap((v) => {
    const th = everything.find((x) => isDraftOf(x, v))
    let text = ''
    try { text = localStorage.getItem(draftKey(v)) || '' } catch { /* none kept */ }
    return th && text ? [{ view: v, th, text }] : []
  })
  const discardDraft = (v: string) => {
    try { localStorage.removeItem(draftKey(v)) } catch { /* nothing kept */ }
    if (draftId === v) setDraft('')
    setDrafts((prev) => { const next = { ...prev }; delete next[v]; return next })
  }
  const sentView = () => {
    const kept = draftList()
    const where = (th?: Thread) => (th ? (th.kind === 'channel' && !th.private ? `#${th.name}` : th.name) : '')
    return (
      <>
        <header className="slk-head slk-later-head slk-sent-head">
          <button className="slk-back" onClick={() => setSentOpen(false)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
          <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="send" size={16} /></span>
          <div className="slk-head-text">
            <h1>{t('Drafts & sent')}</h1>
            <p>{t('What you started writing and left, and what you said, newest first.')}</p>
          </div>
        </header>
        <div className="slk-inbox-tabs slk-sent-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={sentTab === 'drafts'} className={sentTab === 'drafts' ? 'on' : ''} onClick={() => setSentTab('drafts')} data-sent-tab="drafts">
            {t('Drafts')}{kept.length > 0 && <span className="slk-sent-count">{kept.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={sentTab === 'sent'} className={sentTab === 'sent' ? 'on' : ''} onClick={() => { setSentTab('sent'); void loadSent() }} data-sent-tab="sent">{t('Sent')}</button>
        </div>
        <div className="slk-log slk-activity">
          {sentTab === 'drafts' && kept.length === 0 && (
            <div className="slk-start">
              <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="edit" size={16} /></span>
              <h2>{t('No drafts')}</h2>
              <p>{t('A message you start and leave unsent waits here, in the conversation it was for.')}</p>
            </div>
          )}
          {sentTab === 'drafts' && kept.map(({ view: v, th, text }) => (
            <div key={v} className="slk-act later" data-draft={th.name}>
              <span className="slk-act-kind">{where(th)}</span>
              <span className="slk-act-body">{text.slice(0, 280)}</span>
              <span className="slk-act-actions">
                <button type="button" className="cl-nudge" onClick={() => choose(th.key)} data-draft-open="1">{t('Open')}</button>
                <button type="button" className="cl-nudge" onClick={() => discardDraft(v)} data-draft-discard="1">{t('Discard')}</button>
              </span>
            </div>
          ))}
          {sentTab === 'sent' && sentItems === null && <p className="slk-empty">{t('Loading…')}</p>}
          {sentTab === 'sent' && sentItems && sentItems.length === 0 && (
            <div className="slk-start">
              <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="send" size={16} /></span>
              <h2>{t('Nothing sent yet')}</h2>
              <p>{t('What you say in a channel, a DM or a thread is listed here.')}</p>
            </div>
          )}
          {sentTab === 'sent' && (sentItems || []).map((m) => {
            const th = everything.find((x) => x.view === m.channel)
            return (
              <div key={m.id} className="slk-act later" data-sent-message={m.id}>
                <span className="slk-act-kind">{where(th)}{m.parentId ? ` · ${t('in a thread')}` : ''}</span>
                <span className="slk-act-line"><span className="slk-act-when">{when(m.createdAt)}</span></span>
                <span className="slk-act-body">{shownBody(m).text.slice(0, 280)}</span>
                <span className="slk-act-actions">
                  <button type="button" className="cl-nudge" onClick={() => openAt({ view: m.channel, id: m.id, parentId: m.parentId })}>{t('Open')}</button>
                </span>
              </div>
            )
          })}
        </div>
      </>
    )
  }

  const activityView = () => {
    const nameOfView = (v: string) => {
      const th = everything.find((x) => x.view === v)
      return th ? (th.kind === 'channel' ? th.name : th.name) : v
    }
    const isChannel = (v: string) => everything.find((x) => x.view === v)?.kind === 'channel'
    const keyOf = activityKey
    const whoOf = (i: ActivityItem) => (i.type === 'reaction' ? (i.by || t('a teammate')) : i.message.kind === 'ai' ? t('Your AI') : (i.message.authorName || t('a teammate')))
    // A reply is in a thread, or inline to what you wrote.
    const verb = (i: ActivityItem) => (i.type === 'reaction' ? t('reacted') : i.type === 'reply' ? (i.message.parentId ? t('replied in a thread') : t('replied to you')) : i.type === 'keyword' ? t('said “{word}”', { word: i.keyword || '' }) : t('mentioned you'))
    const items = (activityItems || []).filter((i) => (activityTab === 'mentions' ? i.type === 'mention' : activityTab === 'all' || i.unread || unreadShown.has(keyOf(i))))
    // Mentions: every @ of you, where it came from, and a way to clear them
    // all at once without opening each conversation (#213).
    const mentionsUnread = (activityItems || []).filter((i) => i.unread && i.type === 'mention')
    const picked = (activityItems || []).find((i) => keyOf(i) === activityPick) || null
    const open = (i: ActivityItem) => {
      markActivitySeen([keyOf(i)])
      if (wide) {
        setActivityPick(keyOf(i))
        // Part of a thread: the whole of it, open, beside the list.
        const parentId = i.message.parentId || ((i.message.replyCount || 0) > 0 ? i.message.id : null)
        if (parentId) void showThreadIn(i.message.channel, parentId, i.message.id)
        else setThread(null)
      } else openAt({ view: i.message.channel, id: i.message.id, parentId: i.message.parentId })
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
              <button type="button" role="tab" aria-selected={activityTab === 'unread'} onClick={() => { setUnreadShown(new Set((activityItems || []).filter((i) => i.unread).map(keyOf))); setActivityTab('unread') }} data-unread-tab="1">
                {t('Unread')}{(activityItems || []).some((i) => i.unread) ? <span className="slk-inbox-count">{(activityItems || []).filter((i) => i.unread).length}</span> : null}
              </button>
              <button type="button" role="tab" aria-selected={activityTab === 'mentions'} onClick={() => setActivityTab('mentions')} data-mentions-tab="1">
                {t('Mentions')}{mentionsUnread.length ? <span className="slk-inbox-count">{mentionsUnread.length}</span> : null}
              </button>
            </div>
            {activityTab === 'mentions'
              ? mentionsUnread.length > 0 && <button type="button" className="cl-nudge slk-mark-all" onClick={() => markActivitySeen(mentionsUnread.map(keyOf))} data-mark-all="mentions">{t('Mark mentions as read')}</button>
              : activityUnread > 0 && <button type="button" className="cl-nudge slk-mark-all" onClick={markAllActivityRead} data-mark-all="activity">{t('Mark all as read')}</button>}
          </header>
          <div className="slk-inbox-rows slk-activity" ref={activityRows}>
            {activityItems === null && <p className="slk-empty">{t('Loading…')}</p>}
            {activityItems && items.length === 0 && (
              <div className="slk-start">
                <span className="cl-lead cl-app sz-head" aria-hidden="true"><Icon name="bell" size={18} /></span>
                <h2>{activityTab === 'unread' ? t('All caught up') : activityTab === 'mentions' ? t('No mentions') : t('Nothing for you yet')}</h2>
                <p>{t('When somebody writes @ your name, replies in a thread you are part of, or reacts to what you wrote, it shows up here.')}</p>
              </div>
            )}
            {items.map((i) => {
              const m = i.message
              const who = whoOf(i)
              return (
                <button key={keyOf(i)} type="button" data-key={i.unread ? keyOf(i) : undefined} className={`slk-act slk-note${i.unread ? ' unread' : ''}${activityPick === keyOf(i) ? ' on' : ''}`} onClick={() => open(i)} data-kind={i.type}>
                  <span className="slk-note-avatar" aria-hidden="true">{m.kind === 'ai' && i.type !== 'reaction'
                    ? <img src="/icon.svg" alt="" width={32} height={32} />
                    : m.kind === 'agent' && i.type !== 'reaction'
                    ? <AgentAvatar className="slk-agent-tile" agent={m.agent} />
                    : <Avatar name={who} url={i.type === 'reaction' ? i.byAvatar : (m.authorAvatar || memberByRef(m.authorRef)?.avatarUrl)} size={32} />}</span>
                  <span className="slk-note-main">
                    <span className="slk-note-line">
                      <span className="slk-note-who"><b>{who}</b> {verb(i)}</span>
                      <span className="slk-act-when">{when(i.at || m.createdAt)}</span>
                    </span>
                    {where(m.channel)}
                    <span className="slk-act-body">{i.type === 'reaction' ? <>{t('You')}: </> : null}{shownBody(m).text.slice(0, 280)}</span>
                    {i.type === 'reaction' && i.emoji && <span className="slk-note-reaction"><span><EmojiGlyph emoji={i.emoji} /></span> 1</span>}
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
                  {t('Open in the conversation')}
                </button>
              </header>
              {thread && (thread.parent.id === picked.message.parentId || thread.parent.id === picked.message.id) ? (
                <div className="slk-inbox-thread">
                  {picked.type === 'reaction' && picked.emoji && (
                    <p className="slk-inbox-said"><span className="slk-note-reaction big"><span><EmojiGlyph emoji={picked.emoji} /></span></span> {t('{name} reacted to your message', { name: whoOf(picked) })}</p>
                  )}
                  {threadBody(thread)}
                </div>
              ) : (
              <div className="slk-inbox-view-body">
                {picked.type === 'reaction' && picked.emoji && (
                  <p className="slk-inbox-said"><span className="slk-note-reaction big"><span><EmojiGlyph emoji={picked.emoji} /></span></span> {t('{name} reacted to your message', { name: whoOf(picked) })}</p>
                )}
                <article className="slk-msg slk-inbox-msg">
                  <div className="slk-gutter" aria-hidden="true">
                    {avatarFor(picked.message.kind === 'ai' ? 'ai' : '', faceOfMessage(picked.message))}
                  </div>
                  <div className="slk-body">
                    <div className="slk-meta">
                      <span className="slk-author">{whoSaid(picked.message)}</span>
                      {picked.message.kind === 'agent' && <span className="slk-app-badge agent">{t('Agent')}</span>}
                      <time className="slk-time" dateTime={picked.message.createdAt}>{when(picked.message.createdAt)}</time>
                    </div>
                    <div className="slk-text">{rich(shownBody(picked.message).text)}</div>
                    {translationNote(picked.message)}
                    {(picked.message.reactions || []).length > 0 && (
                      <div className="slk-reactions">
                        {(picked.message.reactions || []).map((r) => (
                          <span key={r.emoji} className={`slk-reaction${r.mine ? ' mine' : ''}`}><span className="slk-reaction-emoji"><EmojiGlyph emoji={r.emoji} /></span><span className="slk-reaction-count">{r.count}</span></span>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              </div>
              )}
            </>
          )}
        </section>
      </div>
    )
  }

  /// A thread's messages and the box to answer in: in the pane beside a
  /// conversation, and in Activity when what you picked is part of one.
  /// The thread's count as the line under its first message says it: what
  /// is drawn — or, while the replies are still being read, the count the
  /// conversation already showed, with "Loading…" (#216). An empty thread
  /// says so only once it is known to be empty.
  const threadCount = (thread: { channel: string; parent: ChannelMessage; replies: ChannelMessage[]; loading?: boolean; failed?: boolean }) => {
    const drawn = thread.replies.length
    const known = Math.max(drawn, thread.parent.replyCount || 0)
    const n = thread.loading || thread.failed ? known : drawn
    const words = n === 1 ? t('1 reply') : t('{n} replies', { n })
    if (thread.loading && drawn < known) return <span aria-busy="true">{words} · {t('Loading…')}</span>
    if (thread.failed) {
      return (
        <span>{words} · {t("Couldn't load the replies.")}{' '}
          <button type="button" className="slk-link-button" onClick={() => void openThread(thread.channel, thread.parent)}>{t('Try again')}</button>
        </span>
      )
    }
    return <span>{words}</span>
  }
  const threadBody = (thread: { channel: string; parent: ChannelMessage; replies: ChannelMessage[]; loading?: boolean; failed?: boolean }) => (
    <>
          <div className="slk-thread-log" tabIndex={0} role="region" aria-label={t('Messages')}
            onKeyDown={logKeys(thread.channel, [thread.parent, ...thread.replies], threadComposer, true)} onMouseDown={unpick} onFocus={pickLog}>
            {[thread.parent, ...thread.replies].map((m, i) => (
              <React.Fragment key={keyOf(m)}>
                {block(keyOf(m), {
                  joined: false, at: m.createdAt, app: m.kind === 'ai' ? 'ai' : '', badge: m.kind === 'ai' ? t('AI') : m.kind === 'agent' ? (m.onBehalfOf?.name ? t("{name}'s agent", { name: m.onBehalfOf.name }) : t('Agent')) : undefined,
                  name: whoSaid(m),
                  face: m.kind !== 'ai' ? faceOfMessage(m) : null,
                  authorRef: m.mine ? null : m.authorRef,
                  msgId: i === 0 ? `thread-${m.id}` : m.id, mentionsMe: callsMe(m),
                  tools: toolsFor(thread.channel, m, true), onHold: holdFor(thread.channel, m, true), onMenu: menuFor(thread.channel, m, true), state: tempState(m),
                }, (
                  <>
                    {words(thread.channel, m)}
                    {i > 0 && m.alsoChannel && <div className="slk-also-sent" data-also-sent={m.id}>{t('Also sent to the conversation')}</div>}
                    {m.cardId && cardsById.get(m.cardId) && attachment(cardsById.get(m.cardId)!)}
                    {underneath(thread.channel, m, true)}
                  </>
                ))}
                {i === 0 && (
                  <div className="slk-thread-count" role="separator">
                    {threadCount(thread)}
                  </div>
                )}
              </React.Fragment>
            ))}
            {aiSteps(thinking[thread.channel])}
            {agentLines(thread.channel, { parentId: thread.parent.id })}
          </div>
          <TypingLine names={typingHere(thread.channel, thread.parent.id)} />
          <form className="slk-composer thread" onSubmit={(e) => { e.preventDefault(); void send(thread.channel, false, thread.parent.id) }}>
            <PendingUploads items={threadUploads.items} onRemove={threadUploads.remove} />
            {threadHl.layer}
            <textarea
              ref={threadComposer}
              onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); threadUploads.add(files, thread.channel) } }}
              className={`slk-input${threadHl.active ? ' has-mentions' : ''}`}
              value={threadDraft}
              rows={1}
              maxLength={4000}
              placeholder={t('Reply… — @AI to ask the AI')}
              aria-label={t('Reply in thread')}
              onChange={(e) => { setThreadDraft(e.target.value); threadMention.track(); typed({ channel: thread.channel, parentId: thread.parent.id }, e.target.value) }}
              onBlur={() => stoppedTyping({ channel: thread.channel, parentId: thread.parent.id })}
              onKeyUp={threadMention.track}
              onClick={threadMention.track}
              onKeyDown={(e) => {
                if (threadMention.onKeyDown(e)) return
                if (enterKey(e) && !e.metaKey && !e.ctrlKey && (e.shiftKey || !wide) && continueBlock(e.currentTarget, threadDraft, setThreadDraft)) { e.preventDefault(); return }
                if (enterKey(e) && !e.shiftKey && wide) { e.preventDefault(); void send(thread.channel, false, thread.parent.id) }
              }}
            />
            {threadMention.menu}
            <div className="slk-composer-bar">
              <button type="button" className="slk-attach" onClick={() => threadAttachInput.current?.click()} aria-label={t('Attach files')} title={t('Attach files')}><Icon name="paperclip" size={17} /></button>
              <input ref={threadAttachInput} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) threadUploads.add(files, thread.channel) }} />
              <FormatBar target={threadComposer} value={threadDraft} set={setThreadDraft} />
              <label className="slk-also-channel" data-also-channel="1">
                <input type="checkbox" checked={threadAlso} onChange={(e) => setThreadAlso(e.target.checked)} />
                <span>{(() => {
                  const where = everything.find((x) => x.view === thread.channel)
                  return where?.kind === 'channel' ? t('Also send to {where}', { where: `#${where.name}` }) : t('Also send to the conversation')
                })()}</span>
              </label>
              <span className="slk-composer-hint" />
              <button type="submit" className="slk-send" disabled={threadUploads.busy || (!threadDraft.trim() && !threadUploads.ids.length)} aria-label={t('Send')}>
                <Icon name="send" size={16} />
              </button>
            </div>
          </form>
    </>
  )
  /// How many people a conversation has: a public channel is everyone.
  const headCount = (th: Thread) => th.kind === 'group' ? (th.refs || []).length + 1
    : th.kind === 'channel' ? (th.private ? (th.memberCount || 1) : members.length) : 2
  /// A card in a conversation: react to it, open it, take it back.
  const [cardReacted, setCardReacted] = useState<Record<string, Array<{ emoji: string; count: number; mine?: boolean }>>>({})
  const reactCard = async (c: DecisionCard, emoji: string) => {
    if (!cardReacted[c.id]?.some((r) => r.emoji === emoji && r.mine)) rememberEmoji(emoji)
    const res = await fetch(`${api.httpBase}/cards/${encodeURIComponent(c.id)}/reactions`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, emoji }),
    }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (Array.isArray(data?.reactions)) {
      setCardReacted((prev) => ({ ...prev, [c.id]: data.reactions }))
    } else if (!res?.ok) setToast(t('That did not save.'))
  }
  const canDeleteCard = (c: DecisionCard) => Boolean(onDeleteCard) && (c.recipientUserID === userId || (c.senderUserID === userId && c.status === 'pending'))
  const deleteCard = (c: DecisionCard) => {
    if (!onDeleteCard || !window.confirm(t('Delete this card? It is gone for everyone it was sent to.'))) return
    onDeleteCard(c.id)
  }
  const cardTools = (c: DecisionCard) => (
    <CardActions
      onReact={(e) => void reactCard(c, e)}
      onOpen={() => openCard(c.id)}
      onDelete={canDeleteCard(c) ? () => deleteCard(c) : undefined}
      onOpenChange={(open) => setToolsOpen((cur) => (open ? c.id : cur === c.id ? null : cur))}
    />
  )
  const cardReactions = (c: DecisionCard) => {
    const list = (cardReacted[c.id] || Object.entries(c.reactions || {}).map(([emoji, count]) => ({ emoji, count, mine: false })))
      .filter((r) => r.count > 0)
    if (!list.length) return null
    return (
      <div className="slk-reactions" data-card-reactions={c.id}>
        {list.map((r) => (
          <button key={r.emoji} type="button" className={`slk-reaction${r.mine ? ' mine' : ''}`} aria-pressed={Boolean(r.mine)} onClick={() => void reactCard(c, r.emoji)}>
            <span className="slk-reaction-emoji"><EmojiGlyph emoji={r.emoji} /></span>
            <span className="slk-reaction-count">{r.count}</span>
          </button>
        ))}
      </div>
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
      if (!lined && item.kind === 'msg' && isNewSince(item.msg, since)) {
        lined = true
        out.push(<div key="new-line" className="slk-new-line" role="separator"><span>{t('New')}</span></div>)
      }
      if (item.kind === 'card') {
        const c = item.card
        const who = author(c)
        const joined = prevWho === `card:${who.name}` && at - prevAt < 5 * 60000
        const to = c.senderUserID === userId && c.recipientUserID !== userId ? nameOfRecipient(c) : ''
        const from = !who.app && c.senderUserID !== userId ? memberOfLogin(c.senderUserID)?.ref : null
        out.push(block(c.id, { joined, at: c.createdAt, app: who.app, name: who.name, face: who.face, to, unread: isUnread(c), msgId: c.id, authorRef: from, tools: cardTools(c) }, (
          <>
            {attachment(c)}
            {cardReactions(c)}
          </>
        )))
        prevWho = `card:${who.name}`
      } else {
        const m = item.msg
        if (m.kind === 'joined') {
          // Somebody new came into the workspace: one quiet line, in your words.
          out.push(
            <div key={m.id} className="slk-joined" data-joined={m.id}>
              <span className="slk-joined-face" aria-hidden="true">{m.authorAvatar ? <img src={m.authorAvatar} alt="" /> : '👋'}</span>
              <span className="slk-joined-text">{t('{name} joined the workspace. Say hello!', { name: m.authorName || t('Someone') })}</span>
              <time className="slk-joined-time" dateTime={m.createdAt}>{new Date(Date.parse(m.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </div>,
          )
          prevWho = ''
          continue
        }
        if (m.kind === 'ai') {
          const card = m.cardId ? cardsById.get(m.cardId) : undefined
          out.push(block(m.id, { joined: false, at: m.createdAt, app: 'ai', name: t('Your AI'), badge: t('AI'), msgId: m.id, pinned: m.pinned, mentionsMe: callsMe(m), tools: toolsFor(thread.view!, m), onHold: holdFor(thread.view!, m), onMenu: menuFor(thread.view!, m) },
            <>
              <div className="slk-text">{rich(shownBody(m).text)}</div>
              {translationNote(m)}
              {card && attachment(card)}
              {jams[thread.view!]?.messageId === m.id && jamCard(thread.view!, jams[thread.view!])}
              {underneath(thread.view!, m)}
            </>))
          prevWho = 'ai'
        } else {
          const whoKey = `msg:${m.authorRef || m.authorName}`
          const joined = prevWho === whoKey && at - prevAt < 5 * 60000
          const name = whoSaid(m)
          // A reply always shows whose it is, under the line it quotes.
          const quote = m.replyTo && !m.deleted ? m.replyTo : null
          // A thread reply sent here too says which thread it answers.
          const fromThread = !quote && m.parentId && m.alsoChannel && m.threadParent && !m.deleted ? m.threadParent : null
          out.push(block(keyOf(m), {
            joined: joined && !m.pinned && !quote && !fromThread, at: m.createdAt, app: '', name, face: faceOfMessage(m), badge: m.kind === 'agent' ? (m.onBehalfOf?.name ? t("{name}'s agent", { name: m.onBehalfOf.name }) : t('Agent')) : undefined, msgId: m.id, pinned: m.pinned, authorRef: m.mine ? null : m.authorRef,
            mentionsMe: callsMe(m), tools: toolsFor(thread.view!, m), onHold: holdFor(thread.view!, m), onMenu: menuFor(thread.view!, m), state: tempState(m),
            quote: quote ? <ReplyQuoteLine quote={quote} name={quoteName(quote)} onJump={() => void goToQuoted(thread.view!, quote.id)} />
              : fromThread ? <ThreadReplyLine quote={fromThread} onOpen={() => void openThread(thread.view!, m)} /> : undefined,
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
      ? t('Message #{name} — @AI to ask the AI', { name: thread.name })
      : thread.kind === 'agent'
        ? t('Message {name}', { name: thread.name })
        : t('Message {name} — @AI to ask the AI', { name: thread.name })
    // The message the box is answering, when a reply was started here.
    const replying = replyingTo && replyingTo.view === thread.view ? replyingTo.quote : null
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
                  {(() => { const s = statusShown(members.find((x) => thread.view === `dm:${x.ref}`)?.status, Date.now()); return s ? <span className="slk-head-status"> {s.emoji} {s.text}</span> : null })()}
                  {(() => { const away = awayShown(members.find((x) => thread.view === `dm:${x.ref}`)?.awayUntil, Date.now()); return away ? <span className="slk-head-away"> · {t('Away until {when}', { when: new Date(away).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) })}</span> : null })()}
                </h1>
              : <h1>{thread.name}</h1>}
            {thread.view && (
              <span className="slk-head-tools" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`slk-head-btn slk-star-button${isStarred(thread.view) ? ' on' : ''}`}
                  onClick={() => toggleStar(thread.view!)}
                  aria-pressed={isStarred(thread.view)}
                  aria-label={isStarred(thread.view) ? t('Unstar') : t('Star')} title={isStarred(thread.view) ? t('Unstar') : t('Star')}
                  data-star="1"
                >
                  <Icon name="star" size={15} />
                </button>
                <div className="slk-move-wrap">
                  <button type="button" className={`slk-head-btn slk-move-button${moveMenu ? ' on' : ''}`} onClick={() => setMoveMenu((m) => !m)}
                    aria-haspopup="menu" aria-expanded={moveMenu} aria-label={t('Move to a section')} title={t('Move to a section')} data-move="1">
                    <Icon name="folder" size={15} />
                  </button>
                  {moveMenu && (
                    <div className="slk-menu slk-move-menu" role="menu" onMouseLeave={() => setMoveMenu(false)}>
                      {layout.sections.map((x) => (
                        <button key={x.id} type="button" role="menuitemradio" aria-checked={sectionOf(thread.view!)?.id === x.id} onClick={() => { setMoveMenu(false); moveTo(thread.view!, x.id) }} data-move-to={x.name}>
                          {x.name}{sectionOf(thread.view!)?.id === x.id && <Icon name="check" size={13} />}
                        </button>
                      ))}
                      {sectionOf(thread.view) && <button type="button" role="menuitem" onClick={() => { setMoveMenu(false); moveTo(thread.view!, null) }}>{t('Back to where it was')}</button>}
                      <div className="slk-menu-sep" />
                      <button type="button" role="menuitem" onClick={() => { setMoveMenu(false); setSectionName(''); setAddingSection({ view: thread.view! }) }} data-new-section="1">{t('New section…')}</button>
                    </div>
                  )}
                </div>
              </span>
            )}
            {thread.kind === 'agent' && thread.agent ? (
              <p className="slk-head-agent">
                <span className="slk-head-handle">@{thread.agent.handle}</span>
                {thread.agent.description && <> · <span className="slk-head-desc">{thread.agent.description}</span></>}
              </p>
            ) : <p>
              {!wide && (thread.kind === 'channel' || thread.kind === 'group') && <>{t('{n} members', { n: headCount(thread) })} · </>}
              {thread.cards.length ? t('{n} decisions', { n: thread.cards.length }) : t('No decisions here yet.')}
              {waitingHere > 0 && <> · <b>{t('{n} waiting on you', { n: waitingHere })}</b></>}
            </p>}
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
              {thread.kind !== 'agent' && <button
                type="button"
                className={`slk-head-btn slk-members-button${side?.kind === 'details' && side.tab === 'members' ? ' on' : ''}`}
                onClick={() => openSide({ kind: 'details', tab: 'members' })}
                aria-label={t('Members ({n})', { n: headCount(thread) })} title={t('Members')}
              >
                <Icon name="you" size={14} /><span>{headCount(thread)}</span>
              </button>}
              {thread.kind !== 'app' && thread.kind !== 'agent' && (
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
              <button
                type="button"
                className={`slk-head-btn slk-canvas-button${side?.kind === 'canvas' ? ' on' : ''}`}
                onClick={() => openSide({ kind: 'canvas' })}
                aria-label={t('Canvas')} title={t('Canvas')} aria-expanded={side?.kind === 'canvas'}
                data-open-canvas="1"
              >
                <Icon name="file" size={15} />
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
              onClick={() => { forgetWanted(); setSettings((v) => !v); setRenaming(null) }}
              aria-label={t('Channel settings')}
              aria-expanded={settings}
            >
              <Icon name="more" size={16} />
            </button>
          )}
        </header>
        {thread.view && thread.kind !== 'app' && <BookmarksBar httpBase={api.httpBase} orgId={api.orgId} headers={authHeaders} view={thread.view} />}
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
                    <span className="slk-pin-who">{whoSaid(m)} · {when(m.createdAt)}</span>
                    <span className="slk-pin-body">{shownBody(m).text.slice(0, 200)}</span>
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
                  onKeyDown={(e) => { if (e.key === 'Escape' && !composing(e)) setRenaming(null) }}
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
                {onOpenRecord && <button type="button" className="cl-nudge" onClick={() => { setSettings(false); onOpenRecord() }} data-open-record="1">{t('Record (Markdown)')}</button>}
                {thread.private && <button type="button" className="cl-nudge" onClick={() => setAddingTo(thread.view!)} data-add-people="1">{t('Add people')}</button>}
                {thread.private && <button type="button" className="cl-nudge" onClick={() => void leaveChannel(thread)} data-leave="1">{t('Leave channel')}</button>}
                <button type="button" className="cl-nudge" onClick={() => { setRenaming(thread.slug!); setRenameTo(thread.name) }}>{t('Rename')}</button>
                <button type="button" className="cl-nudge" onClick={() => setArchiveDialog({ thread })} data-archive-channel="1">{t('Archive channel')}</button>
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
        <div className={thread.view ? 'slk-log with-typing' : 'slk-log'} ref={logAt} onScroll={(e) => {
          if (!thread.view) return
          noteWhere(thread.view, e.currentTarget)
          if (e.currentTarget.scrollTop < 120) void loadOlder(thread.view)
        }}
          tabIndex={0} role="region" aria-label={t('Messages in {name}', { name: thread.kind === 'channel' ? `#${thread.name}` : thread.name })}
          onKeyDown={thread.view ? logKeys(thread.view, said, composer) : undefined} onMouseDown={unpick} onFocus={pickLog}>
          {thread.view && more[thread.view] && <div className="slk-older" role="status">{t('Loading earlier messages…')}</div>}
          {!(thread.view && more[thread.view]) && <div className="slk-start">
            {lead(thread, 'head')}
            <h2>{thread.kind === 'channel' ? t('This is the start of #{name}', { name: thread.name }) : thread.name}</h2>
            <p>{thread.kind === 'channel'
              ? t('Talk about {name} here. Write @AI to ask your AI anything. A decision card is made only when you ask for one: ✦, or “Make it a decision” on a message.', { name: thread.name })
              : thread.kind === 'person'
                ? t('Just the two of you. Write @AI to ask your AI, or ✦ to send {name} a decision.', { name: thread.name })
                : thread.kind === 'agent'
                  ? <>{thread.agent?.description ? `${thread.agent.description} ` : ''}{t('Only you see this conversation. {name} answers everything you write here, with your past decisions and connected tools at hand.', { name: thread.name })}</>
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
          {thread.view && agentLines(thread.view, { except: threadOpenParent })}
          {/* Up in the history: the way back down, and what waits there. */}
          {readingUp && readingUp.view === thread.view && <JumpToPresent count={countNewBelow(said, readingUp.since)} onJump={goToPresent} />}
        </div>
        )}
        {thread.view && (
          <div className="sr-only" role="status" aria-live="polite">
            {heard === 0 ? '' : newBelowLabel(heard, t)}
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
        {thread.view && draftsFor(thread.view).map((card) => (
          <div key={card.id} className="slk-daily-draft">
            <DailyReportDraft card={card} api={api} inChannel />
          </div>
        ))}
        {/* Right above the box, under whatever else sits between it and the log. */}
        {thread.view && <TypingLine names={typingHere(thread.view, null)} />}
        {thread.view ? (
          <form className="slk-composer" onSubmit={(e) => { e.preventDefault(); void send(thread.view!, false) }}>
            {replying && <ReplyingBar quote={replying} name={quoteName(replying)} textId="slk-replying-text" onCancel={() => { setReplyingTo(null); composer.current?.focus() }} />}
            <PendingUploads items={uploads.items} onRemove={uploads.remove} />
            {draftHl.layer}
            <textarea
              ref={composer}
              onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); uploads.add(files, thread.view!) } }}
              className={`slk-input${draftHl.active ? ' has-mentions' : ''}`}
              value={draft}
              rows={1}
              maxLength={4000}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-describedby={replying ? 'slk-replying-text' : undefined}
              onChange={(e) => { setDraft(e.target.value); mention.track(); typed({ channel: thread.view!, parentId: null }, e.target.value) }}
              onBlur={() => stoppedTyping({ channel: thread.view!, parentId: null })}
              onKeyUp={mention.track}
              onClick={mention.track}
              onKeyDown={(e) => {
                if (mention.onKeyDown(e)) return
                // Escape takes the reply back, and leaves the words.
                if (e.key === 'Escape' && replying && !e.shiftKey && !composing(e)) { e.preventDefault(); setReplyingTo(null); return }
                // ↑ in an empty box edits what you last said, as in Slack —
                // on its way still, the edit waits for it to land; one that
                // did not go has its own Retry and Delete instead.
                if (e.key === 'ArrowUp' && !draft && !composing(e)) {
                  const last = [...(messages[thread.view!] || [])].reverse().find((m) => m.mine && m.kind === 'message' && !m.deleted)
                  if (last && !last.failed) { e.preventDefault(); setEditing({ id: last.id, text: last.body }) }
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
                // A new line in a quote or a list carries its mark on.
                if (enterKey(e) && !e.metaKey && !e.ctrlKey && (e.shiftKey || !wide) && continueBlock(e.currentTarget, draft, setDraft)) { e.preventDefault(); return }
                // ⌘Enter sends too — as a message. A decision card comes only
                // from "@AI" or the ✦ button, never from a key pressed by habit.
                if (enterKey(e) && !e.shiftKey && wide) { e.preventDefault(); void send(thread.view!, false) }
              }}
            />
            {mention.menu}
            <SlashMenu draft={draft} onPick={(name) => { setDraft(`/${name} `); composer.current?.focus() }} />
            <div className="slk-composer-bar">
              <button type="button" className="slk-attach" onClick={() => attachInput.current?.click()} aria-label={t('Attach files')} title={t('Attach files')}><Icon name="paperclip" size={17} /></button>
              <input ref={attachInput} type="file" multiple hidden data-attach="1" onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) uploads.add(files, thread.view!) }} />
              <FormatBar target={composer} value={draft} set={setDraft} />
              <span className="slk-composer-hint">{t('Enter to send · @AI to ask · ✦ makes it a decision · / for commands')}</span>
              <button type="button" className="slk-send ai" disabled={!draft.trim()} onClick={() => void send(thread.view!, true)} aria-label={t('Send as a decision')} title={t('Send as a decision')}>
                <Icon name="sparkle" size={15} /><span className="slk-send-label">{t('Send as a decision')}</span>
              </button>
              <span className="slk-send-group">
                <button type="submit" className="slk-send" disabled={uploads.busy || (!draft.trim() && !uploads.ids.length)} aria-label={t('Send')}>
                  <Icon name="send" size={16} />
                </button>
                <button type="button" className="slk-send more" disabled={!draft.trim() || draft.trim().startsWith('/')} onClick={() => setScheduleOpen((o) => !o)} aria-label={t('Schedule message')} title={t('Schedule message')} aria-expanded={scheduleOpen}>
                  <Icon name="chevron-down" size={14} />
                </button>
                {scheduleOpen && <SchedulePicker onPick={(at) => void sendAtTime(thread.view!, at)} onClose={() => setScheduleOpen(false)} />}
              </span>
            </div>
          </form>
        ) : thread.app === 'ai' ? (
          // Your AI is somebody you write to, like anyone else in the list:
          // what you write here is an instruction, routed as one.
          <form className="slk-composer" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { tellAI(draft.trim()); setDraft('') } else composer.current?.focus() }}>
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
                if (enterKey(e) && !e.shiftKey) {
                  e.preventDefault()
                  if (draft.trim()) { tellAI(draft.trim()); setDraft('') }
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
    // Conversations with agents sit among the people's, by when last said.
    const lastOf = (th: Thread) => [th.lastAt || '', th.latest ? stamp(th.latest) : ''].sort().pop() || ''
    const rows = [...(ai ? [ai] : []), ...[...people, ...agentConvos].sort((a, b) => ((b.unread || b.fresh) ? 1 : 0) - ((a.unread || a.fresh) ? 1 : 0) || lastOf(b).localeCompare(lastOf(a)))]
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
            const said = a ? `${a.lastBy === 'me' ? `${t('You')}: ` : ''}${a.last ? shownBody(a.last).text.replace(/\s+/g, ' ').slice(0, 120) : a.preview}` : th.latest ? titleOf(th.latest) : (th.app === 'ai' ? t('Tell your AI…') : th.kind === 'agent' ? `@${th.agent?.handle || ''}` : t('Say hello'))
            return (
              <li key={th.key}>
                <button type="button" className={`cl-dm${th.unread || th.fresh ? ' unread' : ''}`} onClick={() => choose(th.key)}>
                  {th.app === 'ai'
                    ? <span className="cl-dm-face app" aria-hidden="true"><img src="/icon.svg" alt="" width={40} height={40} /></span>
                    : th.kind === 'agent'
                    ? <AgentAvatar className="cl-dm-face agent" agent={th.agent} />
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
  const dmUnread = [...people, ...agentConvos].filter((th) => th.unread > 0 || th.fresh).length
  const phoneRoot = !wide && !current && !detail && !thread && !profile
  const tabOn = (which: 'home' | 'dms' | 'activity' | 'later') => (activityOpen ? 'activity' : laterOpen ? 'later' : phoneTab) === which
  const openLater = () => { forgetWanted(); setOpenKey(null); setActivityOpen(false); setThreadsOpen(false); setSentOpen(false); setLaterOpen(true); void loadLater() }
  const openThreads = () => { forgetWanted(); setOpenKey(null); setActivityOpen(false); setLaterOpen(false); setSentOpen(false); setThreadsOpen(true); void loadThreads() }
  const openSent = () => { forgetWanted(); setOpenKey(null); setActivityOpen(false); setLaterOpen(false); setThreadsOpen(false); setSentOpen(true); void loadSent() }
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
    <div className={`classic slk${current || special ? ' in-thread' : ''}${phoneRoot ? ' phone-root' : ''}${detail || thread || profile ? ' with-pane' : ''}${sideHidden ? ' side-hidden' : ''}${density === 'compact' ? ' compact' : ''}`} onClick={onMentionClick} onKeyDown={onMentionKey}>
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
            <li className={`cl-row cl-thread${threadsOpen ? ' on' : ''}${threadsUnread ? ' unread' : ''}`}>
              <button className="cl-open" onClick={openThreads} aria-current={threadsOpen ? 'true' : undefined} data-threads="1">
                <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="message" size={13} /></span>
                <span className="cl-title">{t('Threads')}</span>
                {threadsUnread > 0 && <span className="cl-badge">{threadsUnread}</span>}
              </button>
            </li>
            <li className={`cl-row cl-thread${laterOpen ? ' on' : ''}`}>
              <button className="cl-open" onClick={openLater} aria-current={laterOpen ? 'true' : undefined} data-later="1">
                <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="bookmark" size={13} /></span>
                <span className="cl-title">{t('Later')}</span>
                {(laterItems || []).length > 0 && <span className="cl-count">{laterItems!.length}</span>}
              </button>
            </li>
            <li className={`cl-row cl-thread${sentOpen ? ' on' : ''}`}>
              <button className="cl-open" onClick={openSent} aria-current={sentOpen ? 'true' : undefined} data-sent="1">
                <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="send" size={13} /></span>
                <span className="cl-title">{t('Drafts & sent')}</span>
                {draftCount > 0 && <span className="cl-count">{draftCount}</span>}
              </button>
            </li>
          </ul>
          {sidebarGroups.map((g) => (
            <React.Fragment key={g.id}>
              {/* Sections of your own are added just above Apps, which stays last. */}
              {g.id === 'apps' && (
                <button type="button" className="cl-add-section" onClick={() => { setSectionName(''); setAddingSection({}) }} data-add-section="1">
                  <Icon name="plus" size={13} /> {t('Add a section')}
                </button>
              )}
              {section(g.id, g.label, g.items, g.empty, g.action, g.below, g.reorder)}
            </React.Fragment>
          ))}
        </nav>
        </>}
      </aside>
      <main className={`slk-main${dropping ? ' slk-dropping' : ''}`}
        onDragOver={(e) => { if (current?.view && current.kind !== 'app' && !special && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false) }}
        onDrop={(e) => { setDropping(false); if (current?.view && current.kind !== 'app' && e.dataTransfer.files.length) { e.preventDefault(); uploads.add([...e.dataTransfer.files], current.view) } }}>
        {activityOpen ? activityView() : laterOpen ? laterView() : threadsOpen ? threadsView() : sentOpen ? sentView() : current ? conversation(current) : (
          <div className="slk-none"><p>{t('Pick a conversation.')}</p></div>
        )}
      </main>
      {phoneRoot && !special && (
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
          <button
            type="button"
            onClick={(e) => (onStatus ? onStatus(e.currentTarget) : onOpenScreen?.('profile'))}
            aria-haspopup={onStatus ? 'dialog' : undefined}
            aria-expanded={onStatus ? Boolean(statusOpen) : undefined}
            data-phone-tab="you"
          >
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
            {...actionsFor(channel, m, inThread)}
            onClose={() => setSheet(null)}
            onReact={(e) => react(channel, m, e)}
          />
        )
      })()}
      {forwarding && (
        <ForwardSheet
          message={forwarding.m}
          closed={isClosed(forwarding.channel)}
          places={everything.filter((x) => x.view && x.kind !== 'app' && x.kind !== 'agent' && x.view !== forwarding.channel).map((x) => ({ view: x.view!, name: x.name, kind: x.kind as 'channel' | 'person' | 'group', private: x.private }))}
          onClose={() => setForwarding(null)}
          onSend={(to, comment) => forwardTo(forwarding.channel, forwarding.m, to, comment)}
        />
      )}
      {starting === 'menu' && (
        <Sheet label={t('New')} onClose={() => setStarting(null)}>
          <div className="msheet-rows">
            <SheetRow icon="message" label={t('New message')} onClick={() => setStarting('people')} data="new-message" />
            <SheetRow icon="sparkle" label={t('Tell your AI')} hint={t('It becomes a card')} onClick={() => { setStarting(null); onCompose() }} data="tell-ai" />
            <SheetRow icon="hash" label={t('New channel')} onClick={() => { setStarting(null); setPhoneTab('home'); setAdding(true) }} data="new-channel" />
            {agents.length > 0 && <SheetRow icon="terminal" label={t('Talk to an agent')} onClick={() => { setStarting(null); setPhoneTab('home'); setFolded((p) => ({ ...p, agents: false })); setAgentPicking(true) }} data="talk-to-agent" />}
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
              <SheetRow icon="star" label={isStarred(th.view!) ? t('Unstar') : t('Star')} onClick={close(() => toggleStar(th.view!))} data="star" />
              <SheetRow icon="folder" label={t('Move to a section')} hint={sectionOf(th.view!)?.name} onClick={close(() => setMoveSheet(th.view!))} data="move" />
              <SheetRow icon="file" label={t('Canvas')} onClick={close(() => openSide({ kind: 'canvas' }))} data="canvas" />
              <SheetRow icon="book" label={t('Context')} onClick={close(() => openSide({ kind: 'journal' }))} data="context" />
              {th.kind === 'channel' && th.slug && onOpenRecord && <SheetRow icon="record" label={t('Record (Markdown)')} onClick={close(() => onOpenRecord())} data="record" />}
              <SheetRow icon="pin" label={t('Pinned messages')} onClick={close(() => void loadPins(th.view!))} data="pins" />
              {th.kind === 'channel' && <SheetRow icon="repeat" label={t('Automations')} hint={String(automationCount[th.view!] ?? 0)} onClick={close(() => openSide({ kind: 'details', tab: 'automations' }))} data="automations" />}
              {th.kind === 'channel' && th.slug && <SheetRow icon="settings" label={t('Channel settings')} onClick={close(() => { forgetWanted(); setSettings(true); setRenaming(null) })} data="settings" />}
              {th.private && <SheetRow icon="invite" label={t('Add people')} onClick={close(() => setAddingTo(th.view!))} data="add-people" />}
              {th.private && <SheetRow icon="x" label={t('Leave channel')} onClick={close(() => void leaveChannel(th))} danger data="leave" />}
            </div>
          </Sheet>
        )
      })()}
      {rowMenu && rowMenu.thread.view && (
        <RowMenu anchor={rowMenu.anchor} at={{ x: rowMenu.x, y: rowMenu.y }} label={rowMenu.thread.name} entries={rowMenuEntries(rowMenu.thread)} onClose={closeRowMenu} />
      )}
      {msgMenu && (() => {
        const { channel, m, inThread, x, y, anchor } = msgMenu
        return (
          <RowMenu at={{ x, y }} label={t('Message actions')} onClose={closeMsgMenu} entries={messageContextEntries(m, {
            ...actionsFor(channel, m, inThread), t,
            reactions: quickReactions, onReact: (e) => react(channel, m, e), onMoreReactions: () => setReactAt({ channel, m, x, y, anchor }),
          })} />
        )
      })()}
      {reactAt && (
        <EmojiPickerAt at={{ x: reactAt.x, y: reactAt.y }} onPick={(e) => react(reactAt.channel, reactAt.m, e)} onClose={closeReactAt} />
      )}
      {renameDialog && (
        <Dialog
          title={t('Rename channel')}
          lede={t('Everyone in the workspace sees the new name. Links to it keep working.')}
          className="cl-rename-dialog"
          onClose={() => setRenameDialog(null)}
          footer={(
            <>
              <button type="button" className="dlg-btn" onClick={() => setRenameDialog(null)}>{t('Cancel')}</button>
              <button type="button" className="dlg-btn primary" data-rename-save disabled={renameDialog.busy || !renameDialog.name.trim()} onClick={() => void saveRename()}>
                {renameDialog.busy ? t('Saving…') : t('Save')}
              </button>
            </>
          )}
        >
          <form onSubmit={(e) => { e.preventDefault(); void saveRename() }}>
            <label className="dlg-label" htmlFor="cl-rename-input">{t('Channel name')}</label>
            <input id="cl-rename-input" className="dlg-input" value={renameDialog.name} maxLength={120} autoFocus data-rename-input
              onChange={(e) => setRenameDialog({ ...renameDialog, name: e.target.value, error: null })} />
          </form>
          {renameDialog.error && <p className="dlg-error" role="alert">{renameDialog.error}</p>}
        </Dialog>
      )}
      {archiveDialog && (
        <Dialog
          title={t('Archive #{name}?', { name: archiveDialog.thread.name })}
          lede={t('archive.lede')}
          className="cl-archive-dialog"
          onClose={() => setArchiveDialog(null)}
          footer={(
            <>
              <button type="button" className="dlg-btn" onClick={() => setArchiveDialog(null)}>{t('Cancel')}</button>
              <button type="button" className="dlg-btn danger" data-archive-confirm disabled={archiveDialog.busy} onClick={() => void archiveChannel()}>
                {archiveDialog.busy ? t('Archiving…') : t('Archive')}
              </button>
            </>
          )}
        >
          {archiveDialog.error && <p className="dlg-error" role="alert">{archiveDialog.error}</p>}
        </Dialog>
      )}
      {deleting && (() => {
        const { m, busy, error } = deleting
        const others = Boolean(deleting.others) || othersReplied(m, myRef)
        const face = faceOfMessage(m)
        return (
          <Dialog
            title={t('Delete message')}
            lede={t(deleteWarning(m, myRef, others))}
            describedBy="cl-delete-preview"
            className="cl-delete-dialog"
            onClose={cancelDelete}
            footer={(
              <>
                <button type="button" className="dlg-btn" ref={deleteCancel} disabled={busy} onClick={cancelDelete}>{t('Cancel')}</button>
                <button type="button" className="dlg-btn danger" data-delete-confirm disabled={busy} onClick={() => void confirmDelete()}>
                  {busy ? t('Deleting…') : t('Delete')}
                </button>
              </>
            )}
          >
            <div id="cl-delete-preview" className="cl-delete-preview" data-delete-preview>
              <div className="cl-delete-meta">
                <Avatar name={face.name} url={face.url} size={24} />
                <b>{face.name}</b>
                <time dateTime={m.createdAt}>{fullTime(m.createdAt, locale)}</time>
              </div>
              {m.body && <div className="slk-text cl-delete-text">{rich(previewText(m.body))}</div>}
              {(m.files || []).length > 0 && (
                <div className="cl-delete-files"><Icon name="paperclip" size={12} /> {(m.files || []).map((f) => f.name).join(', ')}</div>
              )}
            </div>
            {/* A phone has no ⇧ to hold. */}
            {wide && !others && <p className="dlg-hint">{t('Tip: hold Shift when you delete to skip this question.')}</p>}
            {error && <p className="dlg-error" role="alert">{error}</p>}
          </Dialog>
        )
      })()}
      {moveSheet && (
        <Sheet label={t('Move to a section')} onClose={() => setMoveSheet(null)}>
          <p className="msheet-title">{t('Move to a section')}</p>
          <div className="msheet-rows">
            {layout.sections.map((x) => (
              <SheetRow key={x.id} icon="folder" label={x.name} hint={sectionOf(moveSheet)?.id === x.id ? '✓' : undefined} onClick={() => { moveTo(moveSheet, x.id); setMoveSheet(null) }} />
            ))}
            {sectionOf(moveSheet) && <SheetRow icon="x" label={t('Back to where it was')} onClick={() => { moveTo(moveSheet, null); setMoveSheet(null) }} />}
            <SheetRow icon="plus" label={t('New section…')} onClick={() => { const v = moveSheet; setMoveSheet(null); setSectionName(''); setAddingSection({ view: v }) }} />
          </div>
        </Sheet>
      )}
      {addingSection && (
        <Sheet label={t('New section')} onClose={() => setAddingSection(null)}>
          <p className="msheet-title">{t('New section')}</p>
          <form className="msheet-form" onSubmit={(e) => { e.preventDefault(); const n = sectionName.trim(); if (!n) return; newSection(n, addingSection.view); setAddingSection(null) }}>
            <label className="msheet-search">
              <input value={sectionName} onChange={(e) => setSectionName(e.target.value)} maxLength={40} placeholder={t('e.g. Clients, This week')} aria-label={t('Section name')} autoFocus data-section-name="1" />
            </label>
            <button type="submit" className="msheet-go" disabled={!sectionName.trim()} data-section-create="1">{t('Create')}</button>
          </form>
        </Sheet>
      )}
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
          {!profile.data ? (profile.failed
            ? <p className="slk-empty">{t("Couldn't load this profile.")} <button type="button" className="slk-link-button" onClick={() => void openProfile(profile.ref)}>{t('Try again')}</button></p>
            : <p className="slk-empty">{t('Loading…')}</p>) : (() => {
            const p = profile.data
            const local = localTime(p.timezone, Date.now(), locale)
            const status = statusShown(p.status, Date.now())
            const away = awayShown(p.awayUntil, Date.now())
            return (
              <div className="slk-profile-body">
                <div className="slk-profile-avatar" aria-hidden="true"><Avatar name={p.name} url={memberByRef(profile.ref)?.avatarUrl} size={96} /></div>
                <h3>{p.name}</h3>
                {p.handle && <p className="slk-profile-handle">@{p.handle}</p>}
                <p className="slk-profile-title">{t(p.title.charAt(0).toUpperCase() + p.title.slice(1))}</p>
                {status && <p className="slk-profile-status">{status.emoji} {status.text}</p>}
                {away && <p className="slk-profile-away">{t('Away until {when}', { when: new Date(away).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) })}</p>}
                {local && <p className="slk-profile-local"><Icon name="clock" size={13} /> {t('{time} local time', { time: local })}</p>}
                <dl className="slk-profile-stats">
                  <div><dt>{t('Waiting on them')}</dt><dd>{p.stats.waiting}</dd></div>
                  <div><dt>{t('Decided (90 days)')}</dt><dd>{p.stats.decided90d}</dd></div>
                  <div><dt>{t('Typical answer')}</dt><dd>{p.stats.medianMinutes === null ? '—' : p.stats.medianMinutes < 60 ? t('{n} min', { n: p.stats.medianMinutes }) : p.stats.medianMinutes < 1440 ? t('{n} h', { n: Math.round(p.stats.medianMinutes / 60) }) : t('{n} days', { n: Math.round(p.stats.medianMinutes / 1440) })}</dd></div>
                </dl>
                {!p.mine && (
                  <div className="slk-profile-actions">
                    <button type="button" className="slk-send" onClick={() => { const th = everything.find((x) => x.view === `dm:${profile.ref}`); if (th) choose(th.key); setProfile(null) }}>{t('Message')}</button>
                    <button type="button" className="slk-send ai" onClick={() => { const th = everything.find((x) => x.view === `dm:${profile.ref}`); if (th) { choose(th.key); setTimeout(() => composer.current?.focus(), 50) } setProfile(null) }}>{t('Ask for a decision')}</button>
                  </div>
                )}
              </div>
            )
          })()}
        </aside>
      )}
      {!detail && !thread && !profile && side && current?.view && (
        side.kind === 'canvas'
          ? (
            <ChannelCanvas
              api={api} headers={authHeaders} view={current.view}
              title={current.kind === 'channel' ? `#${current.name}` : current.name}
              onClose={() => setSide(null)}
            />
          )
          : side.kind === 'journal'
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
              onSettings={current.kind === 'channel' && current.slug ? () => { forgetWanted(); setSettings(true); setRenaming(null) } : null}
              onInvite={() => (current.private ? setAddingTo(current.view!) : setInviting('people'))}
              onProfile={(ref) => void openProfile(ref)}
              onlineRefs={onlineRefs}
              onJump={(id) => void goToCite(current.view!, { id, parentId: null, at: '' })}
              onCounts={(n) => setAutomationCount((prev) => ({ ...prev, [current.view!]: n.automations }))}
              onClose={() => setSide(null)}
            />
          )
      )}
      {!detail && thread && !(activityOpen && wide) && (
        <aside className="slk-pane slk-thread-pane" aria-label={t('Thread')}>
          <header className="slk-pane-head">
            <button className="slk-back pane" onClick={() => setThread(null)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
            <h2>{t('Thread')}</h2>
            {current && <span className="slk-pane-where">{current.kind === 'channel' ? `#${current.name}` : current.name}</span>}
            <button className="slk-pane-close" onClick={() => setThread(null)} aria-label={t('Close')}><Icon name="x" size={16} /></button>
          </header>
          {threadBody(thread)}
        </aside>
      )}
      {inviting && (
        <InviteDialog httpBase={api.httpBase} orgId={api.orgId} sessionToken={api.sessionToken} orgName={orgName} initialTab={inviting} onClose={() => setInviting(null)} />
      )}
      {popout && (() => {
        const m = memberByRef(popout.ref)
        const d = popout.data
        const dm = everything.find((x) => x.view === `dm:${popout.ref}`)
        const mine = d ? d.mine : Boolean(m?.mine)
        return (
          <ProfileCard
            person={{
              ref: popout.ref, name: d?.name || m?.name || popout.name || t('a teammate'), avatarUrl: m?.avatarUrl,
              handle: d ? d.handle : m?.handle, title: d?.title || m?.title, status: d ? d.status : m?.status,
              awayUntil: d ? d.awayUntil : m?.awayUntil, timezone: d?.timezone, mine,
            }}
            // You are here, though the relay never says so (byPresence).
            online={mine || isOnline(m, onlineKeys)}
            anchor={popout.anchor}
            // Their conversation, with nothing left over it: when it is already
            // the open one, choosing it again closes nothing, and a thread the
            // card was opened from would stay on top of the composer (on a
            // phone, of the whole conversation).
            onMessage={!mine && dm ? () => { setPopout(null); setThread(null); setDetailId(null); setProfile(null); choose(dm.key); setTimeout(() => composer.current?.focus(), 50) } : undefined}
            onFullProfile={() => { setPopout(null); void openProfile(popout.ref) }}
            onClose={() => setPopout(null)}
          />
        )
      })()}
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
