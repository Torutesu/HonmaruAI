// /v2/w/<orgId>/… — conversations served from the workspace's own Durable
// Object (do.js) instead of D1. PoC-A of
// docs/architecture/discord-model-platform-plan.md §12.
//
// Off unless WORKSPACE_V2 names the workspace ("*" for every one, or a
// comma-separated list of org ids). Who may read or post is decided exactly
// as for the D1 routes — the same `caller` / `inChannel` checks — and only
// then is the Durable Object reached, by the workspace named in the URL.
//
// While this is a PoC nothing here writes D1, and the D1 routes do not write
// here: a workspace is copied with /backfill and compared with /checksum.
//
//   POST /v2/w/:org/channels/:channel/messages   {body, parentId?, clientId?}
//   GET  /v2/w/:org/channels/:channel/messages   ?before=seq | ?after=seq, &limit
//   POST /v2/w/:org/channels/:channel/read       {seq}
//   POST /v2/w/:org/unread                       {channels: [...]}
//   GET  /v2/w/:org/search?q=…&channels=a,b
//   POST /v2/w/:org/backfill                     {after?}   (owner / admin)
//   GET  /v2/w/:org/checksum?until=…             (owner / admin)
//   GET  /v2/w/:org/stats                        (owner / admin)

import { caller, inChannel } from "../channelRoutes.js";
import { listMembers } from "../team.js";
import { resolveChannel, MAX_MESSAGE_CHARS, clientIdOk } from "../channels.js";
import { digest, digestFields } from "./do.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS, ...extra },
});
const usageHeaders = (u) => (u ? { "x-rows-read": String(u.rowsRead), "x-rows-written": String(u.rowsWritten) } : {});

export function v2Enabled(env, orgId) {
  const list = String(env.WORKSPACE_V2 || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(orgId);
}

/// The one way to reach a workspace's object: by the workspace in the URL,
/// after the caller was found to be its member.
export const workspaceStub = (env, orgId) => env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId));

const BACKFILL_PAGE = 500;
const CHECK_PAGE = 1000;

export async function handleV2(request, env, url) {
  const m = url.pathname.match(/^\/v2\/w\/([^/]+)(\/.*)$/);
  if (!m) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const orgId = decodeURIComponent(m[1]);
  const rest = m[2];
  if (!env.WORKSPACE || !v2Enabled(env, orgId)) return json({ message: "Not found" }, 404);
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  const ch = rest.match(/^\/channels\/([^/]+)\/(messages|read)$/);
  if (ch) {
    const channel = decodeURIComponent(ch[1]);
    const got = await inChannel(env, request, { orgId, channel });
    if (got.denied) return got.denied;
    const stub = workspaceStub(env, orgId);
    const key = got.resolved.key;
    if (ch[2] === "messages" && request.method === "POST") {
      const text = String(body.body || "").trim();
      if (!text) return json({ message: "Say something first." }, 400);
      if (text.length > MAX_MESSAGE_CHARS) return json({ message: "That message is too long." }, 413);
      const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
      // A thread reply can go to the conversation as well.
      // A send's own id: the same send again is the message already posted.
      const clientId = typeof body.clientId === "string" && clientIdOk(body.clientId) ? body.clientId : null;
      const out = await stub.post({ channel: key, author: got.who.user.login, body: text, parentId, alsoChannel: Boolean(parentId) && body.alsoChannel === true, clientId });
      return json({ message: out.message }, 201, usageHeaders(out.usage));
    }
    if (ch[2] === "messages" && request.method === "GET") {
      const num = (k) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : null);
      const out = await stub.history({ channel: key, before: num("before"), after: num("after"), limit: num("limit") || 50 });
      return json({ messages: out.messages, lastSeq: out.lastSeq }, 200, usageHeaders(out.usage));
    }
    if (ch[2] === "read" && request.method === "POST") {
      await stub.markRead({ login: got.who.user.login, channel: key, seq: Number(body.seq) || 0 });
      return json({ ok: true });
    }
    return json({ message: "Not found" }, 404);
  }

  const who = await caller(env, request, orgId);
  if (who.denied) return who.denied;
  const stub = workspaceStub(env, orgId);

  if (rest === "/unread" && request.method === "POST") {
    const visible = await visibleKeys(env, orgId, who, body.channels);
    const out = await stub.unread({ login: who.user.login, channels: visible });
    return json({ channels: out.channels }, 200, usageHeaders(out.usage));
  }
  if (rest === "/search" && request.method === "GET") {
    const asked = String(url.searchParams.get("channels") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const visible = await visibleKeys(env, orgId, who, asked);
    const out = await stub.search({ q: url.searchParams.get("q"), channels: visible, limit: Number(url.searchParams.get("limit")) || 20 });
    return json({ hits: out.hits }, 200, usageHeaders(out.usage));
  }

  // The rest is for the people who run the workspace.
  const role = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(who.session.github_id)).first();
  if (!["owner", "admin"].includes(role?.role)) return json({ message: "Only an owner or admin can do that." }, 403);

  if (rest === "/backfill" && request.method === "POST") {
    const after = typeof body.after === "string" ? body.after : "";
    const { results = [] } = await env.DB.prepare(
      `SELECT id, channel, author_login, kind, body, parent_id, created_at, edited_at, deleted_at, also_channel FROM channel_messages
        WHERE org_id = ?1 AND (created_at, id) > (?2, ?3) ORDER BY created_at, id LIMIT ?4`
    ).bind(orgId, body.afterAt || "", after, BACKFILL_PAGE).all();
    const out = await stub.backfill({ rows: results });
    const last = results[results.length - 1];
    return json({
      copied: out.copied, read: results.length, done: results.length < BACKFILL_PAGE,
      next: last ? { afterAt: last.created_at, after: last.id } : null,
    }, 200, usageHeaders(out.usage));
  }
  if (rest === "/checksum" && request.method === "GET") {
    const until = url.searchParams.get("until") || new Date().toISOString();
    return json(await compare(env, stub, orgId, until));
  }
  if (rest === "/stats" && request.method === "GET") {
    return json(await stub.stats());
  }
  return json({ message: "Not found" }, 404);
}

/// Of the channels asked about, the ones this person can see, by the same
/// rule the D1 routes use.
async function visibleKeys(env, orgId, who, asked) {
  const list = [...new Set((Array.isArray(asked) ? asked : []).filter((c) => typeof c === "string"))].slice(0, 200);
  if (!list.length) return [];
  const members = await listMembers(env.DB, orgId, who.session.github_id);
  const out = [];
  for (const c of list) {
    const r = await resolveChannel(env.DB, orgId, who.user, c, members);
    if (r) out.push(r.key);
  }
  return out;
}

/// D1 and the Durable Object, page by page in id order: equal, or the first
/// page where they differ.
async function compare(env, stub, orgId, until) {
  let after = "";
  let total = 0;
  for (;;) {
    const { results = [] } = await env.DB.prepare(
      `SELECT id, channel, body, created_at, edited_at, deleted_at FROM channel_messages
        WHERE org_id = ?1 AND created_at < ?2 AND id > ?3 ORDER BY id LIMIT ?4`
    ).bind(orgId, until, after, CHECK_PAGE).all();
    const d1 = { ...(await digest(results.map(digestFields))), last: results.length ? results[results.length - 1].id : null };
    const dObj = await stub.checksum({ until, after, limit: CHECK_PAGE });
    if (d1.count !== dObj.count || d1.hash !== dObj.hash) {
      return { match: false, until, checked: total, page: { after, d1, durableObject: dObj } };
    }
    total += d1.count;
    if (d1.count < CHECK_PAGE) return { match: true, until, checked: total };
    after = d1.last;
  }
}
