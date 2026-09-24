import { getSession, isMember, getUserByGithubId } from "./db.js";
import { ROLE_RANK } from "./auth.js";
import { enforce } from "./ratelimit.js";
import { listMembers } from "./team.js";
import { parseSchedule, describeSchedule } from "./schedule.js";
import {
  validateRoutineInput, createRoutine, listRoutines, getRoutine, updateRoutine, deleteRoutine,
  runRoutine, publicRoutine, briefInstruction,
} from "./routines.js";
import { listMemories, getMemory, addMemory, updateMemory, deleteMemory, forgetMemories } from "./memory.js";
import { createApiToken, listApiTokens, revokeApiToken, handleMcp, TOOLS } from "./mcp.js";

// The routes for what the AI does on its own: routines, the playbook, and
// the tokens agents use to reach the team. One module, so index.js — already
// the longest file here — only has to hand these paths over.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS },
  });
}

async function isAdmin(db, orgId, githubId) {
  const row = await db
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(githubId))
    .first();
  return Boolean(row) && (ROLE_RANK.get(String(row.role || "member").toLowerCase()) ?? 0) >= ROLE_RANK.get("admin");
}

/// Session, user and membership, or the Response that says which is missing.
async function caller(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return { denied: json({ message: "Please sign in." }, 401) };
  if (!orgId || typeof orgId !== "string") return { denied: json({ message: "orgId is required" }, 400) };
  if (!(await isMember(env.DB, orgId, session.github_id))) return { denied: json({ message: "not a member of this org" }, 403) };
  const user = await getUserByGithubId(env.DB, session.github_id);
  if (!user?.login) return { denied: json({ message: "Please sign in." }, 401) };
  return { session, user };
}

/// A recipient a client named — "member:<ref>", their own login, or
/// nothing — to a member's login. Undefined when it names nobody here.
async function resolveRecipient(env, orgId, user, value) {
  if (value === undefined || value === null || value === "" || value === "me" || value === user.login) return user.login;
  if (typeof value !== "string") return undefined;
  const members = await listMembers(env.DB, orgId, user.github_id);
  const ref = value.replace(/^member:/, "");
  return members.find((m) => m.ref === ref)?.login;
}

async function withRecipient(env, orgId, user, r, locale) {
  if (r.recipient_login === user.login) return publicRoutine(r, { locale, recipientName: user.name || user.login });
  const members = await listMembers(env.DB, orgId, user.github_id);
  const m = members.find((x) => x.login === r.recipient_login);
  return publicRoutine(r, { locale, recipientName: m?.name || "—", recipientRef: m ? `member:${m.ref}` : null });
}

export async function handleAutomation(request, env, url) {
  const path = url.pathname;
  if (path === "/mcp") return handleMcp(request, env);
  if (request.method === "OPTIONS") return null;

  // ---- Routines ----
  if (path === "/routines/parse" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text.slice(0, 2000) : "";
    const parsed = parseSchedule(text);
    const locale = body?.locale === "ja" ? "ja" : "en";
    if (!parsed) return json({ parsed: null });
    return json({ parsed: { ...parsed, schedule: describeSchedule(parsed, locale) } });
  }

  if (path === "/routines" && (request.method === "GET" || request.method === "POST")) {
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (request.method === "POST" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
    const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const locale = who.user.locale === "ja" ? "ja" : "en";
    if (request.method === "GET") {
      const rows = await listRoutines(env.DB, orgId, who.session.github_id);
      const routines = [];
      for (const r of rows) routines.push(await withRecipient(env, orgId, who.user, r, locale));
      return json({ routines, briefInstruction: briefInstruction(locale) });
    }
    const checked = validateRoutineInput(body, { locale });
    if (checked.error) return json({ message: checked.error }, 400);
    const recipientLogin = await resolveRecipient(env, orgId, who.user, body.recipient);
    if (!recipientLogin) return json({ message: "That recipient is not a current member of this workspace." }, 400);
    const out = await createRoutine(env.DB, {
      orgId, owner: { github_id: who.session.github_id, login: who.user.login }, recipientLogin, input: checked.value,
    });
    if (out.error) return json({ message: out.error }, out.status || 400);
    return json({ routine: await withRecipient(env, orgId, who.user, out.routine, locale) }, 201);
  }

  const routineMatch = path.match(/^\/routines\/([^/]+)(\/run)?$/);
  if (routineMatch && ["PUT", "DELETE", "POST"].includes(request.method)) {
    const limited = await enforce(env, request, routineMatch[2] ? "ai/route" : "team");
    if (limited) return limited;
    const id = decodeURIComponent(routineMatch[1]);
    const body = request.method === "DELETE" ? null : await request.json().catch(() => null);
    const orgId = request.method === "DELETE" ? url.searchParams.get("orgId") : body?.orgId;
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const locale = who.user.locale === "ja" ? "ja" : "en";
    const current = await getRoutine(env.DB, orgId, id);
    // Somebody else's routine does not exist, as far as this caller knows.
    if (!current || current.owner_github_id !== String(who.session.github_id)) return json({ message: "no such routine" }, 404);

    if (request.method === "DELETE") {
      await deleteRoutine(env.DB, orgId, id);
      return json({ deleted: true });
    }
    if (routineMatch[2]) {
      if (request.method !== "POST") return json({ message: "POST to run." }, 405);
      const out = await runRoutine(env, current, { manual: true });
      if (out.error) return json({ message: out.error === "not a member" ? "The recipient is no longer in this workspace." : "The routine did not run. Try again." }, out.error === "not a member" ? 409 : 502);
      const fresh = await getRoutine(env.DB, orgId, id);
      return json({ cardId: out.card.id, routine: await withRecipient(env, orgId, who.user, fresh, locale) });
    }
    if (request.method !== "PUT") return json({ message: "PUT to change, DELETE to remove." }, 405);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const checked = validateRoutineInput(body, { partial: true, locale });
    if (checked.error) return json({ message: checked.error }, 400);
    let recipientLogin;
    if (body.recipient !== undefined) {
      recipientLogin = await resolveRecipient(env, orgId, who.user, body.recipient);
      if (!recipientLogin) return json({ message: "That recipient is not a current member of this workspace." }, 400);
    }
    const updated = await updateRoutine(env.DB, orgId, id, checked.value, { recipientLogin });
    return json({ routine: await withRecipient(env, orgId, who.user, updated, locale) });
  }

  // ---- The playbook ----
  if (path === "/memories" && ["GET", "POST", "DELETE"].includes(request.method)) {
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (request.method === "POST" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
    const orgId = request.method === "POST" ? body.orgId : url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const admin = await isAdmin(env.DB, orgId, who.session.github_id);
    if (request.method === "GET") {
      const memories = await listMemories(env.DB, orgId);
      return json({
        memories: memories.map((m) => ({ ...m, canEdit: admin || m.createdBy === who.user.login })),
        canForget: admin,
      });
    }
    if (request.method === "DELETE") {
      if (!admin) return json({ message: "Only an admin can clear the playbook." }, 403);
      const learnedOnly = url.searchParams.get("learned") === "1";
      const removed = await forgetMemories(env.DB, orgId, { learnedOnly });
      return json({ removed });
    }
    const memory = await addMemory(env.DB, orgId, { text: body.text, origin: "told", createdBy: who.user.login });
    if (!memory) return json({ message: "Write the rule." }, 400);
    return json({ memory: { ...memory, canEdit: true } }, 201);
  }

  const memoryMatch = path.match(/^\/memories\/([^/]+)$/);
  if (memoryMatch && (request.method === "PUT" || request.method === "DELETE")) {
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const id = decodeURIComponent(memoryMatch[1]);
    const body = request.method === "PUT" ? await request.json().catch(() => null) : null;
    const orgId = request.method === "PUT" ? body?.orgId : url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const memory = await getMemory(env.DB, orgId, id);
    if (!memory) return json({ message: "no such rule" }, 404);
    // A rule is the team's; changing it is for whoever wrote it — or whose
    // decision taught it — and the team's admins.
    const admin = await isAdmin(env.DB, orgId, who.session.github_id);
    if (!admin && memory.createdBy !== who.user.login) return json({ message: "Only whoever wrote this rule, or an admin, can change it." }, 403);
    if (request.method === "DELETE") {
      await deleteMemory(env.DB, orgId, id);
      return json({ deleted: true });
    }
    const updated = await updateMemory(env.DB, orgId, id, body?.text);
    if (!updated) return json({ message: "Write the rule." }, 400);
    return json({ memory: { ...updated, canEdit: true } });
  }

  // ---- Agent tokens ----
  if (path === "/tokens" && (request.method === "GET" || request.method === "POST")) {
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (request.method === "POST" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
    const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const endpoint = `${url.origin}/mcp`;
    if (request.method === "GET") {
      return json({ tokens: await listApiTokens(env.DB, { orgId, githubId: who.session.github_id }), endpoint, tools: TOOLS.map((t) => t.name) });
    }
    const out = await createApiToken(env.DB, { orgId, githubId: who.session.github_id, name: body.name });
    if (out.error) return json({ message: out.error }, 409);
    return json({ ...out, endpoint }, 201);
  }
  const tokenMatch = path.match(/^\/tokens\/([^/]+)$/);
  if (tokenMatch && request.method === "DELETE") {
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const removed = await revokeApiToken(env.DB, { orgId, githubId: who.session.github_id, id: decodeURIComponent(tokenMatch[1]) });
    if (!removed) return json({ message: "no such token" }, 404);
    return json({ revoked: true });
  }
  return null;
}
