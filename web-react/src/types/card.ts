export type CardType = 'approval' | 'delegation' | 'notification' | 'task' | 'revision'
export type CardStatus = 'pending' | 'approved' | 'rejected' | 'revised' | 'delegated' | 'completed'
export type CardPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface Decision {
  action: string
  optionId?: string
  note?: string
  replyText?: string
  actorUserID: string
  decidedAt: string
}

export interface DecisionCard {
  id: string
  recipientUserID: string
  senderUserID: string
  type: CardType
  title: string
  summary: string
  context: string
  status: CardStatus
  priority: CardPriority
  createdAt: string
  githubIssueNumber?: number
  githubIssueURL?: string
  githubRepository?: string
  agentRoute?: string
  routingReason?: string
  sourceInstruction?: string
  labels?: string[]
  revisionNote?: string
  sourceApp?: string
  sourceDetail?: string
  originalBody?: string
  originalLanguage?: string
  videoURL?: string
  decision?: Decision
  // The card in other languages, keyed by locale ("ja"), written by the relay
  // for the recipient. The top-level fields stay in the sender's language.
  localized?: Record<string, { title: string; summary?: string; context?: string }>
  // Which of the org's businesses this decision belongs to, by slug.
  business?: string
  // The thread under the card, summarised by the Worker: how many said
  // something, when the last one did, and the reactions by emoji.
  commentCount?: number
  lastCommentAt?: string | null
  reactions?: Record<string, number>
  // Member refs the sender named with an @.
  mentions?: string[]
  // What the AI would advise, and why. A starting point the person can
  // ignore, never a decision — the card still waits for them.
  recommendation?: { action: 'approve' | 'decline' | 'revise'; reason?: string }
  // Who asked, stamped by the relay from the org's own membership table so a
  // client cannot name someone else.
  requestedBy?: { login?: string; name?: string; role?: string; avatarUrl?: string; quote?: string; sourceUrl?: string }
  // How the card asks to be answered. "fyi" is read and acknowledged, not
  // weighed — a routine's report is one.
  format?: string
  // A routine's delivery: the document the AI wrote on schedule. Shown as a
  // document wherever the card is shown in full.
  report?: Report
  // Your AI offering to automate something you keep asking for. Approving
  // the card creates the routine.
  proposal?: Proposal
  // Your daily report, drafted in your voice: you read it, change it, and
  // post it to its channel yourself.
  dailyReport?: DailyReport
}

export interface DailyReport {
  routineId: string
  /// The morning plan or the evening report.
  part?: 'morning' | 'evening'
  /// `b:<slug>`: where it is posted.
  channel: string
  /// The day it covers, in the owner's time zone: "2026-09-24".
  date: string
  /// `expired`: a newer draft from the same routine replaced it unposted.
  status: 'draft' | 'posting' | 'posted' | 'expired' | 'discarded'
  /// The draft, or — once posted — the words as posted.
  text: string
  messageId?: string
  postedAt?: string
  /// The placeholder the draft leaves for the owner's own words.
  fillIn?: string
}

export type Cadence = 'daily' | 'weekdays' | 'weekly' | 'monthly'

/// When a routine runs, and what it does. `weekday` is 0 for Sunday (weekly
/// only); `monthday` 31 means the last day of the month (monthly only).
export interface RoutineSpec {
  title: string
  instruction: string
  cadence: Cadence
  weekday?: number | null
  monthday?: number | null
  hour: number
  minute: number
  timezone: string
}

export interface Report {
  markdown: string
  routineId: string
  routineTitle: string
  /// Already written for a person: "毎週月曜 09:00".
  schedule: string
  periodStart: string
  periodEnd: string
  /// Written by the model, or assembled without one.
  by: 'model' | 'digest'
  sources?: Array<{ app: string; title: string; url: string | null }>
}

export interface Proposal {
  kind: 'routine'
  signature: string
  routine: RoutineSpec
  /// The requests the AI noticed, so the person can see why it asked.
  evidence: Array<{ id: string; title: string; createdAt: string }>
}

export interface Business {
  slug: string
  name: string
  /// Only its members see it; how many there are.
  private?: boolean
  memberCount?: number
  /// A private channel's people, by the hash /members gives as `presence`.
  memberKeys?: string[]
}

export interface AppState {
  cardsById: Record<string, DecisionCard>
  [key: string]: any
}

export interface User {
  id: string
  name: string
  avatar: string
}

/// A message in a channel: a business's (`b:<slug>`) or a direct one with
/// a teammate (`dm:<member ref>`). `kind: 'ai'` is the AI saying what it
/// made of a message; `cardId` is the decision a message became.
/// A file or picture sent with a message. `url` is relative to the API and
/// signed for the person it was given to; it lasts a day or two.
export interface FileRef {
  id: string
  name: string
  type: string
  size: number
  width?: number | null
  height?: number | null
  /// Where to fetch it, signed for a while: renewed by id (utils/mediaUrls).
  url: string
  /// Until when `url` opens (ms); absent from older servers.
  expiresAt?: number
}

export interface ChannelMessage {
  id: string
  channel: string
  /// `agent`: one of the team's own agents (see /channels/agents), answering
  /// in the thread under the message that called it.
  kind: 'message' | 'ai' | 'agent' | 'joined'
  body: string
  /// The language it is written in; null when there is nothing to
  /// translate. A reader in another language sees it translated.
  lang?: string | null
  authorName: string | null
  authorRef: string | null
  /// The author's photo, when they have one.
  authorAvatar?: string | null
  /// Its author took the link cards off.
  previewsHidden?: boolean
  mine: boolean
  cardId: string | null
  createdAt: string
  /// Changed after it was sent, and when.
  editedAt?: string | null
  /// Unsent; the words are gone. A page of history leaves it out, thread
  /// and all; one comes to take away a message already shown, or as the
  /// head of a thread opened by its link, which reads "This message was
  /// deleted." above no replies.
  deleted?: boolean
  /// A reply in the thread under this message.
  parentId?: string | null
  replyCount?: number
  lastReplyAt?: string | null
  /// Who has replied, by member ref, first few only.
  replyRefs?: string[]
  pinned?: boolean
  /// Who reacted, by member ref. `mine` is only set on a message fetched
  /// by this person; a live event is shared, so the refs decide.
  reactions?: Array<{ emoji: string; count: number; refs: string[]; mine: boolean }>
  files?: FileRef[]
  /// Who wrote it, when an agent did: its name and face.
  agent?: { id: string; handle: string; name: string; emoji: string | null; avatarUrl?: string | null } | null
  /// Only on this device, under a temporary id (utils/pendingSend.ts): on
  /// its way to the server, shown before the server has it.
  pending?: boolean
  /// Only on this device: it did not go, and why. Its words stay where they
  /// were, to send again or throw away.
  failed?: string
  /// Only on this device: the server said no to the words themselves (a
  /// data rule, a thread that has gone). Sent again as they are they would
  /// only be refused again, so they are edited or thrown away, not retried.
  refused?: boolean
  /// An inline reply (Discord's, not a thread): the message it answers, as
  /// that message is now.
  replyTo?: ReplyQuote | null
  /// A thread reply sent to the conversation as well ("Also send to
  /// #channel"): read in its thread and in the conversation.
  alsoChannel?: boolean
  /// With `alsoChannel`, in the conversation: the message the thread hangs
  /// off, as it is now.
  threadParent?: ReplyQuote | null
  /// Said by an agent for a person who was mentioned: whose agent it is.
  onBehalfOf?: { name: string | null; ref: string | null } | null
}

/// What a reply shows of the message it answers: who, and how it began —
/// spoilers already hidden — or only that it is gone.
export interface ReplyQuote {
  id: string
  /// Null once it is gone.
  kind: ChannelMessage['kind'] | null
  /// Null for the AI, and once it is gone.
  authorName: string | null
  authorRef: string | null
  /// Its first words on one line, at most 120 characters.
  excerpt: string
  deleted: boolean
}
