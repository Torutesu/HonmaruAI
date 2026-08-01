// Mirrors the Swift models in TikTokForWork/Models. Any change here must be
// matched there — the relay's JSON is the contract between them.
//
// String unions carry `| (string & {})` so a value a newer relay introduces
// (a new status, a new card type) never breaks decoding on an older client.

export type CardType =
  | "approval"
  | "delegation"
  | "notification"
  | "task"
  | "revision"
  | (string & {});

export type CardStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revised"
  | "delegated"
  | "completed"
  | "resent"
  | "acknowledged"
  | (string & {});

export type CardPriority = "low" | "medium" | "high" | "urgent" | (string & {});

export interface CardSource {
  /** "doc" is a connected document (Notion today) — readable in-app, not just linkable. */
  kind: "channel" | "link" | "doc" | (string & {});
  label: string;
  url?: string;
  channelID?: string;
  messageID?: string;
  notionPageID?: string;
}

export interface RecommendationHint {
  action: "approve" | "reject" | "revise" | (string & {});
  reason: string;
}

export interface AgentToolCall {
  name: string;
  label: string;
  detail: string;
}

export interface DecisionCard {
  id: string;
  recipientUserID: string;
  senderUserID: string;
  type: CardType;
  title: string;
  summary: string;
  context: string;
  status: CardStatus;
  priority: CardPriority;
  createdAt: string;
  githubIssueNumber?: number;
  githubIssueURL?: string;
  githubRepository?: string;
  agentRoute?: string;
  routingReason?: string;
  sourceInstruction?: string;
  labels?: string[];
  revisionNote?: string;
  channelID?: string;
  escalatedAt?: string;
  recommendation?: RecommendationHint;
  sources?: CardSource[];
  sourceMessageID?: string;
  /** Autopilot decided this card; never shown as the recipient's own call. */
  autopilotAt?: string;
  decidedByAI?: boolean;
}

export interface AutopilotSettings {
  enabled: boolean;
  holdMinutes: number;
  maxPriority: CardPriority;
  actions: string[];
}

export interface ChatChannel {
  id: string;
  name: string;
  purpose: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  channelID: string;
  authorID: string;
  authorKind: "user" | "agent" | (string & {});
  authorName: string;
  text: string;
  createdAt: string;
  toolCalls?: AgentToolCall[];
  cardID?: string;
}

export interface User {
  id: string;
  name: string;
  role: string;
  teamID?: string;
  githubUsername?: string;
  language?: string;
  autopilot?: Partial<AutopilotSettings>;
}

export interface OrgNode {
  id: string;
  kind: "person" | "team" | "agent" | "project" | (string & {});
  label: string;
}

export interface OrgEdge {
  id: string;
  fromID: string;
  toID: string;
  kind: "manages" | "memberOf" | "assignedTo" | "canApprove" | (string & {});
}

export interface OrganizationGraph {
  nodes: OrgNode[];
  edges: OrgEdge[];
}

export interface InstructionDraft {
  sourceText: string;
  recipientUserID: string;
  cardType: CardType;
  title: string;
  summary: string;
  context: string;
  priority: CardPriority;
  agentRoute: string;
  routingReason: string;
  labels: string[];
  toolCalls: AgentToolCall[];
  channelID?: string;
}

export const isPending = (card: DecisionCard) => card.status === "pending";
export const isNotification = (card: DecisionCard) => card.type === "notification";
export const isRevisionRequest = (card: DecisionCard) =>
  card.type === "revision" && Boolean(card.revisionNote);
