import { routeInstruction } from "./routing.js";
import { toolManifest } from "./agui/tools.js";
import { createSession, getSession, upsertUser, upsertMembership, upsertAgent, isMember } from "./db.js";
import { listCardEvents, listOrgEvents } from "./events.js";
import { fetchCollaborators } from "./github.js";
import { buildOrgGraph, roleName } from "./org.js";
import { uploadMedia, serveMedia } from "./media.js";

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
  async fetch(request, env) {
    const url = new URL(request.url);
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
      });
    }
    if (url.pathname === "/agui/tools" && request.method === "GET") {
      return json(toolManifest());
    }
    if (url.pathname === "/ai/route" && request.method === "POST") {
      const body = await request.json();
      const userKey = request.headers.get("x-ai-key") || undefined;
      const result = await routeInstruction({
        text: body.text,
        sender: body.sender,
        organization: body.organization,
        priorityOverride: body.priorityOverride,
        readerLanguage: body.readerLanguage,
        senderContext: body.senderContext,
        openRouter: providerConfig(env, userKey),
      });
      return json(result);
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
    if (url.pathname === "/oauth/github/token" && request.method === "POST") {
      const { code } = await request.json();
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
      const sessionToken = await createSession(env.DB, String(ghUser.id), data.access_token);
      return json({ accessToken: data.access_token, tokenType: "bearer", sessionToken });
    }
    if (url.pathname === "/media" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      return uploadMedia(request, env, url);
    }
    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
    if (mediaMatch && request.method === "GET") {
      return serveMedia(mediaMatch[1], env);
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
  },
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
