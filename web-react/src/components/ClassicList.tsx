Warning: truncated output (original token count: 107117)
Total output lines: 6635

import {appActivityReadFailed} from '../utils/appActivityStatus'
import {agentProgressLabel} from '../utils/agentProgress'
import {workspaceFileForThread} from '../utils/workspaceFileThread'
import {workspaceFileViewKey} from '../utils/workspaceFileView'
import {RoomFilesPanel} from './WorkspaceFilesPanel'
import {generationRetry,finishGenerationRetry} from '../utils/generationRetry'
import {AgentRunStatus} from './AgentRunStatus'
import {AgentToolTrace} from './AgentToolTrace'
import { useComposerThreadMode } from '../utils/useComposerThreadMode'
import { HarnessDictation } from './HarnessDictation'
import { HarnessComposerMenu } from './HarnessComposerMenu'
import {RoomVisual} from './RoomVisual'
import { receiveChannelActivity } from '../utils/channelActivity'
import {findRoomMessage} from '../utils/findRoomMessage'
import {HarnessRoomTools} from './HarnessRoomTools'
import {ReadPositions} from '../utils/readPositions'
import {RoomSettings} from './RoomSettings'
import { RoomMembers } from './RoomMembers'
import { ROOM_COLORS } from '../utils/roomColors'
import { RoomCreateDialog, type RoomCreateInput, type RoomPerson } from './RoomCreateDialog'
import { RoomJoinDialog } from './RoomJoinDialog'
import { ThreadReferences } from './ThreadReferences'
import { ThreadReferenceDialog } from './ThreadReferenceDialog'
import {useThreadPins} from '../utils/threadPins'
import { HarnessThreadHeader } from './HarnessThreadHeader'
import { RoomThreadDirectory } from './RoomThreadDirectory'
import { MessageAppCards } from './MessageAppCards'
import { MessageVisualText } from './MessageVisualization'
import { DraftSuggestion } from './DraftSuggestion'
import { resolveDraftSuggestion } from '../utils/draftSuggestion'
import { AppView } from '../screens/Harness'
import { harnessApi, type AppConversation } from '../utils/harness'
import { HarnessRoomResources } from './HarnessRoomResources'
import type { ThreadSnapshot } from '../utils/threadMessageCache'
import { channelMessageCache, mergeLatestMessages } from '../utils/channelMessageCache'
import { reconcileMessage } from '../utils/messageState'
import { ReadGuard } from '../utils/readGuard'
import { ReadWrites } from '../utils/readWrites'
import { toggleReaction } from '../utils/reactions'
import { useTranslationPreference } from '../utils/useTranslationPreference'
import { sameWords, wantsTranslation } from '../utils/translationRule'
import { FAILURE_LABEL, failureOf, translationFence, readTranslationBatch, matchesTranslation, keepTranslations, keptTranslation, translationBatches, translationKey, type TranslateFailure } from '../utils/translationCache'
import { ChannelCanvas } from './ChannelCanvas'
import { AgentAvatar } from './AgentAvatar'
import { BookmarksBar } from './BookmarksBar'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { awaitsPost } from '../utils/automation'
import { parseRoute, hashForMessage, hashForThread, hashForView, hashForApp } from '../utils/route'
import type {FileConversationRequest} from '../utils/fileConversation'
import { RowMenu } from './RowMenu'
import { SidebarSection } from './SidebarSection'
import { Dialog } from './Dialog'
import type { MenuEntry } from './RowMenu'
import type { DecisionCard, Business, ChannelMessage, FileRef, ReplyQuote } from '../types/card'
import { arrive, drawUnder, echoOf, isDoubleSend, isTemp, keepTemps, keptAsYours, keptUnsent, landedCopy, markFailed, markPending, outboxKey, provenYours, readUnsent, reconcile, refusedOutright, SEND_TIMEOUT, sendDeadline, sendTime, sharedOutboxKey, tempMessage, tempState, unsentAgain, withHeld } from '../utils/pendingSend'
import type { Unsent } from '../utils/pendingSend'
import { askingAboutData } from '../utils/authGuard'
import { draftToClear, withoutDraft } from '../utils/drafts'
import { getLocale } from '../utils/locale'
import { datedTime, fullTime } from '../utils/ago'
import { deleteWarning, messageIdOf, messageKeyAction, othersReplied, previewText, skipsDeleteConfirm } from '../utils/messageKeys'
import { displayName, properName } from '../utils/names'
import { Icon } from './Icon'
import { BrandLogo, isBrand } from './BrandLogo'
import { useBackStack } from '../utils/backStack'
import { countNewBelow, holdDelta, isAtBottom, isLooking, isNewSince, leavesGap, mergeById, reachesPast, seenWhileLooking, shouldFollow, waitToSay } from '../utils/chatScroll'
import { JumpToPresent, newBelowLabel } from './JumpToPresent'
import { FollowingLog } from './FollowingLog'
import { PaneResizer, PANE_MIN } from './PaneResizer'
import { useT } from '../utils/i18n'
import { useMembers, agentMentionables, agentsIn, mentionKind, mentionTarget } from '../utils/mentions'
import type { AgentFace } from '../utils/mentions'
import { meReader } from '../utils/mentionsMe'
import { useMentionMenu, useMentionHighlight } from './MentionMenu'
import { useCustomEmoji, loadCustomEmoji, customEmojiUrl } from '../utils/customEmoji'
import { messageContextEntries, messageMenuTriggers, type MessageMenuActions } from '../utils/messageMenu'
import { rememberEmoji, useQuickReactions } from '../utils/emojiSearch'
import { DailyReportDraft } from './DailyReport'
import { RecurringAutomationOffer } from './RecurringAutomationOffer'
import { MessageActions, CardActions, Reactions, EmojiPicker, EmojiPickerAt, EmojiGlyph, ComposerEmojiButton, FormatBar, bulletOnSpace, continueBlock, renderRich, LinkCards, SlashMenu, SchedulePicker, parseScheduleCommand, TypingLine, ReplyQuoteLine, ThreadReplyLine, ReplyingBar, UnsentNote } from './MessageParts'
import { heard as heardTyping, said, expire, nextExpiry as nextTypingExpiry, typistsIn, typedIn, stoppedIn, sendTyping } from '../utils/typing'
import type { Typist, TypingEvent, Outgoing as TypingOut, Place, Signal } from '../utils/typing'
import { quoteOf, refreshQuotes, withoutThread, displayedQuote, replySources, ReferenceReads, missingReplySource } from '../utils/replies'
import { ChannelJournal, ChannelDetails, JamButton, JamBar } from './ChannelPanes'
import type { DetailsTab, JournalCite, NotifyLevel } from './ChannelPanes'
import { JamCall } from '../utils/jam'
import { JamPanel } from './JamPanel'
import type { JamMode, JamState } from '../utils/jam'
import { InviteDialog } from './InviteDialog'
import { Avatar } from './Avatar'
import { ProfileCard } from './ProfileCard'
import { isOnline, statusShown, awayShown, nextExpiry, localTime } from '../utils/people'
import { Sheet, SheetRow, MessageSheet, PeoplePicker, ForwardSheet, longPress } from './Sheet'
import { PhoneDestinationComposer } from './PhoneDestinationComposer'
import { useUploads, PendingUploads, MessageFiles } from './Attachments'
import { configureMediaUrls } from '../utils/mediaUrls'
import { perfSample, serverTotal, configurePerfSamples } from '../utils/perfSamples'
import { playSound, setOpenView, rememberLevels, rememberLevel, startRing, stopRing } from '../utils/sound'
import { closeMessageNotifications, closeThreadNotifications } from '../utils/notifications'
import { hasOlder, olderThan } from '../utils/historyPage'
import { foldedRows, sectionBadge, visibleRows, stepRow, readFolds, writeFolds, withSectionFolds, withFold, unplacedAgents } from '../utils/sidebarSections'
import { SidebarEditQueue, trackSidebarQueue, retainSidebarQueue, takeSidebarQueue, currentSidebarSession, reorderExisting, reorderIncludingNew, type LayoutChange } from '../utils/sidebarSync'
import { SidebarSavedState } from './SidebarSavedState'
import { placesFrom } from '../utils/places'
import type { Place as Conversation } from '../utils/places'
import { useAppearance } from '../utils/appearance'
import { visibleOrder, step, foldedHome } from '../utils/sidebarOrder'
import type { SidebarGroup } from '../utils/sidebarOrder'
import { isMacPlatform, formatCombo, hasPrimaryMod, composing, enterKey, attachmentShortcut } from '../utils/keys'
import { formatDate } from '../utils/dateFormat'
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
  jamStates:Record<string,JamState>
  harness?: boolean
  newRequest?: number
  homeRequest?: number
  linkedFile?: {id:string;channel:string} | null
  linkedThreadId?: string | null
  sourceAppId?: string | null
  sourceAppSection?: 'data'
  sourceAppDraft?: string
  userId: string
  translationEnabled?: boolean | null
  translationPreferenceRevision?: number
  orgName: string
  pending: DecisionCard[]
  sent: DecisionCard[]
  decided: DecisionCard[]
  businesses: Business[]
  presence: Presence
  onOpen: (cardId: string) => void
  onNudge: (cardId: string) => void
  /// Decide a card where it is shown, the way a chat app's buttons do.
  onDecide: (cardId: string, action: string, options?: { optionId?: string; replyText?: string; note?: string }) => void
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
  onApps?: (id?: string) => void
  onWorkflow?: (id?: string) => void
  /// The workspace's mark, name and switcher, drawn by the shell.
  workspaceMenu?: React.ReactNode
  /// Channels are the team's businesses: made, renamed and deleted here,
  /// the way a chat client lets you. Each returns what went wrong, if
  /// anything, as a sentence.
  onCreateRoom?: (input: RoomCreateInput) => Promise<{slug:string}>
  onCreateChannel: (name: string, opts?: { private?: boolean }) => Promise<string | null>
  onRenameChannel: (slug: string, name: string) => Promise<string | null>
  onDeleteChannel: (slug: string) => Promise<string | null>
  /// Another screen: the team to invite, tools to connect, you.
  onOpenAgentProfile?: (id: string) => void
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
  managed?: boolean
  visualVersion?: number
  color?: string
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
interface Activity { channel: string; lastAt: string; preview: string; originalPreview?: string; lastBy: string | null; last?: ChannelMessage }
/// One of the team's agents answering somewhere.
interface AgentWriting { id: string; name: string; emoji: string | null; avatarUrl?: string | null; parentId: string | null; at?: number; activity?: {kind:'reply'|'thinking'|'tool'|'plan';title:string;status?:'pending'|'in_progress'|'completed'|'failed';steps?:Array<{title:string;status:'pending'|'in_progress'|'completed'}>} }
/// Whose face goes beside something: a name, and their photo if they have one.
/// `emoji`: an agent's face — a tile, not a person's photo.
interface Face { name: string; url?: string | null; emoji?: string | null; picture?: string | null }
/// How many of each list are read ahead in the background, and how they
/// are spaced: after the screen has settled, one at a time.
const AHEAD_COUNT = 3
const AHEAD_DELAY_MS = 1500
const AHEAD_GAP_MS = 400
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
interface ActivityItem { app?: {id:string;name:string;tableId?:string;rowId?:string}; key?: string; type: 'mention' | 'reply' | 'reaction' | 'keyword'; message: ChannelMessage; unread: boolean; at?: string; emoji?: string; by?: string | null; byAvatar?: string | null; keyword?: string }

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
/// Where the thread pane's dragged width is kept, for every workspace.
const THREAD_WIDTH_KEY = 'honmaru:threadWidth'
const isWide = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches

function clock(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  return formatDate(t, getLocale(), { hour: 'numeric', minute: '2-digit' })
}

/// The newest activity on a row, as a chat client shows it: the time today,
/// the date before that.
function when(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString()
    ? clock(iso)
    : formatDate(d, getLocale(), { month: 'short', day: 'numeric' })
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
  linkedFile = null, jamStates, harness = false, newRequest = 0, homeRequest = 0, sourceAppId = null, sourceAppSection, sourceAppDraft, linkedThreadId = null, userId, translationEnabled = null, translationPreferenceRevision = 0, orgName, pending, sent, decided, businesses, presence,
  onOpen, onNudge, onDecide, api, onSearch, onCompose, onTellAI, onDeleteCard, onViewChange, onOpenRecord, onImmersive, renderCard, onWorkspace, onApps, onWorkflow, workspaceMenu,
  onCreateRoom, onCreateChannel, onRenameChannel, onDeleteChannel, onOpenScreen, onOpenAgentProfile, onPlaces, onStatus, statusOpen, active = true,
}) => {
  // Keep drafts mounted beneath shell overlays, but remove covered controls
  // from keyboard navigation and the accessibility tree (React 18 DOM ref).
  const interactionRoot = useCallback((node: HTMLDivElement | null) => { node?.toggleAttribute('inert', !active) }, [active])
  // Files' addresses are renewed for the workspace open now (mediaUrls).
  useEffect(() => { configureMediaUrls(api) }, [api.httpBase, api.orgId, api.sessionToken])
  useEffect(() => { configurePerfSamples({ httpBase: api.httpBase, sessionToken: api.sessionToken }) }, [api.httpBase, api.sessionToken])
  const threadPins = useThreadPins(api,harness)
  const t = useT()
  // Cozy or compact, as chosen on You: the stylesheet does the rest.
  const { density } = useAppearance()
  const [harnessFilter, setHarnessFilter] = useState<'home' | 'recent' | 'unread' | 'mentions'>('home')
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
  const [prefs, setPrefs] = useState<Record<string, 'all' | 'mentions' | 'mute'>>({})
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
  const readPositions=useMemo(()=>new ReadPositions(),[api.httpBase,api.orgId,api.sessionToken])
  const acceptReadPosition=(v:string,at:string,version?:number)=>{
    if(!readPositions.accept(v,at,version))return false
    try{localStorage.setItem(seenKey(api.orgId,v),at)}catch{}
    setServerReads(previous=>({...previous,[v]:at}));setSeenTick(n=>n+1);return true
  }
  const readAt = (v: string) => [seenAt(api.orgId, v), serverReads[v] || ''].sort().pop() || ''
  const referenceReads = useRef(new ReferenceReads())
  const referenceUpdates = useRef(referenceReads.current.sources)
  const referenceIdentity = JSON.stringify([api.httpBase, api.orgId, api.sessionToken, userId])
  const referenceIdentityRef = useRef(referenceIdentity)
  if (referenceIdentityRef.current !== referenceIdentity) {
    referenceReads.current.reset()
    referenceIdentityRef.current = referenceIdentity
  }
  const referenceRead = () => {
    const before = referenceReads.current.begin()
    const identity = referenceIdentityRef.current
    const accountCurrent = translationFence()
    return (list: ChannelMessage[]) => {
      if (accountCurrent() && referenceIdentityRef.current === identity) referenceReads.current.apply(before, list)
    }
  }
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
  // Preserve the user's operations until an atomic versioned save succeeds.
  const sidebarSync = useRef<SidebarEditQueue<SidebarLayout> | null>(null)
  const [sidebarReady, setSidebarReady] = useState(false)
  const [sidebarPending, setSidebarPending] = useState(false)
  const [sidebarUncertain, setSidebarUncertain] = useState(false)
  const [sidebarRemote, setSidebarRemote] = useState<SidebarLayout | null>(null)
  const [sidebarChecking, setSidebarChecking] = useState(false)
  const sidebarSessionIsCurrent = () => {
    try { return currentSidebarSession(localStorage, api.httpBase, api.sessionToken, userId) } catch { return false }
  }
  const [sidebarCheckError, setSidebarCheckError] = useState(false)
  const layoutNow = useRef(layout)
  layoutNow.current = layout
  // Which sections are folded: remembered by this browser for the
  // workspace, and your own sections' on the server with the rest of it.
  const [folded, setFolded] = useState<Record<string, boolean>>(() => readFolds(api.orgId))
  useEffect(() => { writeFolds(api.orgId, folded) }, [api.orgId, folded])
  useEffect(() => {
    const initial: SidebarLayout = { starred: [], sections: [] }
    const queueKey = JSON.stringify([api.httpBase, api.sessionToken, userId, api.orgId])
    const controller = new AbortController()
    const show = (next: SidebarLayout, ready: boolean, pending: boolean) => {
      if (sidebarSync.current !== sync) return
      layoutNow.current = next
      setLayout(next)
      if (ready) setFolded((prev) => withSectionFolds(prev, next.sections || []))
      setSidebarReady(ready)
      setSidebarPending(pending)
    }
    const failed = (uncertain: boolean) => { if (sidebarSync.current === sync) {
      if (uncertain) {
        setSidebarUncertain(true)
        setProblem(locale === 'ja' ? 'サイドバーの保存結果を確認できません。会話一覧の「保存状態を確認」を開いてください。' : 'The sidebar save could not be confirmed. Open “Check saved sidebar” in the conversation list.')
      } else setProblem(t('That did not save.'))
    } }
    const retained = takeSidebarQueue<SidebarLayout>(queueKey)
    const sync = sidebarSync.current = retained || new SidebarEditQueue<SidebarLayout>(initial,
      async () => {
        const response = await fetch(`${api.httpBase}/channels/sidebar?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders, signal: controller.signal })
        if (!response.ok) throw new Error('Sidebar could not be read.')
        const data = await response.json()
        if (!data?.sidebar) throw new Error('Sidebar response is incomplete.')
        return data
      },
      async (sidebar, version) => {
        const response = await fetch(`${api.httpBase}/channels/sidebar`, {
          method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ orgId: api.orgId, sidebar, ...(version !== undefined ? {version} : {}) }),
        })
        const data = await response.json()
        if ((!response.ok && response.status !== 409) || !data?.sidebar) throw new Error('Sidebar could not be saved.')
        return {conflict: response.status === 409, snapshot: data}
      },
      show, failed, () => controller.abort(), controller.signal,
      sidebarSessionIsCurrent)
    trackSidebarQueue(sync, queueKey)
    setSidebarReady(false)
    setSidebarPending(false)
    setSidebarUncertain(false)
    setSidebarRemote(null)
    setSidebarCheckError(false)
    layoutNow.current = initial
    setLayout(initial)
    if (retained) sync.attach(show, failed)
    void sync.retry()
    const retry = () => { if (document.visibilityState === 'visible') void sync.retry() }
    window.addEventListener('focus', retry)
    window.addEventListener('online', retry)
    document.addEventListener('visibilitychange', retry)
    return () => { retainSidebarQueue(queueKey, sync); window.removeEventListener('focus', retry); window.removeEventListener('online', retry); document.removeEventListener('visibilitychange', retry) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.httpBase, api.orgId, userId, authHeaders])
  /// A change to your sidebar, as what it does to it: shown at once, and
  /// saved on top of the saved layout even when made before that arrived.
  const saveLayout = (change: LayoutChange<SidebarLayout>) => {
    const sync = sidebarSync.current
    if (!sync) return
    const { before, next } = sync.change(change)
    // An agent nothing has been said to yet is listed only for being
    // starred or in a section. Unstarred, or put back where it was, it
    // stays listed among the agents: open, it must not vanish from under you.
    const freed = unplacedAgents(before, next)
    if (freed.length) setStartedAgents((prev) => [...prev, ...freed.filter((id) => !prev.includes(id))])
  }
  const isStarred = (view: string) => layout.starred.includes(view)
  const checkSavedSidebar = async () => {
    const sync = sidebarSync.current
    if (!sync || sync.isCancelled() || !sidebarSessionIsCurrent()) return
    setSidebarChecking(true); setSidebarCheckError(false)
    try {
      const response = await fetch(`${api.httpBase}/channels/sidebar?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders, signal: sync.requestSignal() })
      if (!response.ok) throw new Error('Sidebar could not be read.')
      const data = await response.json()
      if (!data?.sidebar) throw new Error('Sidebar response is incomplete.')
      if (sidebarSync.current === sync && !sync.isCancelled() && sidebarSessionIsCurrent()) setSidebarRemote(data.sidebar)
    } catch { if (sidebarSync.current === sync && !sync.isCancelled()) setSidebarCheckError(true) }
    finally { if (sidebarSync.current === sync && !sync.isCancelled()) setSidebarChecking(false) }
  }
  const adoptSavedSidebar = async () => {
    const prompt = locale === 'ja'
      ? '保留中のサイドバー変更を破棄し、現在サーバーに保存されている状態を使います。よろしいですか？'
      : 'Discard the pending sidebar changes and use the state currently saved on the server?'
    if (!window.confirm(prompt)) return
    const sync = sidebarSync.current
    if (!sync || sync.isCancelled() || !sidebarSessionIsCurrent()) return
    setSidebarChecking(true); setSidebarCheckError(false)
    try {
      const response = await fetch(`${api.httpBase}/channels/sidebar?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders, signal: sync.requestSignal() })
      if (!response.ok) throw new Error('Sidebar could not be read.')
      const data = await response.json()
      if (!data?.sidebar || sidebarSync.current !== sync || !sync.adopt(data)) throw new Error('Sidebar changed.')
      setSidebarUncertain(false); setSidebarRemote(null)
      setProblem((before) => before === (locale === 'ja' ? 'サイドバーの保存結果を確認できません。会話一覧の「保存状態を確認」を開いてください。' : 'The sidebar save could not be confirmed. Open “Check saved sidebar” in the conversation list.') ? null : before)
    } catch { if (sidebarSync.current === sync && !sync.isCancelled()) setSidebarCheckError(true) }
    finally { if (sidebarSync.current === sync && !sync.isCancelled()) setSidebarChecking(false) }
  }
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
  // Star or unstar as the person sees it now, whatever the saved layout says.
  const toggleStar = (view: string) => {
    const starring = !isStarred(view)
    saveLayout((base) => ({ ...base, starred: starring ? [...base.starred.filter((v) => v !== view), view] : base.starred.filter((v) => v !== view) }))
  }
  const sectionOf = (view: string) => layout.sections.find((x) => x.views.includes(view)) || null
  /// Into one of your sections (or back where it came from, with null).
  const moveTo = (view: string, sectionId: string | null) => saveLayout((layout) => ({
    ...layout,
    // A conversation has one place in the sidebar. Moving a starred item
    // into a personal section must unstar it too; otherwise the section
    // renderer hides it as a duplicate and leaves the destination empty.
    ...(sectionId && !layout.sections.some((section) => section.id === sectionId) ? {} : {
      starred: layout.starred.filter((v) => v !== view),
      sections: layout.sections.map((x) => ({ ...x, views: x.id === sectionId ? [...x.views.filter((v) => v !== view), view] : x.views.filter((v) => v !== view) })),
    }),
  }))
  const newSection = (name: string, view?: string) => {
    const id = Math.random().toString(36).slice(2, 10)
    saveLayout((layout) => layout.sections.some((section) => section.id === id) ? layout : ({
      ...layout,
      starred: view ? layout.starred.filter((v) => v !== view) : layout.starred,
      sections: [...layout.sections.map((x) => ({ ...x, views: view ? x.views.filter((v) => v !== view) : x.views })), { id, name, views: view ? [view] : [] }],
    }))
  }
  /// Fold a section, or open it again. One of your own is saved folded on
  /// the server too, so the phone and the laptop agree — that flag and
  /// nothing else. A fold is a casual click, and this window may have been
  /// open since the morning: it must not save the stars and sections as it
  /// remembers them over what another window or the phone did since.
  const toggleFold = (id: string) => {
    const shut = !folded[id]
    const own = layout.sections.find((x) => `sec:${x.id}` === id)
    if (!own) { setFolded((p) => ({ ...p, [id]: shut })); return }
    // Here too, so the next star or move says the fold as it now is.
    saveLayout((now) => ({ ...now, sections: withFold(now.sections, own.id, shut) }))
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
        const accepted=readPositions.snapshot(data.reads||{},data.readVersions||{})
        for(const [v,at] of Object.entries(accepted)){try{localStorage.setItem(seenKey(api.orgId,v),at)}catch{}}
        setServerReads(previous=>({...previous,...accepted}));setSeenTick(n=>n+1)
        prefsFor.current = api.orgId
        setPrefs(data.prefs || {})
        if (Array.isArray(data.agents)) setAgents(data.agents)
      })
      .catch(() => { /* the list still shows every decision */ })
    return () => { ignore = true }
  }, [api.httpBase, api.orgId, authHeaders, channelsTick, translationEnabled, translationPreferenceRevision])
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
        return build('channel', `channel:${slug}`, nameOfBusiness(slug), { slug, view: `b:${slug}`, private: Boolean(b?.private), memberCount: b?.memberCount, managed: b?.managed, color: b?.color, visualVersion: b?.visualVersion }, bySlug.get(slug) || [], true)
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
  const phoneDraftDestinations = useMemo(() => everything.filter((item) => Boolean(item.view) && item.kind !== 'app').map((item) => ({ key: item.key, view: item.view!, name: item.name, kind: item.kind })), [everything])

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
  // The thread pane's width, as the reader dragged it: kept in this
  // browser, and the layout's own width until it is dragged.
  const threadPane = useRef<HTMLElement>(null)
  const [threadWidth, setThreadWidth] = useState<number | null>(() => {
    try {
      const n = Number(localStorage.getItem(THREAD_WIDTH_KEY))
      return Number.isFinite(n) && n >= PANE_MIN ? n : null
    } catch { return null }
  })
  const keepThreadWidth = (w: number | null) => {
    setThreadWidth(w)
    try { if (w === null) localStorage.removeItem(THREAD_WIDTH_KEY); else localStorage.setItem(THREAD_WIDTH_KEY, String(w)) } catch { /* kept for this visit only */ }
  }
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
  const sourceIntent = useRef(0)
  const sourceRoute = useRef<string|null>(null)
  const pendingSource = useRef<{appId:string;section?:'data';draft?:string;source:NonNullable<AppConversation['source']>}|null>(null)
  const linkedIntent = useRef(0)
  const linkedRoute = useRef<string|null>(null)
  const localThreadRoute = useRef<{hash:string;client:unknown}|null>(null)
  const pendingLinkedThread = useRef<{view:string;id:string}|null>(null)
  const forgetWanted = () => {
    linkedIntent.current++;pendingLinkedThread.current=null;localThreadRoute.current=null
    if(linkedRoute.current && location.hash===linkedRoute.current){history.replaceState(history.state,'','#/list');window.dispatchEvent(new HashChangeEvent('hashchange'))}
    linkedRoute.current=null
    wantedView.current=null;sourceIntent.current++;pendingSource.current=null
    if(sourceRoute.current && location.hash===sourceRoute.current){history.replaceState(history.state,'','#/list');window.dispatchEvent(new HashChangeEvent('hashchange'))}
    sourceRoute.current=null
  }
  // A conversation opened by hand, until the shell has been told. The one
  // the list puts up by itself — on a laptop, the first with something
  // waiting — is not somewhere you went, and ⌘K does not remember it.
  const chosenKey = useRef<string | null>(null)
  const choose = (key: string | null, keepSource = false) => {
    if(keepSource)wantedView.current=null;else forgetWanted()
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
  // Inviting from a channel: a guest of that channel alone, to begin with.
  const [inviteTo, setInviteTo] = useState<{ slug: string; name: string } | null>(null)
  const inviteGuest = (th: { slug?: string; name: string }) => { if (!th.slug) return; setInviteTo({ slug: th.slug, name: th.name }); setInviting('people') }
  // On a phone the list is five places along the bottom, as in Slack's app:
  // Home and DMs here, Activity and Later below, You is a screen of its own.
  const [phoneTab, setPhoneTab] = useState<'home' | 'dms'>('home')
  // The round button's choices, and the people picker behind "New message".
  const [starting, setStarting] = useState<null | 'menu' | 'people'>(null)
  const [phoneDraftComposer, setPhoneDraftComposer] = useState(false)
  useEffect(() => { if (harness && newRequest) setStarting('menu') }, [harness, newRequest])
  useEffect(() => { if (harness && homeRequest) { choose(null); setHarnessFilter('home') } }, [harness, homeRequest])
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
    const readReferences = referenceRead()
    return fetch(`${api.httpBase}/channels/sent?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) { readReferences(data.items || []); views.set('sent', data.items || []); setSentItems(data.items || []) } })
      .catch(() => { /* the list stays as it was */ })
  }, [api.httpBase, api.orgId, authHeaders, views])
  const [threadItems, setThreadItems] = useState<ThreadItem[] | null>(() => views.get<ThreadItem[]>('threads') ?? null)
  useEffect(() => { if (threadItems) views.set('threads', threadItems, { read: false }) }, [threadItems, views])
  const loadThreads = useCallback(() => {
    const ticket = readGuard.ask('threads')
    const readReferences = referenceRead()
    return fetch(`${api.httpBase}/channels/threads?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !readGuard.fresh('threads', ticket)) return
        const list = readGuard.threadList<ThreadItem>(data.threads || [])
        readReferences(list.flatMap(x => [x.parent, ...x.replies]))
        views.set('threads', list); setThreadItems(list)
      })
      .catch(() => { /* the list stays as it was */ })
  }, [api.httpBase, api.orgId, authHeaders, views])
  useEffect(() => { void loadThreads() }, [loadThreads])
  const threadsUnread = (threadItems || []).filter((x) => x.unread).length
  /// Threads read up to a point, wherever that was done: each one whose
  /// newest reply is no later is no longer new.
  const threadsReadTo = useCallback((read: Array<{ thread: string; lastReadAt: string; readVersion?:number }>) => {
    read=read.filter(r=>readPositions.accept(`t:${r.thread}`,r.lastReadAt,r.readVersion))
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
  }, [readPositions])
  /// A thread marked unread from one of its replies, here or elsewhere: new
  /// again in Threads at once, and a list fetched before then, or this
  /// device's own earlier read, does not take that back.
  const threadUnreadFrom = (parentId: string, at: string) => {
    readGuard.unreadThread(parentId, at)
    setThreadItems((prev) => prev && prev.map((x) => (x.parent.id === parentId && x.lastReplyAt > at ? { ...x, unread: true } : x)))
    void loadThreads()
  }
  const [activityItems, setActivityItems] = useState<ActivityItem[] | null>(() => views.get<ActivityItem[]>('activity') ?? null)
  useEffect(() => { if (activityItems) views.set('activity', activityItems, { read: false }) }, [activityItems, views])
  // What the Unread tab showed when you came to it stays in the list while
  // you are there, however many of them you have looked at since.
  const [unreadShown, setUnreadShown] = useState<Set<string>>(() => new Set())
  const [activityTab, setActivityTab] = useState<'all' | 'unread' | 'mentions'>('all')
  const [activityPick, setActivityPick] = useState<string | null>(null)
  const [appActivityUnavailable, setAppActivityUnavailable] = useState(false)
  const loadActivity = useCallback(() => {
    const ticket = readGuard.ask('activity')
    const readReferences = referenceRead()
    return fetch(`${api.httpBase}/channels/activity?orgId=${encodeURIComponent(api.orgId)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !readGuard.fresh('activity', ticket)) return
        setAppActivityUnavailable(data.appActivityUnavailable === true)
        const list = readGuard.activity<ActivityItem>(data.items || [], activityKey)
        readReferences(list.map(x => x.message))
        views.set('activity', list); setActivityItems(list)
      })
      .catch(() => { /* nothing new is the same as nothing loaded */ })
  }, [api.httpBase, api.orgId, authHeaders, views])
  useEffect(() => { void loadActivity(); const refresh=()=>{void loadActivity()}; window.addEventListener('honmaru:app-activity-changed',refresh);return()=>window.removeEventListener('honmaru:app-activity-changed',refresh) }, [loadActivity])
  const stillNew = (i: ActivityItem) => i.unread
  const activityKey = (i: ActivityItem) => i.key || `${i.type}-${i.message.id}-${i.emoji || ''}-${i.at || ''}`
  // Looked at is read: here at once, and on the server for every other
  // device, which hears it and takes it down too.
  const markActivitySeen = useCallback((keys: string[]) => {
    const fresh = new Set(keys.filter(key => !key.startsWith('a:')))
    if (!keys.length) return
    readGuard.readItems(fresh)
    setActivityItems((prev) => prev && prev.map((i) => (i.unread && fresh.has(activityKey(i)) ? { ...i, unread: false } : i)))
    const serverKeys = keys.filter((k) => /^(m|r|a):/.test(k))
    if (!serverKeys.length) return
    closeMessageNotifications(messageIdsOf(serverKeys))
    void fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: 'activity', items: serverKeys }),
    }).then((r) => (r.ok ? r.json() : null))
      // A reply looked at here is read in its thread too: Threads agrees.
      .then((d) => {
        if (Array.isArray(d?.threads)) threadsReadTo(d.threads)
        const acknowledged = new Set<string>((d?.items || []).filter((key: string) => key.startsWith('a:')))
        readGuard.readItems(acknowledged)
        setActivityItems((prev) => prev && prev.map((i) => acknowledged.has(activityKey(i)) ? { ...i, unread: false } : i))
        if (appActivityReadFailed(keys, d)) setAppActivityUnavailable(true)
      })
      .catch(() => { if (appActivityReadFailed(keys, null)) setAppActivityUnavailable(true) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.httpBase, api.orgId, authHeaders])
  const activityUnread = (activityItems || []).filter(stillNew).length
  /// Activity's "Mark all as read": every item new now is looked at, and the
  /// threads its replies are in are read up to them.
  const markAllActivityRead = () => {
    const keys = (activityItems || []).filter((i) => i.unread).map(activityKey)
    if (!keys.length) return
    const ordinary = keys.filter(key => !key.startsWith('a:'))
    readGuard.readItems(ordinary)
    setActivityItems((prev) => prev && prev.map((i) => (i.unread && !activityKey(i).startsWith('a:') ? { ...i, unread: false } : i)))
    closeMessageNotifications(messageIdsOf(keys))
    void fetch(`${api.httpBase}/channels/read`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: 'activity' }),
    }).then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.threads)) threadsReadTo(d.threads)
        const acknowledged = new Set<string>((d?.items || []).filter((key: string) => key.startsWith('a:')))
        readGuard.readItems(acknowledged)
        setActivityItems((prev) => prev && prev.map((i) => acknowledged.has(activityKey(i)) ? { ...i, unread: false } : i))
        if (appActivityReadFailed(keys, d)) setAppActivityUnavailable(true)
      })
      .catch(() => { if (appActivityReadFailed(keys, null)) setAppActivityUnavailable(true); void loadActivity() })
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
    // In the desktop app the page always reports itself visible, so it is
    // the window being in front with somebody at it that counts.
    const rows = seenWhileLooking({ wait: 900, looking: () => isLooking(document), seen: (key) => markActivitySeen([key]) })
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.key
        if (key) rows.view(key, e.isIntersecting && e.intersectionRatio >= 0.6)
      }
    }, { root, threshold: [0, 0.6, 1] })
    root.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => io.observe(el))
    const look = () => rows.attention()
    // Focus going into a frame on the page blurs the window before the
    // frame has it; asked a moment later, the page still has focus.
    const blurred = () => { setTimeout(look, 0) }
    document.addEventListener('visibilitychange', look)
    window.addEventListener('focus', look)
    window.addEventListener('blur', blurred)
    return () => {
      io.disconnect(); rows.end()
      document.removeEventListener('visibilitychange', look)
      window.removeEventListener('focus', look)
      window.removeEventListener('blur', blurred)
    }
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
  const roomCreationScope=useRef(0)
  useEffect(()=>{roomCreationScope.current++;return()=>{roomCreationScope.current++}},[api.orgId,api.httpBase,api.sessionToken])
  const [creatingRoom, setCreatingRoom] = useState(false)
  const [requestableRoomAgents,setRequestableRoomAgents]=useState<Array<{id:string;name:string;avatarUrl?:string|null;accessRequestStatus:'none'|'pending'}>>([])
  const [addableRoomAgents,setAddableRoomAgents]=useState<Array<{id:string;name:string;avatarUrl?:string|null;missingAccessMembers:Array<{ref:string;name:string}>;canGrantAccess:boolean;externalRuntime?:boolean}>>([])
  const [joiningRoom, setJoiningRoom] = useState(false)
  const [roomMembersView,setRoomMembersView]=useState<string|null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPrivate, setNewPrivate] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The channel's own controls, behind ⋯ — as in a chat client, not in the way.
  const [settings, setSettings] = useState(false)

  const refreshRequestableRoomAgents=useCallback(async()=>{
    const response=await fetch(`${api.httpBase}/hx/agent-access-options?${new URLSearchParams({orgId:api.orgId})}`,{headers:authHeaders})
    const result=await response.json().catch(()=>({}))
    if(!response.ok)throw Error(result.message||'Agent access options did not load.')
    if(Array.isArray(result.agents))setRequestableRoomAgents(result.agents)
    if(Array.isArray(result.addableAgents))setAddableRoomAgents(result.addableAgents)
    window.dispatchEvent(new Event('honmaru:agents-changed'))
  },[api.httpBase,api.orgId,authHeaders])
  useEffect(()=>{
    if(!harness||!creatingRoom){setRequestableRoomAgents([]);setAddableRoomAgents([]);return}
    let active=true
    void fetch(`${api.httpBase}/hx/agent-access-options?${new URLSearchParams({orgId:api.orgId})}`,{headers:authHeaders})
      .then(async response=>{const result=await response.json().catch(()=>({}));if(!response.ok)throw Error(result.message||'Agent access options did not load.');return result})
      .then(result=>{if(active&&Array.isArray(result.agents))setRequestableRoomAgents(result.agents);if(active&&Array.isArray(result.addableAgents))setAddableRoomAgents(result.addableAgents)})
      .catch(()=>{if(active){setRequestableRoomAgents([]);setAddableRoomAgents([])}})
    return()=>{active=false}
  },[harness,creatingRoom,api.httpBase,api.orgId,authHeaders])
  useEffect(()=>{
    if(!harness||!creatingRoom||!requestableRoomAgents.some(agent=>agent.accessRequestStatus==='pending'))return
    const timer=window.setInterval(()=>{void refreshRequestableRoomAgents().catch(()=>{})},15000)
    return()=>window.clearInterval(timer)
  },[harness,creatingRoom,requestableRoomAgents,refreshRequestableRoomAgents])
  const requestRoomAgentAccess=useCallback(async(agent:RoomPerson)=>{
    const response=await fetch(`${api.httpBase}/hx/agents/${encodeURIComponent(agent.id)}/access-request`,{method:'POST',headers:{...authHeaders,'content-type':'application/json'},body:JSON.stringify({orgId:api.orgId,requestKey:crypto.randomUUID()})})
    const result=await response.json().catch(()=>({}))
    if(!response.ok)throw Error(result.message||'That access request did not send.')
    await refreshRequestableRoomAgents()
  },[api.httpBase,api.orgId,authHeaders,refreshRequestableRoomAgents])

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
    // The room update can remove the channel before the DELETE reply arrives.
    // Do not close another conversation the person opened in that interval.
    if (chosenKey.current === thread.key) choose(null)
  }


  const setPref = async (v: string, level: NotifyLevel) => {
    const res = await fetch(`${api.httpBase}/channels/prefs`, { method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: api.orgId, channel: v, level }) }).catch(() => null)
    if (!res?.ok) { setProblem(t('That did not save.')); return }
    // For the sound and the notification decided at the socket, at once —
    // also when the list's own load has not come back (or failed).
    rememberLevel(api.orgId, v, level)
    setPrefs((prev) => { const next = { ...prev }; if (level === 'default') delete next[v]; else next[v] = level; return next })
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
    if(harness&&th.managed&&tab==='members'){setRoomMembersView(th.view!);return}
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
    const level = (prefs[v] || 'default') as NotifyLevel
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
      ...layout.sections.map((x) => ({ kind: 'item' as const, label: x.name, identity: `section:${x.id}`, checked: here?.id === x.id, onSelect: () => moveTo(v, x.id), data: `move-to:${x.name}` })),
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
      { kind: 'item', label: t('Mentions, replies and a sound for posts'), checked: level === 'default', onSelect: () => void setPref(v, 'default'), data: 'notify-default' },
      { kind: 'item', label: t('Every post, on the phone too'), checked: level === 'all', onSelect: () => void setPref(v, 'all'), data: 'notify-all' },
      { kind: 'item', label: t('Just mentions'), checked: level === 'mentions', onSelect: () => void setPref(v, 'mentions'), data: 'notify-mentions' },
      { kind: 'item', label: t('Mute'), checked: level === 'mute', onSelect: () => void setPref(v, 'mute'), data: 'notify-mute' },
    )
    if (isChannel && th.slug) {
      out.push({ kind: 'sep' })
      out.push({ kind: 'item', label: t('Rename channel…'), icon: 'edit', onSelect: () => setRenameDialog({ slug: th.slug!, name: th.name }), data: 'rename' })
      if (th.private) out.push({ kind: 'item', label: t('Add people…'), icon: 'invite', onSelect: () => setAddingTo(v), data: 'add-people' })
      out.push({ kind: 'item', label: t('Invite a guest to this channel…'), icon: 'invite', onSelect: () => inviteGuest(th), data: 'invite-guest' })
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
    if (!enterKey(e) && e.key !== ' ') return
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
      if (harness) return <span className={`cl-lead cl-hash sz-${size}`} style={{color: ROOM_COLORS[thread.color as keyof typeof ROOM_COLORS] || ROOM_COLORS.teal}} aria-hidden="true"><RoomVisual api={api} channel={thread.view||''} version={thread.visualVersion} fallback={<Icon name={thread.private ? 'room-lock' : 'room'} size={size === 'head' ? 18 : 16}/>}/></span>
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

  const row = (thread: Thread, reorder?: (to: { view: string; after: boolean }, from: string) => void, onOpen?:()=>void) => {
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
        <button className="cl-open" onClick={() => onOpen ? onOpen() : choose(thread.key)} onPointerEnter={() => prefetchConversation(thread.view)} onFocus={() => prefetchConversation(thread.view)} aria-current={on ? 'true' : undefined}>
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
    <button type="button" className="cl-add" onClick={() => { if(harne…57117 tokens truncated…          maxLength={4000}
              placeholder={t(harness?'Reply in thread…':'Reply… — @AI to ask the AI')}
              aria-label={t('Reply in thread')}
              aria-describedby={threadReplying?.parentId === thread.parent.id ? 'slk-thread-replying-text' : undefined}
              onChange={(e) => { const v = bulletOnSpace(e); setThreadDraft(v); threadMention.track(); typed({ channel: thread.channel, parentId: thread.parent.id }, v); writing() }}
              onBlur={() => stoppedTyping({ channel: thread.channel, parentId: thread.parent.id })}
              onKeyUp={threadMention.track}
              onClick={threadMention.track}
              onKeyDown={(e) => {
                if (threadMention.onKeyDown(e)) return
                // Escape takes the reply back, and leaves the words.
                if (e.key === 'Escape' && threadReplying && !e.shiftKey && !composing(e)) { e.preventDefault(); setThreadReplying(null); return }
                // ↑ in an empty box edits what you last said in this thread,
                // as the conversation's own box does (#250).
                if (e.key === 'ArrowUp' && !threadDraft && !composing(e)) {
                  const last = [...thread.replies].reverse().concat(thread.parent).find((m) => m.mine && m.kind === 'message' && !m.deleted)
                  if (last && !last.failed) { e.preventDefault(); setEditing({ id: last.id, text: last.body }) }
                  return
                }
                if (enterKey(e) && !e.metaKey && !e.ctrlKey && (e.shiftKey || !wide) && continueBlock(e.currentTarget, threadDraft, setThreadDraft)) { e.preventDefault(); return }
                if (enterKey(e) && !e.shiftKey && wide) { e.preventDefault(); void send(thread.channel, false, thread.parent.id) }
              }}
            />
            {threadMention.menu}
            <div className="slk-composer-bar">
              {!harness && <button type="button" className="slk-attach-btn" onClick={() => threadAttachInput.current?.click()} aria-label={t('Attach files')} title={t('Attach files')}><Icon name="paperclip" size={17} /></button>}
              <ComposerEmojiButton target={threadComposer} value={threadDraft} set={setThreadDraft} />
              <input ref={threadAttachInput} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) threadUploads.add(files, thread.channel) }} />
              {harness ? <HarnessComposerMenu key={`thread-menu:${api.orgId}:${userId}:${thread.parent.id}`} onAttach={()=>threadAttachInput.current?.click()}
                onMention={()=>{const el=threadComposer.current;const a=el?.selectionStart??threadDraft.length,b=el?.selectionEnd??a;setThreadDraft(threadDraft.slice(0,a)+'@'+threadDraft.slice(b));requestAnimationFrame(()=>{el?.focus();el?.setSelectionRange(a+1,a+1);threadMention.track()})}}
                onConnections={onOpenScreen?()=>onOpenScreen('tools'):undefined}
                extraActions={<button type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={threadAlso} onClick={()=>setThreadAlso(value=>!value)}><Icon name={threadAlso?'check':'message'} size={16}/>{t('Also send to the conversation')}</button>}>
                <FormatBar target={threadComposer} value={threadDraft} set={setThreadDraft}/>
              </HarnessComposerMenu> : <FormatBar target={threadComposer} value={threadDraft} set={setThreadDraft} />}
              {!harness && <label className="slk-also-channel" data-also-channel="1">
                <input type="checkbox" checked={threadAlso} onChange={(e) => setThreadAlso(e.target.checked)} />
                <span>{(() => {
                  const where = everything.find((x) => x.view === thread.channel)
                  return where?.kind === 'channel' ? t('Also send to {where}', { where: `#${where.name}` }) : t('Also send to the conversation')
                })()}</span>
              </label>}
              <span className="slk-composer-hint" />
              {harness && threadAlso && <span className="hx-reply-broadcast">{t('Also send to the conversation')}</span>}
              <HarnessDictation key={`thread-dictation:${api.orgId}:${userId}:${thread.parent.id}`} value={threadDraft} onChange={setThreadDraft} locale={locale} orgId={api.orgId} userId={userId} loadVocabulary={resourceClient.dictationVocabulary} saveVocabulary={resourceClient.saveDictationVocabulary} disabled={threadUploads.busy}/>
              <button type="submit" className="slk-send" disabled={threadUploads.busy || (!threadDraft.trim() && !threadUploads.ids.length)} aria-label={t('Send')}>
                <Icon name="send" size={16} />
              </button>
            </div>
          </form>
    </>
  )
  /// How many people a conversation has: a public channel is everyone.
  const headCount = (th: Thread) => th.kind === 'group' ? (th.refs || []).length + 1
    : th.kind === 'channel' ? (th.managed ? (th.memberCount ?? 0) : th.private ? (th.memberCount || 1) : members.length) : 2
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

  const goToRoomResult = async (channel:string, message:ChannelMessage, signal:AbortSignal) => {
    const found=await findRoomMessage(messagesRef.current[channel]||[],!!more[channel],message.id,signal,async first=>{
      const response=await fetch(`${api.httpBase}/channels/messages?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&${olderThan(first)}`,{headers:authHeaders,signal})
      if(!response.ok)throw new Error('History unavailable')
      const data=await response.json();return {messages:data.messages as ChannelMessage[],more:hasOlder(data,PAGE)}
    })
    signal.throwIfAborted()
    setMessages(previous=>{
      const current=previous[channel]||[],known=new Set(current.map(m=>m.id))
      return {...previous,[channel]:[...found.messages.filter(m=>!known.has(m.id)),...current]}
    })
    setMore(previous=>({...previous,[channel]:found.more}))
    requestAnimationFrame(()=>requestAnimationFrame(()=>{if(!signal.aborted)jumpTo(message.id)}))
  }
  const roomSearchShortcut = !thread
  const conversation = (thread: Thread) => {
    const said = thread.view ? (messages[thread.view] || []) : []
    // The red line: the first thing somebody else said since you last read.
    const since = newSince && newSince.view === thread.view ? newSince.at : ''
    // Only the words in a box changed: the rows drawn last time are these
    // rows, so they are used again rather than drawn and compared anew —
    // every key typed used to redraw the whole conversation (typingOnly).
    const kept = typingRender ? rowsKept.current : null
    const reuse = Boolean(kept && kept.view === thread.view && kept.said === said && kept.cards === thread.cards && kept.since === since)
    let out: React.ReactNode[] = []
    if (reuse) out = kept!.out
    else {
      // A card the AI announced sits under its announcement, not twice.
      const announced = new Set(said.filter((m) => m.kind === 'ai' && m.cardId).map((m) => m.cardId!))
      const items: Item[] = [
        ...thread.cards.filter((c) => !announced.has(c.id)).map((card) => ({ at: card.createdAt, kind: 'card' as const, card })),
        ...said.map((msg) => ({ at: msg.createdAt, kind: 'msg' as const, msg })),
      ].sort((a, b) => a.at.localeCompare(b.at))

      let day = ''
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
                <time className="slk-joined-time" dateTime={m.createdAt}>{formatDate(Date.parse(m.createdAt), [], { hour: '2-digit', minute: '2-digit' })}</time>
              </div>,
            )
            prevWho = ''
            continue
          }
          if (m.kind === 'ai') {
            const card = m.cardId ? cardsById.get(m.cardId) : undefined
            out.push(block(m.id, { joined: false, at: m.createdAt, app: 'ai', name: t('Your AI'), badge: t('AI'), msgId: m.id, pinned: m.pinned, mentionsMe: callsMe(m), tools: toolsFor(thread.view!, m), onHold: holdFor(thread.view!, m), onMenu: menuFor(thread.view!, m) },
              <>
                <div className="slk-text">{rich(shownBody(m).text, m.channel)}</div>
                {recurringOffer(m)}
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
              quote: quote ? <ReplyQuoteLine quote={displayQuote(quote, thread.view!)} name={quoteName(quote)} onJump={() => void goToQuoted(thread.view!, quote.id)} />
                : fromThread ? <ThreadReplyLine quote={displayQuote(fromThread, thread.view!)} onOpen={() => void openThread(thread.view!, m)} /> : undefined,
            }, (
              <>
                {words(thread.view!, m)}
                {harness && m.kind === 'agent' && <AgentToolTrace api={api} channel={thread.view!} messageId={m.id}/>}
                {recurringOffer(m)}
                {m.cardId && <button className="slk-made" onClick={() => openCard(m.cardId!)}>{t('→ Decision')}</button>}
                {underneath(thread.view!, m)}
              </>
            )))
            prevWho = whoKey
          }
        }
        prevAt = at
      }
    }
    rowsKept.current = { view: thread.view, said, cards: thread.cards, since, out }
    const waitingHere = thread.cards.filter(isUnread).length
    const startingThread=harness && newThreadMode.enabled && !resourceBuild
    const placeholder = startingThread ? t('Start a new thread') : harness ? t('Type a message…') : thread.kind === 'channel'
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
          <div className="slk-head-text" onClick={!wide && thread.kind === 'channel' && thread.view ? () => harness && thread.managed ? setRoomMembersView(thread.view!) : openSide({ kind: 'details', tab: 'members' }) : undefined}>
            {thread.kind === 'person' && thread.view
              ? <h1><button type="button" className="slk-author link" onClick={() => void openProfile(thread.view!.slice(3))}>{thread.name}</button>
                  {(() => { const s = statusShown(members.find((x) => thread.view === `dm:${x.ref}`)?.status, Date.now()); return s ? <span className="slk-head-status"> {s.emoji} {s.text}</span> : null })()}
                  {(() => { const away = awayShown(members.find((x) => thread.view === `dm:${x.ref}`)?.awayUntil, Date.now()); return away ? <span className="slk-head-away"> · {t('Away until {when}', { when: new Date(away).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) })}</span> : null })()}
                </h1>
              : <h1>{thread.name}</h1>}
            {thread.view && !(harness && thread.managed) && (
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
          {harness && thread.view && <div className="hx-room-actions">
            {onApps && <button aria-label={t('Apps')} title={t('Apps')} aria-expanded={side?.kind === 'resources' && side.resource === 'apps'} onClick={() => openSide({ kind: 'resources', resource: 'apps' })}><Icon name="box" size={15} /><span>{t('Apps')}</span></button>}
            <button aria-label={t('room.automations')} title={t('room.automations')} aria-expanded={side?.kind === 'resources' && side.resource === 'workflows'} onClick={() => openSide({ kind: 'resources', resource: 'workflows' })}><Icon name="zap" size={15} /><span>{t('room.automations')}</span></button>
            <button aria-label={t('Files')} title={t('Files')} aria-expanded={side?.kind === 'files'} onClick={() => openSide({ kind: 'files' })}><Icon name="folder" size={15} /><span>{t('Files')}</span></button>
            <button onClick={() => thread.managed ? setRoomMembersView(thread.view!) : openSide({ kind: 'details', tab: 'members' })} aria-label={t('Members ({n})',{n:headCount(thread)})}><Icon name="users" size={15} /><span>{headCount(thread)}</span></button>
          </div>}
          {!harness && thread.view && (
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
                onClick={() => harness && thread.managed ? setRoomMembersView(thread.view!) : openSide({ kind: 'details', tab: 'members' })}
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
          {harness&&thread.managed&&thread.view ? <HarnessRoomTools key={`${api.orgId}:${api.sessionToken}:${thread.view}`} api={api} channel={thread.view} shortcut={roomSearchShortcut} pinned={isStarred(thread.view)} muted={prefs[thread.view]==='mute'} onSelect={(message,signal)=>goToRoomResult(thread.view!,message,signal)} onCopy={()=>copyText(`${location.origin}${location.pathname}${hashForView(thread.view!)}`,t('Link copied'))} onPin={()=>toggleStar(thread.view!)} onSettings={()=>{forgetWanted();setSettings(true);setRenaming(null)}} onMute={()=>void setPref(thread.view!,prefs[thread.view!]==='mute'?'default':'mute')}/> : thread.kind === 'channel' && thread.slug && (
            <button
              className="slk-more"
              onClick={() => { forgetWanted(); setSettings((v) => !v); setRenaming(null) }}
              aria-label={t(harness&&thread.managed?'Room settings':'Channel settings')}
              aria-haspopup={harness&&thread.managed?'dialog':undefined}
              aria-expanded={settings}
            >
              <Icon name="more" size={16} />
            </button>
          )}
        </header>
        {!harness && thread.view && thread.kind !== 'app' && <BookmarksBar httpBase={api.httpBase} orgId={api.orgId} headers={authHeaders} view={thread.view} />}
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
        <nav className="slk-tabs" role="tablist" aria-label={t('View')} hidden={harness && !thread.cards.length}>
          <button role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'on' : ''} onClick={() => setTab('messages')}>
            {thread.view ? t('Messages') : t('Activity')}
          </button>
          <button role="tab" aria-selected={tab === 'decisions'} className={tab === 'decisions' ? 'on' : ''} onClick={() => setTab('decisions')}>
            {t('Decisions')}{thread.cards.length > 0 && <span className="slk-tab-count">{thread.cards.length}</span>}
          </button>
        </nav>
        {settings && !(harness&&thread.managed) && thread.kind === 'channel' && thread.slug && (
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
                  {(['default', 'all', 'mentions', 'mute'] as const).map((lv) => (
                    <button key={lv} type="button" className={`cl-nudge${(prefs[thread.view!] || 'default') === lv ? ' on' : ''}`} aria-pressed={(prefs[thread.view!] || 'default') === lv} onClick={() => void setPref(thread.view!, lv)} data-notify-level={lv}>
                      {lv === 'default' ? t('Mentions, replies and a sound for posts') : lv === 'all' ? t('Every post, on the phone too') : lv === 'mentions' ? t('Mentions only') : t('Nothing (mute)')}
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
          // React can commit noteWhere's update before the native scroll
          // listener runs. Release following before that commit triggers the
          // mutation observer, otherwise it can pull a reader back down.
          pinned.current = isAtBottom(e.currentTarget)
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
          {harness && thread.view && <AgentRunStatus api={api} channel={thread.view} messages={said.filter(m => !threadOpenParent || (m.id !== threadOpenParent && m.parentId !== threadOpenParent))}/>}
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
          <form className="slk-composer" onKeyDown={e=>{if(harness&&attachmentShortcut(e)){e.preventDefault();attachInput.current?.click()}}} onSubmit={(e) => { e.preventDefault(); void send(thread.view!, false) }}>
            {harness && resourceBuild?.channel === thread.view && <div className="hx-build-status" role="status"><Icon name={resourceBuild.kind === 'apps' ? 'grid' : 'zap'} size={15} /><span>{t(resourceBuilding ? 'Building…' : resourceBuild.kind === 'apps' ? 'Describe an app' : 'Describe an automation')}</span><button type="button" disabled={resourceBuilding} onClick={() => setResourceBuild(null)}>{t('Cancel')}</button></div>}
            {replying && <ReplyingBar quote={displayQuote(replying, view!)} name={quoteName(replying)} textId="slk-replying-text" onCancel={() => { setReplyingTo(null); composer.current?.focus() }} />}
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
              onChange={(e) => { const v = bulletOnSpace(e); setDraft(v); mention.track(); typed({ channel: thread.view!, parentId: null }, v); writing() }}
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
              {!harness && <button type="button" className="slk-attach-btn" onClick={() => attachInput.current?.click()} aria-label={t('Attach files')} title={t('Attach files')}><Icon name="paperclip" size={17} /></button>}
              <ComposerEmojiButton target={composer} value={draft} set={setDraft} />
              <input ref={attachInput} type="file" multiple hidden data-attach="1" onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) uploads.add(files, thread.view!) }} />
              {harness ? <HarnessComposerMenu key={`menu:${api.orgId}:${userId}:${thread.view}`} onAttach={() => attachInput.current?.click()}
                onMention={() => { const el=composer.current; const a=el?.selectionStart ?? draft.length, b=el?.selectionEnd ?? a; setDraft(draft.slice(0,a)+'@'+draft.slice(b)); requestAnimationFrame(()=>{el?.focus();el?.setSelectionRange(a+1,a+1);mention.track()}) }}
                onConnections={onOpenScreen ? () => onOpenScreen('tools') : undefined}
                onDecision={() => void send(thread.view!,true)} onSchedule={() => setScheduleOpen(true)}
                canDecide={!resourceBuilding && !uploads.busy && !!draft.trim()} canSchedule={!resourceBuilding && !uploads.busy && !!draft.trim() && !draft.trim().startsWith('/')}>
                <FormatBar target={composer} value={draft} set={setDraft}/>
              </HarnessComposerMenu> : <FormatBar target={composer} value={draft} set={setDraft} />}
              {harness && !resourceBuild && <button type="button" className="hx-new-thread" aria-pressed={startingThread} aria-label={t(startingThread?'Exit new thread mode':'New thread')} onClick={()=>{newThreadMode.toggle();composer.current?.focus()}}><Icon name="thread-new" size={16}/>{startingThread && <span>{t('New thread')}</span>}</button>}
              <span className="slk-composer-hint">{t('Enter to send · @AI to ask · ✦ makes it a decision · / for commands')}</span>
              {!harness && <button type="button" className="slk-send ai" disabled={!draft.trim()} onClick={() => void send(thread.view!, true)} aria-label={t('Send as a decision')} title={t('Send as a decision')}>
                <Icon name="sparkle" size={15} /><span className="slk-send-label">{t('Send as a decision')}</span>
              </button>}
              <HarnessDictation key={`dictation:${api.orgId}:${userId}:${thread.view}`} value={draft} onChange={setDraft} locale={locale} orgId={api.orgId} userId={userId} loadVocabulary={resourceClient.dictationVocabulary} saveVocabulary={resourceClient.saveDictationVocabulary} disabled={resourceBuilding || uploads.busy}/>
              <span className="slk-send-group">
                <button type="submit" className="slk-send" disabled={resourceBuilding || uploads.busy || (!draft.trim() && !uploads.ids.length)} aria-label={t(startingThread?'Start a new thread':'Send')}>
                  <Icon name="send" size={16} />
                </button>
                {!harness && <button type="button" className="slk-send more" disabled={!draft.trim() || draft.trim().startsWith('/')} onClick={() => setScheduleOpen((o) => !o)} aria-label={t('Schedule message')} title={t('Schedule message')} aria-expanded={scheduleOpen}>
                  <Icon name="chevron-down" size={14} />
                </button>}
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
            const said = a ? `${a.lastBy === 'me' ? `${t('You')}: ` : ''}${a.last ? shownBody(a.last).text.replace(/\s+/g, ' ').slice(0, 120) : translateOff ? (a.originalPreview ?? '') : a.preview}` : th.latest ? titleOf(th.latest) : (th.app === 'ai' ? t('Tell your AI…') : th.kind === 'agent' ? `@${th.agent?.handle || ''}` : t('Say hello'))
            return (
              <li key={th.key}>
                <button type="button" className={`cl-dm${th.unread || th.fresh ? ' unread' : ''}`} onClick={() => choose(th.key)} onPointerEnter={() => prefetchConversation(th.view)} onFocus={() => prefetchConversation(th.view)}>
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
  const roomMemberDialog=(view:string,onClose:()=>void,initialAdding=false)=><RoomMembers key={`${api.orgId}:${view}`} api={api} view={view} initialAdding={initialAdding}
    onClose={onClose} people={members} onInvite={()=>setInviting('people')}
    onProfile={member=>{onClose();if(member.kind==='person')void openProfile(member.id);else onOpenAgentProfile?.(member.id)}}
    onChanged={()=>{setChannelsTick(n=>n+1);window.dispatchEvent(new Event('honmaru:reload-businesses'));window.dispatchEvent(new Event('honmaru:agents-changed'))}}/>
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
    <div ref={interactionRoot} className={`classic slk${current || special ? ' in-thread' : ''}${phoneRoot ? ' phone-root' : ''}${detail || thread || profile ? ' with-pane' : ''}${sourceThreadApp ? ' hx-thread-app' : ''}${harness && thread && !detail && !profile && !activityOpen ? ' hx-focused-thread' : ''}${sideHidden ? ' side-hidden' : ''}${density === 'compact' ? ' compact' : ''}`} onClick={onMentionClick} onKeyDown={onMentionKey}>
      <aside className="slk-side" aria-label={t('Conversations')} data-sidebar-ready={sidebarReady ? '1' : undefined}>
        {sidebarPending && !sidebarUncertain && <p className="cl-problem" role="status">{locale === 'ja' ? 'サイドバーの変更を保存中です。同じタブでこのワークスペースに戻ると未完了の保存を再試行します。' : 'Saving sidebar changes. Pending changes retry when you return to this workspace in the same tab.'}</p>}
        {sidebarUncertain && <div className="cl-problem" role="alert">
          <p>{locale === 'ja' ? '保存結果が不明です。変更はこの画面に保留され、追加の変更は停止しています。画面を閉じるか再読み込みすると保留中の変更が失われる可能性があります。' : 'The save result is unknown. Changes remain pending on this screen and further edits are stopped. Closing or reloading this screen may discard pending changes.'}</p>
          <button type="button" disabled={sidebarChecking} onClick={() => void checkSavedSidebar()}>{locale === 'ja' ? '保存状態を確認' : 'Check saved sidebar'}</button>
          {sidebarCheckError && <p>{locale === 'ja' ? '保存状態を読み込めませんでした。' : 'The saved sidebar could not be read.'}</p>}
          {sidebarRemote && <div>
            <SidebarSavedState sidebar={sidebarRemote} japanese={locale === 'ja'} nameOf={view => everything.find(item => item.view === view)?.name || view} />
            <button type="button" disabled={sidebarChecking} onClick={() => void adoptSavedSidebar()}>{locale === 'ja' ? '保留を破棄して保存状態を使う' : 'Discard pending and use saved state'}</button>
          </div>}
        </div>}
        {!wide && phoneTab === 'dms' ? dmsView() : <>
        {harness ? <>
          <header className="hx-chat-top"><h1>{t('Chat')}</h1><button onClick={() => setStarting('menu')} aria-label={t('New message')}><Icon name="plus" size={17} /></button></header>
          <div className="hx-chat-filters" role="tablist" aria-label={t('Chat')}>
            {(['home', 'recent', 'unread', 'mentions'] as const).map(filter => <button key={filter} role="tab" aria-selected={harnessFilter === filter} onClick={() => {
              setHarnessFilter(filter)
              // This changes only the left list. Keep the selected thread,
              // draft and app panel in place while moving between filters.
              if (filter === 'mentions') void loadActivity()
            }}>{filter === 'home' ? t('Home') : filter === 'recent' ? t('Recent') : filter === 'unread' ? t('Unread') : t('@Me')}</button>)}
          </div>
        </> : <><header className="cl-top">
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
        {checklist}</> }
        {!current && problem && <p className="cl-problem" role="alert">{problem}</p>}
        <nav className="slk-sections">
          {!harness && <ul className="slk-special">
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
          </ul>}
          {harness && harnessFilter==='home' && (threadPins.pins.length>0 || threadPins.error) && <section className="hx-pinned-threads" aria-label="固定したスレッド"><h2>固定したスレッド</h2>{threadPins.error?<p role="status">{threadPins.error}<button type="button" disabled={threadPins.busy} onClick={()=>void threadPins.refresh()}>再試行</button></p>:null}<ul className="hx-chat-group">{threadPins.pins.map(pin=><li key={pin.id} className="cl-row cl-thread"><button type="button" className="cl-open" aria-current={thread?.parent.id===pin.id?'page':undefined} onClick={()=>openAt({view:pin.view,id:pin.id,parentId:pin.id})}><Icon name="pin" size={14}/><span className="cl-title">{previewText(pin.title)||'スレッド'}</span></button></li>)}</ul></section>}
          {harness && harnessFilter==='mentions' ? harnessMentionsView() : harness && (harnessFilter === 'recent' || harnessFilter === 'unread') ? <ul className="hx-filtered-chats">{everything.filter(th => th.kind !== 'app' && (harnessFilter === 'recent' ? Boolean(th.lastAt) : hasNews(th))).sort((a,b) => (b.lastAt || '').localeCompare(a.lastAt || '')).map(th => row(th))}</ul> : sidebarGroups.filter(g => !harness || g.id !== 'apps').map((g) => (
            <React.Fragment key={g.id}>
              {/* Sections of your own are added just above Apps, which stays last. */}
              {!harness && g.id === 'apps' && (
                <button type="button" className="cl-add-section" onClick={() => { setSectionName(''); setAddingSection({}) }} data-add-section="1">
                  <Icon name="plus" size={13} /> {t('Add a section')}
                </button>
              )}
              {harness ? (g.items.length > 0 ? <ul className="hx-chat-group" aria-label={g.label}>{g.items.map(th => th.kind === 'channel' && th.view ? <RoomThreadDirectory key={`${api.orgId}:${api.sessionToken}:${th.view}`} api={api} channel={th.view} name={th.name} selected={current?.key===th.key} activeId={thread?.channel===th.view?thread.parent.id:undefined} onOpen={id=>openAt({view:th.view!,id,parentId:id})}>{row(th)}</RoomThreadDirectory> : row(th))}</ul> : null) : section(g.id, g.label, g.items, g.empty, g.action, g.below, g.reorder)}
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
          <div className="slk-none">{harness ? <div className="hx-chat-empty"><Icon name="message" size={32} /><h2>{t('Start a conversation')}</h2><p>{t('Choose a room or start a new message.')}</p><button onClick={() => setStarting('menu')}>{t('New message')}</button></div> : <p>{t('Pick a conversation.')}</p>}</div>
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
          <button type="button" className={tabOn('dms') ? 'on' : ''} aria-current={tabOn('dms') ? 'page' : undefined} onClick={() => { choose(null); setPhoneTab('dms') }} {...(harness ? longPress(() => setPhoneDraftComposer(true), { allowButton: true }) : {})} data-phone-tab="dms">
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
      {harness&&settings&&current?.managed&&current.view&&<RoomSettings key={`${api.httpBase}:${api.orgId}:${api.sessionToken}:${current.view}`} api={api} view={current.view} onClose={()=>setSettings(false)} onSaved={()=>{setChannelsTick(n=>n+1);window.dispatchEvent(new Event('honmaru:reload-businesses'))}}/>}
      {harness && roomMembersView && roomMemberDialog(roomMembersView,()=>setRoomMembersView(null))}
      {harness && creatingRoom && onCreateRoom && <RoomCreateDialog key={api.orgId} people={[
        ...members.filter(m=>!m.mine).map(m=>({id:m.ref,kind:'person' as const,name:m.name,avatarUrl:m.avatarUrl||undefined})),
        ...addableRoomAgents.map(a=>({id:a.id,kind:'agent' as const,name:a.name,avatarUrl:a.avatarUrl||undefined,missingAccessMembers:a.missingAccessMembers,canGrantAccess:a.canGrantAccess,externalRuntime:a.externalRuntime})),
        ...requestableRoomAgents.map(a=>({id:a.id,kind:'agent' as const,name:a.name,avatarUrl:a.avatarUrl||undefined,requestOnly:true,accessRequestStatus:a.accessRequestStatus})),
      ]} onRequestAgentAccess={requestRoomAgentAccess} onClose={()=>setCreatingRoom(false)} onCreate={async input=>{
        const scope=roomCreationScope.current;const room=await onCreateRoom(input);if(scope!==roomCreationScope.current)return;setCreatingRoom(false);setChannelsTick(n=>n+1);choose(`channel:${room.slug}`)
      }}/>}
      {harness && joiningRoom && <RoomJoinDialog key={api.orgId} api={api} onClose={() => setJoiningRoom(false)} onJoined={channel => {
        setJoiningRoom(false); setChannelsTick(n => n + 1); choose(`channel:${channel.slice(2)}`)
      }}/>}
      {harness && phoneDraftComposer && (
        <PhoneDestinationComposer
          destinations={phoneDraftDestinations}
          api={api}
          onClose={() => setPhoneDraftComposer(false)}
          t={t}
          onChoose={(destination, draftText) => {
            try {
              const key = destination.threadId
                ? `draft:${api.orgId}:thread:${destination.threadId}`
                : `draft:${api.orgId}:${destination.view}`
              if (draftText.trim()) localStorage.setItem(key, draftText)
              else localStorage.removeItem(key)
            } catch { /* drafts remain local when storage is available */ }
            setPhoneDraftComposer(false)
            choose(destination.key)
            if (destination.threadId) {
              const parent = { id: destination.threadId, channel: destination.view, kind: 'message', body: '', authorName: null, authorRef: null, createdAt: new Date().toISOString() } as ChannelMessage
              requestAnimationFrame(() => { void openThread(destination.view, parent) })
            }
          }}
        />
      )}
      {starting === 'menu' && (
        <Sheet label={t('New')} onClose={() => setStarting(null)}>
          <div className="msheet-rows">
            <SheetRow icon="message" label={t('New message')} onClick={() => setStarting('people')} data="new-message" />
            <SheetRow icon="sparkle" label={t('Tell your AI')} hint={t('It becomes a card')} onClick={() => { setStarting(null); onCompose() }} data="tell-ai" />
            <SheetRow icon={harness?'room':'hash'} label={t(harness?'New room':'New channel')} onClick={() => { setStarting(null); setPhoneTab('home'); if(harness&&onCreateRoom)setCreatingRoom(true);else setAdding(true) }} data="new-channel" />
            {harness && <SheetRow icon="search" label={t('Join public room')} onClick={() => { setStarting(null); setJoiningRoom(true) }} data="join-public-room" />}
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
      {addingTo && (harness && everything.some(item=>item.view===addingTo&&item.managed)
        ? roomMemberDialog(addingTo,()=>setAddingTo(null),true) : <PeoplePicker
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
              {(th.kind === 'channel' || th.kind === 'group') && <SheetRow icon="users" label={t('Members')} hint={String(headCount(th))} onClick={close(() => harness && th.managed ? setRoomMembersView(th.view!) : openSide({ kind: 'details', tab: 'members' }))} data="members" />}
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
              {th.kind === 'channel' && th.slug && <SheetRow icon="invite" label={t('Invite a guest to this channel')} onClick={close(() => inviteGuest(th))} data="invite-guest" />}
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
      {threadReference && <ThreadReferenceDialog message={threadReference.message} failed={threadReference.failed} base={api.httpBase}
        name={threadReference.message ? whoSaid(threadReference.message) : ''} at={threadReference.message ? when(threadReference.message.createdAt) : ''}
        onClose={() => { referenceAsk.current++; setThreadReference(null) }}>
        {threadReference.message && rich(shownBody(threadReference.message).text)}
      </ThreadReferenceDialog>}
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
      {!detail && thread && !(activityOpen && wide) && (
        <aside ref={threadPane} className={`slk-pane slk-thread-pane${threadDropping ? ' slk-dropping' : ''}`} aria-label={t('Thread')}
          style={wide && threadWidth ? { width: threadWidth } : undefined}
          // Files dropped on the thread are the reply's, not the conversation's.
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setThreadDropping(true) } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setThreadDropping(false) }}
          onDrop={(e) => { setThreadDropping(false); if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); threadUploads.add([...e.dataTransfer.files], thread.channel) } }}>
          {wide && !harness && !sourceThreadApp && <PaneResizer pane={threadPane} label={t('Resize thread')} title={t('Drag to resize · double-click to reset')} onWidth={keepThreadWidth} onReset={() => keepThreadWidth(null)} />}
          {harness ? <HarnessThreadHeader key={`${api.orgId}:${api.sessionToken}:${thread.parent.id}`} api={api} onSearchSelect={message=>requestAnimationFrame(()=>goToQuotedInThread(thread.parent.id,message.id))} references={{open:side?.kind==='references',onToggle:()=>setSide(previous=>previous?.kind==='references'?null:{kind:'references'})}} pin={{error:threadPins.error,onRetry:()=>void threadPins.refresh(),pinned:threadPins.pins.some(pin=>pin.id===thread.parent.id),disabled:!threadPins.loaded||threadPins.busy||!!thread.parent.deleted,onToggle:()=>void threadPins.toggle(thread.parent.id)}} channel={thread.channel} parent={thread.parent} room={current?.name||'ルーム'} onClose={()=>setThread(null)} onParent={parent=>{setThread(previous=>previous?.parent.id===parent.id?{...previous,parent}:previous);void threadPins.refresh()}}/> : <header className="slk-pane-head">
            <button className="slk-back pane" onClick={() => setThread(null)} aria-label={t('Back')}><Icon name="chevron-left" size={20} /></button>
            <h2>{t('Thread')}</h2>
            {current && <span className="slk-pane-where">{current.kind === 'channel' ? `#${current.name}` : current.name}</span>}
            <button className="slk-pane-close" onClick={() => setThread(null)} aria-label={t('Close')}><Icon name="x" size={16} /></button>
          </header>}
          {threadBody(thread)}
        </aside>
      )}
      {!detail && (!thread || sourceThreadApp) && !profile && side && current?.view && (
        side.kind === 'references'
          ? thread&&<ThreadReferences key={`${api.orgId}:${api.sessionToken}:${thread.parent.id}`} api={resourceClient} sessionToken={api.sessionToken} channel={thread.channel} threadId={thread.parent.id} onClose={()=>setSide(null)} onOpen={id=>setSide({kind:'app',id,fromReferences:true})}/>
          : side.kind === 'app'
          ? <aside className="hx-app-pane slk-pane"><AppView key={`${api.orgId}:${side.id}`} httpBase={api.httpBase} orgId={api.orgId} sessionToken={api.sessionToken} api={resourceClient} appId={side.id} openConversation={side.conversation} initialSection={side.section} onClose={() => setSide(null)} onBack={() => setSide(side.fromReferences&&thread?{kind:'references'}:{ kind: 'resources', resource: 'apps' })} /></aside>
          : side.kind === 'files'
          ? <RoomFilesPanel key={`${api.orgId}:${api.sessionToken}:${current.view}`} api={resourceClient.files} channel={current.view} targetFileId={side.fileId} inlinePreview={!!thread} allOriginsInFolders={harness} enablePublicMediaUrls={harness} preferenceKey={workspaceFileViewKey(api.httpBase,api.orgId,userId,current.view)} onClose={()=>setSide(null)} onAttachments={()=>{setThread(null);setSide({kind:'details',tab:'attachments'})}}/>
          : side.kind === 'resources'
          ? <HarnessRoomResources key={`${api.orgId}:${userId}:${current.view}:${side.resource}`} api={api} channel={current.view} kind={side.resource}
              onClose={() => setSide(null)} onOpenApp={id => { if (id) setSide({ kind: 'app', id }); else { setSide(null); onApps?.() } }} onOpenWorkflow={id => { setSide(null); onWorkflow?.(id) }}
              onLegacy={() => setSide({ kind: 'details', tab: 'automations' })}
              onCreate={() => { setResourceBuild({ kind: side.resource, channel: current.view! }); const request = t(side.resource === 'apps' ? 'Build an app for this room. What I need is: ' : 'Set up an automation for this room. What it should do: '); setDraft(previous => previous ? `${previous}\n${request}` : `${current.kind === 'agent' ? '' : '@AI '}${request}`); setSide(null); requestAnimationFrame(() => composer.current?.focus()) }} />
          : side.kind === 'canvas'
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
              level={(prefs[current.view] || 'default') as NotifyLevel}
              onLevel={(lv) => void setPref(current.view!, lv)}
              onSettings={current.kind === 'channel' && current.slug ? () => { forgetWanted(); setSettings(true); setRenaming(null) } : null}
              onInvite={(managed) => ((current.private || managed) ? setAddingTo(current.view!) : inviteGuest(current))}
              onProfile={(ref) => void openProfile(ref)}
              onlineRefs={onlineRefs}
              onJump={(id) => void goToCite(current.view!, { id, parentId: null, at: '' })}
              onCounts={(n) => setAutomationCount((prev) => ({ ...prev, [current.view!]: n.automations }))}
              onClose={() => setSide(null)}
            />
          )
      )}
      {inviting && (
        <InviteDialog httpBase={api.httpBase} orgId={api.orgId} sessionToken={api.sessionToken} orgName={orgName} initialTab={inviting} channel={inviteTo} onClose={() => { setInviting(null); setInviteTo(null) }} />
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
