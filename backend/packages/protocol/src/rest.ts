import { z } from "zod";
import {
  CardAction,
  CardMessage,
  CardPriority,
  DecisionCard,
  DevicePlatform,
  IntegrationConfig,
  IntegrationKind,
  Member,
  Notification,
  Org,
  OrgEdge,
  OrgEdgeKind,
  Team,
  User,
} from "./entities.js";

// ---------------------------------------------------------------------------
// REST API v1. All routes are prefixed /v1 and (except auth + health)
// require `Authorization: Bearer <session token>`.
// ---------------------------------------------------------------------------

// POST /v1/auth/github/exchange
export const GitHubExchangeRequest = z.object({ code: z.string() });
export const AuthResponse = z.object({ token: z.string(), user: User });

// POST /v1/auth/dev (only when AUTH_DEV_MODE=1)
export const DevLoginRequest = z.object({
  name: z.string().min(1).max(80),
});

// GET /v1/me
export const MeResponse = z.object({
  user: User,
  orgs: z.array(Org),
});

// POST /v1/orgs
export const CreateOrgRequest = z.object({
  name: z.string().min(1).max(120),
  title: z.string().min(1).max(120).default("Founder"),
});

// GET /v1/orgs/:orgId
export const OrgDetailResponse = z.object({
  org: Org,
  members: z.array(Member),
  teams: z.array(Team),
  edges: z.array(OrgEdge),
});

// POST /v1/orgs/:orgId/invites
export const CreateInviteResponse = z.object({
  code: z.string(),
  expiresAt: z.string(),
});

// POST /v1/invites/accept
export const AcceptInviteRequest = z.object({
  code: z.string(),
  title: z.string().min(1).max(120).default("Member"),
});

// PATCH /v1/orgs/:orgId/members/:userId
export const UpdateMemberRequest = z.object({
  title: z.string().min(1).max(120).optional(),
  teamId: z.string().nullish(),
  isAdmin: z.boolean().optional(),
});

// PUT /v1/orgs/:orgId/graph  (admin; replaces teams + edges atomically)
export const UpdateGraphRequest = z.object({
  teams: z.array(Team.omit({ orgId: true })),
  edges: z.array(
    z.object({ kind: OrgEdgeKind, fromId: z.string(), toId: z.string() })
  ),
});

// POST /v1/orgs/:orgId/instructions
export const CreateInstructionRequest = z.object({
  text: z.string().min(1).max(4000),
  priorityOverride: CardPriority.optional(),
});
export const CreateInstructionResponse = z.object({ card: DecisionCard });

// GET /v1/orgs/:orgId/cards?box=inbox|sent|all
export const ListCardsResponse = z.object({
  cards: z.array(DecisionCard),
  seq: z.number().int(),
});

// POST /v1/cards/:cardId/actions
export const CardActionRequest = z.object({
  action: CardAction,
  note: z.string().max(2000).optional(),
  delegateToUserId: z.string().optional(),
});
export const CardActionResponse = z.object({
  card: DecisionCard.nullish(),
});

// GET /v1/orgs/:orgId/events?sinceSeq=N&limit=M
// -> { events: OrgEvent[] } (see events.ts)

// PUT /v1/orgs/:orgId/integrations/:kind (admin only)
export const UpdateIntegrationRequest = z.object({
  enabled: z.boolean(),
  config: z.record(z.unknown()).default({}),
});
export const ListIntegrationsResponse = z.object({
  integrations: z.array(IntegrationConfig),
});

// GET /v1/cards/:cardId/messages · POST /v1/cards/:cardId/messages
export const CreateMessageRequest = z.object({
  text: z.string().min(1).max(4000),
});
export const ListMessagesResponse = z.object({
  messages: z.array(CardMessage),
});

// GET /v1/orgs/:orgId/notifications
export const ListNotificationsResponse = z.object({
  notifications: z.array(Notification),
  unreadCount: z.number().int(),
});

// POST /v1/notifications/read
export const MarkNotificationsReadRequest = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

// POST /v1/devices — register a push token (APNs/FCM/WebPush endpoint)
export const RegisterDeviceRequest = z.object({
  platform: DevicePlatform,
  token: z.string().min(1),
});

// GET /v1/orgs/:orgId/analytics
export const MemberAnalytics = z.object({
  userId: z.string(),
  name: z.string(),
  pendingCount: z.number().int(),
  oldestPendingAgeSeconds: z.number().nullable(),
  decidedCount: z.number().int(),
  avgDecisionSeconds: z.number().nullable(),
});
export const AnalyticsResponse = z.object({
  totalCards: z.number().int(),
  pendingCards: z.number().int(),
  decidedCards: z.number().int(),
  avgDecisionSeconds: z.number().nullable(),
  perMember: z.array(MemberAnalytics),
  // Members ranked by how much decision flow is stuck on them.
  bottlenecks: z.array(z.string()),
});

// GET /v1/orgs/:orgId/channels · POST /v1/orgs/:orgId/channels
export const CreateChannelRequest = z.object({
  name: z.string().min(1).max(60),
});

// POST /v1/orgs/:orgId/dms — open (or return existing) DM with a member
export const OpenDmRequest = z.object({
  userId: z.string(),
});

// GET /v1/channels/:channelId/messages?limit=N
// POST /v1/channels/:channelId/messages
export const CreateChatMessageRequest = z.object({
  text: z.string().min(1).max(4000),
  parentMessageId: z.string().optional(),
});

export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
});

export { IntegrationKind };
