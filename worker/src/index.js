import { routeInstruction } from "./routing.js";
import { toolManifest } from "./agui/tools.js";
import {
  createSession, getSession, upsertUser, upsertMembership, upsertAgent, isMember,
  getConnectorConfig, setConnectorConfig, createOAuthState, consumeOAuthState,
  getUserByGithubId, registerDevice, removeDevice,
} from "./db.js";
import { enforce } from "./ratelimit.js";
import { deleteAccount } from "./account.js";
import { isConfigured } from "./apns.js";
import { runScheduledSync } from "./scheduled.js";
import { logJSON, routeLabel, safe } from "./log.js";
import { listCardEvents, listOrgEvents } from "./events.js";
import { fetchCollaborators } from "./github.js";
import { buildOrgGraph, roleName } from "./org.js";
import { uploadMedia, serveMedia } from "./media.js";
import { CONNECTORS, connectorById } from "./connectors/index.js";
import { createConnectLink, listConnectedAccounts, executeTool } from "./composio.js";
import { syncAll } from "./sync.js";
import { checkAIAllowance } from "./gate.js";

export { OrgRelay } from "./relay.js";

// A user's own key is never stored on our side — it arrives per request and is
// used for that request only. Never log it.
function providerConfig(env, userKey) {
  const openaiKey = userKey || env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      providerName: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free",
      appName: "TikTok for Work",
      appUrl: "https://tiktokforwork.dev",
    };
  }
  return undefined;
}

// Returns an error Response when the caller may not read this org's history, or
// null when they may. History is served straight from D1, so unlike the org
// graph — where GitHub enforces access when we call its API — nothing else would
// stop one org reading another's.
async function requireMember(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "invalid session" }, 401);
  if (!(await isMember(env.DB, orgId, session.github_id))) {
    return json({ message: "not a member of this org" }, 403);
  }
  return null;
}

export default {
  // Every 15 minutes, so a decision that arrived in someone's inbox is already
  // a card by the time they look. Nothing here bypasses the free-tier meter:
  // the sync loop checks the same allowance a manual sync does.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },

  async fetch(request, env, ctx) {
    // Every response carries the id its log line was written under, so a user
    // reporting "it failed" hands over something that finds the line.
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    const route = routeLabel(request.method, url.pathname);
    try {
      const response = await handle(request, env, url);
      logJSON({ requestId, route, status: response.status, ms: Date.now() - startedAt });
      // A 101 carries the client end of the socket pair on a property, not in
      // the body. Rebuilding it to add a header would hand back a response with
      // no socket attached — every realtime connection, silently dead.
      if (response.status === 101 || response.webSocket) return response;
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      // An unhandled throw used to become a raw Workers 500 with a stack trace
      // in it. A malformed JSON body was enough.
      logJSON({ requestId, route, status: 500, ms: Date.now() - startedAt, error: safe(err?.message) });
      return new Response(
        JSON.stringify({ message: "Something went wrong on our side.", requestId }),
        { status: 500, headers: { "content-type": "application/json", "x-request-id": requestId } }
      );
    }
  },
};

async function handle(request, env, url) {
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        orgId: "core-team",
        githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        aiRouting: Boolean(env.OPENAI_API_KEY || env.OPENROUTER_API_KEY),
        aiModel: env.OPENAI_API_KEY
          ? env.OPENAI_MODEL || "gpt-4o-mini"
          : env.OPENROUTER_API_KEY
            ? env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free"
            : "fallback",
        push: isConfigured(env),
      });
    }
    if (url.pathname === "/agui/tools" && request.method === "GET") {
      return json(toolManifest());
    }
    if (url.pathname === "/ai/route" && request.method === "POST") {
      const limited = await enforce(env, request, "ai/route");
      if (limited) return limited;
      const body = await request.json();
      const userKey = request.headers.get("x-ai-key") || undefined;
      // The route is usable without a session (guests), but only a session can
      // be metered — and an unmetered guest must not spend our AI budget.
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const allowance = await checkAIAllowance(env, {
        githubId: session ? String(session.github_id) : null,
        userKey,
      });

      const result = await routeInstruction({
        text: body.text,
        sender: body.sender,
        organization: body.organization,
        priorityOverride: body.priorityOverride,
        readerLanguage: body.readerLanguage,
        senderContext: body.senderContext,
        // No provider means the local keyword router — the graceful degradation.
        openRouter: allowance.allowed ? providerConfig(env, userKey) : undefined,
      });
      // Only a model that actually answered is billable — including one whose
      // answer we then rejected, which still comes back as routedBy "fallback".
      // A provider outage never burns someone's three.
      const modelAnswered = allowance.allowed && result.aiCalled === true;
      if (modelAnswered && allowance.metered) await allowance.consume();
      // Internal to the meter. Stripped so the wire format is unchanged.
      delete result.aiCalled;

      return json(allowance.quotaExceeded ? { ...result, quotaExceeded: true } : result);
    }
    if (url.pathname === "/oauth/github/config" && request.method === "GET") {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return json({ message: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET as Worker secrets" }, 503);
      }
      return json({
        clientId: env.GITHUB_CLIENT_ID,
        redirectUri: env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback",
        scope: env.GITHUB_OAUTH_SCOPE || "repo",
      });
    }
    // Minted here, spent on the callback. The client puts it on the authorize
    // URL as `state` and refuses a callback that comes back with a different
    // one; we refuse a code that arrives without a nonce we issued.
    if (url.pathname === "/oauth/github/state" && request.method === "GET") {
      const limited = await enforce(env, request, "oauth/state");
      if (limited) return limited;
      return json({ state: await createOAuthState(env.DB) });
    }
    if (url.pathname === "/oauth/github/token" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const { code, state } = await request.json();
      if (!(await consumeOAuthState(env.DB, state))) {
        return json({ message: "This sign-in has expired. Try again." }, 400);
      }
      const ghRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback",
        }),
      });
      const data = await ghRes.json();
      if (!data.access_token) {
        return json({ message: data.error_description || "token exchange failed" }, 400);
      }
      const userRes = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${data.access_token}`, "user-agent": "tiktokforwork" },
      });
      const ghUser = await userRes.json();
      if (!ghUser?.id) return json({ message: "GitHub did not identify this token" }, 502);
      // The user row used to appear only when someone loaded the org graph,
      // which happens after the socket connects — so the relay could not name
      // the person who had just signed in. Identity is established here, where
      // it is first known.
      await upsertUser(env.DB, {
        githubId: ghUser.id, login: ghUser.login, name: ghUser.name,
        avatarUrl: ghUser.avatar_url, locale: "en",
      });
      const sessionToken = await createSession(env.DB, String(ghUser.id), data.access_token);
      return json({ accessToken: data.access_token, tokenType: "bearer", sessionToken });
    }
    if (url.pathname === "/media" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const limited = await enforce(env, request, "media");
      if (limited) return limited;
      return uploadMedia(request, env, url);
    }
    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
    if (mediaMatch && request.method === "GET") {
      return serveMedia(mediaMatch[1], env);
    }
    // Registered after the user grants permission, and re-registered on every
    // launch — APNs reissues tokens, and a stale one is a silent no-op.
    if (url.pathname === "/devices" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json();
      if (!body.deviceToken) return json({ message: "deviceToken is required" }, 400);
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (!user?.login) return json({ message: "unknown user" }, 409);
      await registerDevice(env.DB, {
        deviceToken: body.deviceToken,
        githubId: session.github_id,
        login: user.login,
        environment: body.environment,
      });
      return json({ ok: true });
    }
    if (url.pathname === "/devices" && request.method === "DELETE") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json();
      if (body.deviceToken) await removeDevice(env.DB, body.deviceToken);
      return json({ ok: true });
    }
    if (url.pathname === "/account" && request.method === "DELETE") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const user = await getUserByGithubId(env.DB, session.github_id);
      await deleteAccount(env.DB, session.github_id, user?.login || null);
      return json({ ok: true });
    }
    const orgGraphMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/graph$/);
    if (orgGraphMatch && request.method === "GET") {
      const [, owner, repo] = orgGraphMatch;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const orgId = `${owner}/${repo}`;
      let collaborators;
      try {
        collaborators = await fetchCollaborators(session.github_access_token, owner, repo);
      } catch (err) {
        return json({ message: err.message }, 502);
      }
      const graph = buildOrgGraph(collaborators, { owner, repo });
      for (const c of collaborators) {
        await upsertUser(env.DB, { githubId: c.id, login: c.login, name: c.login, avatarUrl: c.avatar_url, locale: "en" });
        await upsertMembership(env.DB, orgId, c.id, roleName(c.permissions));
        await upsertAgent(env.DB, orgId, c.id, `${c.login}'s AI`);
      }
      return json(graph);
    }
    const cardEventsMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/cards\/([^/]+)\/events$/);
    if (cardEventsMatch && request.method === "GET") {
      const [, owner, repo, cardId] = cardEventsMatch;
      const orgId = `${owner}/${repo}`;
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({ events: await listCardEvents(env.DB, orgId, cardId) });
    }
    if (url.pathname === "/connectors" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      let accounts = [];
      try {
        accounts = await listConnectedAccounts(env.COMPOSIO_API_KEY, String(session.github_id));
      } catch (err) {
        return json({ message: err.message }, 502);
      }
      const active = new Set(
        accounts
          .filter((a) => String(a.status).toUpperCase() === "ACTIVE")
          .map((a) => (typeof a.toolkit === "string" ? a.toolkit : a.toolkit?.slug))
      );
      return json({
        connectors: CONNECTORS.map((c) => ({
          id: c.id, label: c.label, status: active.has(c.id) ? "active" : "none",
        })),
      });
    }

    const connectMatch = url.pathname.match(/^\/connectors\/([^/]+)\/connect$/);
    if (connectMatch && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      const connector = connectorById(connectMatch[1]);
      if (!connector) return json({ message: "unknown connector" }, 404);

      try {
        const link = await createConnectLink(
          env.COMPOSIO_API_KEY, String(session.github_id), connector.authConfigId
        );
        return json({ redirectUrl: link.redirect_url, connectedAccountId: link.connected_account_id });
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }

    if (url.pathname === "/connectors/notion/databases" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);
      try {
        // filter_property:"object" + filter_value:"database" is what the live
        // API needs to return only databases; a bare filter_value lets pages
        // through (README, Notion verified 2026-08-10).
        const payload = await executeTool(
          env.COMPOSIO_API_KEY, "NOTION_SEARCH_NOTION_PAGE",
          String(session.github_id),
          { query: "", filter_value: "database", filter_property: "object" }
        );
        const rows = payload?.data?.results ?? payload?.data?.databases ?? [];
        const databases = rows.map((d) => ({
          id: d.id,
          // A database title is a rich-text array, never a plain string.
          title: Array.isArray(d.title)
            ? d.title.map((t) => t.plain_text || "").join("").trim() || "Untitled"
            : (d.title || "Untitled"),
        }));
        return json({ databases });
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }

    if (url.pathname === "/connectors/notion/config" && request.method === "PUT") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json();
      if (!body.databaseId) return json({ message: "databaseId is required" }, 400);
      await setConnectorConfig(env.DB, session.github_id, "notion", { databaseId: body.databaseId });
      return json({ ok: true });
    }

    if (url.pathname === "/connectors/notion/config" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      // Chosen-nothing is a normal state, not a 404: the app persists locally but
      // must be able to recover the server's truth on a fresh install or a second
      // device. Always return the same key the PUT accepts, null when unset, so
      // the client reads one field and never special-cases a status code.
      const config = await getConnectorConfig(env.DB, session.github_id, "notion");
      return json({ databaseId: config?.databaseId ?? null });
    }

    const syncMatch = url.pathname === "/connectors/sync"
      || url.pathname.match(/^\/connectors\/([^/]+)\/sync$/);
    if (syncMatch && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);
      const limited = await enforce(env, request, "connectors/sync");
      if (limited) return limited;

      const body = await request.json();
      if (!body.orgId || !body.userId) return json({ message: "orgId and userId are required" }, 400);

      // A single-connector path keeps TestFlight build 28 working; it shipped
      // calling /connectors/gmail/sync and returns the flat shape.
      const only = typeof syncMatch === "object" ? connectorById(syncMatch[1]) : null;
      if (typeof syncMatch === "object" && !only) return json({ message: "unknown connector" }, 404);

      const results = await syncAll(only ? [only] : CONNECTORS, {
        env, session,
        orgId: body.orgId, userId: body.userId,
        readerLanguage: body.readerLanguage,
        provider: providerConfig(env),
      });

      if (only) {
        const r = results[0];
        return r.error ? json({ message: r.error }, 502) : json({ scanned: r.scanned, created: r.created });
      }
      return json({ results });
    }
    const orgEventsMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/events$/);
    if (orgEventsMatch && request.method === "GET") {
      const [, owner, repo] = orgEventsMatch;
      const orgId = `${owner}/${repo}`;
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      return json({ events: await listOrgEvents(env.DB, orgId, limit) });
    }
    if (request.headers.get("Upgrade") === "websocket") {
      const orgId = url.searchParams.get("orgId") || "core-team";
      const id = env.ORG_RELAY.idFromName(orgId);
      const stub = env.ORG_RELAY.get(id);
      return stub.fetch(request);
    }
    return new Response("not found", { status: 404 });
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
