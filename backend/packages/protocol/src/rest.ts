import { z } from "zod";
import {
  CardAction,
  CardPriority,
  DecisionCard,
  IntegrationConfig,
  IntegrationKind,
  Member,
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

export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
});

export { IntegrationKind };
