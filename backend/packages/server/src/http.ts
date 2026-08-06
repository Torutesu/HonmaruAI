import {
  AcceptInviteRequest,
  CardActionRequest,
  CreateInstructionRequest,
  CreateOrgRequest,
  DevLoginRequest,
  GitHubExchangeRequest,
  IntegrationKind,
  UpdateGraphRequest,
  UpdateIntegrationRequest,
  UpdateMemberRequest,
  type OrgEvent,
  type User,
} from "@honmaru/protocol";
import { Hono, type Context } from "hono";
import { ZodError } from "zod";
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
  createCardFromRouting,
  getCard,
  isCardVisibleTo,
  listCardsForUser,
} from "./cards.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { currentSeq, listEventsSince } from "./events.js";
import {
  listIntegrationConfigs,
  saveIntegrationConfig,
  type IntegrationRegistry,
} from "./integrations/registry.js";
import type { Logger } from "./log.js";
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
import { routeInstruction } from "./routing.js";

export interface HttpDeps {
  db: Db;
  config: Config;
  log: Logger;
  registry: IntegrationRegistry;
  emitEvents: (orgId: string, events: OrgEvent[]) => void;
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
};

export function createHttpApp(deps: HttpDeps): Hono<Env> {
  const { db, config, log, registry, emitEvents } = deps;
  const app = new Hono<Env>();

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
      error instanceof CardError
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
    return c.json({
      cards: listCardsForUser(db, orgId, user.id),
      seq: currentSeq(db, orgId),
    });
  });

  app.post("/v1/orgs/:orgId/instructions", async (c) => {
    const orgId = c.req.param("orgId");
    const user = me(c);
    const sender = requireMember(db, orgId, user.id);
    const body = CreateInstructionRequest.parse(await c.req.json());
    const routing = await routeInstruction(
      {
        text: body.text,
        sender,
        members: listMembers(db, orgId),
        teams: listTeams(db, orgId),
        edges: listEdges(db, orgId),
        priorityOverride: body.priorityOverride,
      },
      config.openRouter,
      log
    );
    const { card, events } = createCardFromRouting(
      db,
      orgId,
      user.id,
      body.text,
      routing
    );
    emitEvents(orgId, events);
    return c.json({ card }, 201);
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
