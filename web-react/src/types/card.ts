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
