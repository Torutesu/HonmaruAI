import {
  AcceptInviteRequest,
  CardActionRequest,
  CreateChannelRequest,
  CreateInstructionRequest,
  CreateMessageRequest,
  CreateOrgRequest,
  OpenDmRequest,
  DevLoginRequest,
  GitHubExchangeRequest,
  IntegrationKind,
  MarkNotificationsReadRequest,
  RegisterDeviceRequest,
  UpdateGraphRequest,
  UpdateIntegrationRequest,
  UpdateMemberRequest,
  type CardPriority,
  type DecisionCard,
  type OrgEvent,
  type User,
} from "@honmaru/protocol";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { computeAnalytics, rankCards } from "./analytics.js";
import {
  AuthError,
  authenticate,
  createSession,
  devLogin,
  exchangeGitHubCode,
  upsertGitHubUser,
} from "./auth.js";
import {
  applyCardAction,
  CardError,
  getCard,
  isCardVisibleTo,
  listCardsForUser,
} from "./cards.js";
import {
  ChatError,
  createChannel,
  ensureDefaultChannel,
  getChannel,
  isChannelVisibleTo,
  listChannelsForUser,
  listChatMessages,
  openDm,
} from "./chat.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { currentSeq, listEventsSince } from "./events.js";
import {
  listIntegrationConfigs,
  saveIntegrationConfig,
  type IntegrationRegistry,
} from "./integrations/registry.js";
import type { Logger } from "./log.js";
import { listMemories } from "./memory.js";
import { createMessage, listMessages } from "./messages.js";
import {
  listNotifications,
  markNotificationsRead,
  registerDevice,
} from "./notifications.js";
import {
  acceptInvite,
  createInvite,
  createOrg,
  getMember,
  getOrg,
  listEdges,
  listMembers,
  listOrgsForUser,
  listTeams,
  OrgError,
  replaceGraph,
  requireAdmin,
  requireMember,
  updateMember,
} from "./orgs.js";

export interface HttpDeps {
  db: Db;
  config: Config;
  log: Logger;
  registry: IntegrationRegistry;
  emitEvents: (orgId: string, events: OrgEvent[]) => void;
  // Fast-path instruction pipeline shared with the WS hub.
  createInstruction: (
    orgId: string,
    senderUserId: string,
    text: string,
    priorityOverride?: CardPriority
  ) => { card: DecisionCard; events: OrgEvent[] };
  // Async chat-digest job (chat → decision card bridge).
  enqueueSummarize: (payload: {
    orgId: string;
    channelId: string;
    requesterUserId: string;
  }) => void;
}

export type HttpEnv = { Variables: { user: User } };
type Env = HttpEnv;

const ERROR_STATUS: Record<string, 400 | 401 | 403 | 404 | 409> = {
  unauthorized: 401,
  oauth_not_configured: 400,
  oauth_exchange_failed: 400,
  oauth_profile_failed: 400,
  not_a_member: 403,
  admin_required: 403,
  not_recipient: 403,
  not_allowed: 403,
  invalid_invite: 400,
  card_not_found: 404,
  org_not_found: 404,
  invalid_transition: 409,
  invalid_delegate: 400,
  channel_not_found: 404,
  channel_exists: 409,
  invalid_channel: 400,
  invalid_dm: 400,
  invalid_thread: 400,
};

export function createHttpApp(deps: HttpDeps): Hono<Env> {
  const { db, config, log, registry, emitEvents, createInstruction, enqueueSummarize } = deps;
  const app = new Hono<Env>();

  // Browser clients (web app on another origin). Auth is Bearer-token
  // based, not cookie-based, so a permissive CORS policy is safe here.
  app.use("*", cors());

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      return c.json(
        { code: "invalid_request", message: error.issues[0]?.message ?? "Invalid request." },
        400
      );
    }
    if (
      error instanceof AuthError ||
      error instanceof OrgError ||
      error instanceof CardError ||
      error instanceof ChatError
    ) {
      return c.json(
        { code: error.code, message: error.message },
        ERROR_STATUS[error.code] ?? 400
      );
    }
    log.error({ err: error }, "unhandled http error");
    return c.json({ code: "internal", message: "Internal error." }, 500);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      githubOAuth: Boolean(config.github.clientId && config.github.clientSecret),
      aiRouting: Boolean(config.openRouter),
      devMode: config.authDevMode,
    })
  );

  // --- auth (no token required) -------------------------------------------

  app.post("/v1/auth/github/exchange", async (c) => {
    const body = GitHubExchangeRequest.parse(await c.req.json());
    const { profile } = await exchangeGitHubCode(config, body.code);
    const user = upsertGitHubUser(db, profile);
    const token = createSession(db, user.id, config.sessionTtlDays);
    return c.json({ token, user });
  });

  app.post("/v1/auth/dev", async (c) => {
    if (!config.authDevMode) {
      return c.json(
        { code: "dev_mode_disabled", message: "Dev login is disabled." },
        403
      );
    }
    const body = DevLoginRequest.parse(await c.req.json());
    const user = devLogin(db, body.name);
    const token = createSession(db, user.id, config.sessionTtlDays);
    return c.json({ token, user });
  });

  // --- authenticated routes ------------------------------------------------

  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/auth/")) return next();
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const user = token ? authenticate(db, token) : null;
    if (!user) {
      return c.json(
        { code: "unauthorized", message: "Missing or invalid session token." },
        401
      );
    }
    c.set("user", user);
    return next();
  });

  const me = (c: Context<Env>): User => c.get("user");

  app.get("/v1/me", (c) => {
    const user = me(c);
    return c.json({ user, orgs: listOrgsForUser(db, user.id) });
  });

  app.post("/v1/orgs", async (c) => {
    const body = CreateOrgRequest.parse(await c.req.json());
    const org = createOrg(db, me(c).id, body.name, body.title);
    return c.json({ org }, 201);
  });

  app.get("/v1/orgs/:orgId", (c) => {
    const orgId = c.req.param("orgId");
    requireMember(db, orgId, me(c).id);
    const org = getOrg(db, orgId);
    if (!org) throw new OrgError("org_not_found", "Org not found.");
    return c.json({
      org,
      members: listMembers(db, orgId),
      teams: listTeams(db, orgId),
      edges: listEdges(db, orgId),
    });
  });

  app.post("/v1/orgs/:orgId/invites", (c) => {
    const orgId = c.req.param("orgId");
    requireMember(db, orgId, me(c).id);
    return c.json(createInvite(db, orgId, me(c).id), 201);
  });

  app.post("/v1/invites/accept", async (c) => {
    const body = AcceptInviteRequest.parse(await c.req.json());
    const org = acceptInvite(db, me(c).id, body.code, body.title);
    const events = listEventsSince(db, org.id, currentSeq(db, org.id) - 1);
    emitEvents(org.id, events);
    return c.json({ org });
  });

  app.patch("/v1/orgs/:orgId/members/:userId", async (c) => {
    const orgId = c.req.param("orgId");
    const targetUserId = c.req.param("userId");
    const actor = me(c);
    const body = UpdateMemberRequest.parse(await c.req.json());
    // Members may edit their own title/team; admin rights are required to
    // edit someone else or to grant admin.
    if (targetUserId !== actor.id || body.isAdmin !== undefined) {
      requireAdmin(db, orgId, actor.id);
    } else {
      requireMember(db, orgId, actor.id);
    }
    const member = updateMember(db, orgId, targetUserId, actor.id, body);
    const events = listEventsSince(db, orgId, currentSeq(db, orgId) - 1);
    emitEvents(orgId, events);
    return c.json({ member });
  });

  app.put("/v1/orgs/:orgId/graph", async (c) => {
    const orgId = c.req.param("orgId");
    requireAdmin(db, orgId, me(c).id);
    const body = UpdateGraphRequest.parse(await c.req.json());
    const graph = replaceGraph(db, orgId, me(c).id, body.teams, body.edges);
    const events = listEventsSince(db, orgId, currentSeq(db, orgId) - 1);
    emitEvents(orgId, events);
    return c.json(graph);
  });

  app.get("/v1/orgs/:orgId/cards", (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    requireMember(db, orgId, user.id);
    // Feed order: AI-ranked (priority × waiting time × sender relation).
    return c.json({
      cards: rankCards(
        listCardsForUser(db, orgId, user.id),
        listEdges(db, orgId)
      ),
      seq: currentSeq(db, orgId),
    });
  });

  app.post("/v1/orgs/:orgId/instructions", async (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    const body = CreateInstructionRequest.parse(await c.req.json());
    const { card, events } = createInstruction(
      orgId,
      user.id,
      body.text,
      body.priorityOverride
    );
    emitEvents(orgId, events);
    return c.json({ card }, 201);
  });

  app.get("/v1/cards/:cardId/messages", (c) => {
    const cardId = c.req.param("cardId");
    const user = me(c);
    const card = getCard(db, cardId);
    if (!card) throw new CardError("card_not_found", "Card not found.");
    requireMember(db, card.orgId, user.id);
    if (!isCardVisibleTo(card, user.id)) {
      throw new CardError("not_allowed", "You cannot view this thread.");
    }
    return c.json({ messages: listMessages(db, cardId) });
  });

  app.post("/v1/cards/:cardId/messages", async (c) => {
    const cardId = c.req.param("cardId");
    const user = me(c);
    const card = getCard(db, cardId);
    if (!card) throw new CardError("card_not_found", "Card not found.");
    requireMember(db, card.orgId, user.id);
    const body = CreateMessageRequest.parse(await c.req.json());
    const { message, events } = createMessage(db, user.id, cardId, body.text);
    emitEvents(card.orgId, events);
    return c.json({ message }, 201);
  });

  app.get("/v1/orgs/:orgId/notifications", (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    requireMember(db, orgId, user.id);
    return c.json(listNotifications(db, orgId, user.id));
  });

  app.post("/v1/notifications/read", async (c) => {
    const user = me(c);
    const body = MarkNotificationsReadRequest.parse(await c.req.json());
    const updated = markNotificationsRead(db, user.id, body);
    return c.json({ updated });
  });

  app.post("/v1/devices", async (c) => {
    const user = me(c);
    const body = RegisterDeviceRequest.parse(await c.req.json());
    registerDevice(db, user.id, body.platform, body.token);
    return c.json({ ok: true }, 201);
  });

  // --- classic chat (channels + DMs) --------------------------------------

  app.get("/v1/orgs/:orgId/channels", (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    requireMember(db, orgId, user.id);
    ensureDefaultChannel(db, orgId);
    return c.json({ channels: listChannelsForUser(db, orgId, user.id) });
  });

  app.post("/v1/orgs/:orgId/channels", async (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    requireMember(db, orgId, user.id);
    const body = CreateChannelRequest.parse(await c.req.json());
    const { channel, events } = createChannel(db, orgId, user.id, body.name);
    emitEvents(orgId, events);
    return c.json({ channel }, 201);
  });

  app.post("/v1/orgs/:orgId/dms", async (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    requireMember(db, orgId, user.id);
    const body = OpenDmRequest.parse(await c.req.json());
    const { channel, events } = openDm(db, orgId, user.id, body.userId);
    emitEvents(orgId, events);
    return c.json({ channel });
  });

  // Queue an AI digest of the channel; the card arrives on the
  // requester's feed via the event stream.
  app.post("/v1/channels/:channelId/summarize", (c) => {
    const channelId = c.req.param("channelId");
    const user = me(c);
    const channel = getChannel(db, channelId);
    if (!channel) throw new ChatError("channel_not_found", "Channel not found.");
    requireMember(db, channel.orgId, user.id);
    if (!isChannelVisibleTo(channel, user.id)) {
      throw new ChatError("not_allowed", "You are not in this conversation.");
    }
    enqueueSummarize({
      orgId: channel.orgId,
      channelId,
      requesterUserId: user.id,
    });
    return c.json({ queued: true }, 202);
  });

  app.get("/v1/channels/:channelId/messages", (c) => {
    const channelId = c.req.param("channelId");
    const user = me(c);
    const channel = getChannel(db, channelId);
    if (!channel) throw new ChatError("channel_not_found", "Channel not found.");
    requireMember(db, channel.orgId, user.id);
    if (!isChannelVisibleTo(channel, user.id)) {
      throw new ChatError("not_allowed", "You are not in this conversation.");
    }
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    return c.json({ messages: listChatMessages(db, channelId, limit) });
  });

  // What the org's AIs have learned about each member (context layer).
  app.get("/v1/orgs/:orgId/memory", (c) => {
    const orgId = c.req.param("orgId");
    requireMember(db, orgId, me(c).id);
    const userId = c.req.query("userId");
    return c.json({ memories: listMemories(db, orgId, userId || undefined) });
  });

  app.get("/v1/orgs/:orgId/analytics", (c) => {
    const orgId = c.req.param("orgId");
    requireMember(db, orgId, me(c).id);
    return c.json(computeAnalytics(db, orgId));
  });

  app.post("/v1/cards/:cardId/actions", async (c) => {
    const cardId = c.req.param("cardId");
    const user = me(c);
    const existing = getCard(db, cardId);
    if (!existing) throw new CardError("card_not_found", "Card not found.");
    requireMember(db, existing.orgId, user.id);
    if (!isCardVisibleTo(existing, user.id)) {
      throw new CardError("not_allowed", "You cannot act on this card.");
    }
    const body = CardActionRequest.parse(await c.req.json());
    const { card, events } = applyCardAction(db, user.id, cardId, body.action, {
      note: body.note,
      delegateToUserId: body.delegateToUserId,
    });
    emitEvents(existing.orgId, events);
    return c.json({ card });
  });

  app.get("/v1/orgs/:orgId/events", (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    requireMember(db, orgId, user.id);
    const sinceSeq = Number(c.req.query("sinceSeq") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 500), 1000);
    const events = listEventsSince(db, orgId, sinceSeq, limit).filter(
      (event) => {
        if (event.type === "card_created" || event.type === "card_updated") {
          return isCardVisibleTo(event.payload.card, user.id);
        }
        if (event.type === "card_deleted") {
          return (
            event.payload.recipientUserId === user.id ||
            event.payload.senderUserId === user.id
          );
        }
        if (event.type === "message_created") {
          return (
            event.payload.cardSenderUserId === user.id ||
            event.payload.cardRecipientUserId === user.id ||
            event.payload.watcherUserIds.includes(user.id) ||
            event.payload.mentionedUserIds.includes(user.id)
          );
        }
        return true;
      }
    );
    return c.json({ events, seq: currentSeq(db, orgId) });
  });

  app.get("/v1/orgs/:orgId/integrations", (c) => {
    const orgId = c.req.param("orgId");
    requireAdmin(db, orgId, me(c).id);
    // Tokens stay server-side: config values are redacted on read.
    const integrations = listIntegrationConfigs(db, orgId).map((item) => ({
      ...item,
      config: Object.fromEntries(
        Object.entries(item.config).map(([key, value]) => [
          key,
          key === "token" ? "•••" : value,
        ])
      ),
    }));
    return c.json({ integrations });
  });

  app.put("/v1/orgs/:orgId/integrations/:kind", async (c) => {
    const orgId = c.req.param("orgId");
    requireAdmin(db, orgId, me(c).id);
    const kind = IntegrationKind.parse(c.req.param("kind"));
    const body = UpdateIntegrationRequest.parse(await c.req.json());
    const integration = registry.get(kind);
    if (!integration) {
      return c.json({ code: "unknown_integration", message: "Unknown kind." }, 404);
    }
    if (body.enabled) {
      integration.configSchema.parse(body.config);
    }
    saveIntegrationConfig(db, orgId, kind, body.enabled, body.config);
    return c.json({ ok: true });
  });

  return app;
}
