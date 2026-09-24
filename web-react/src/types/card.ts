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
