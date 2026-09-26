// What a company decides about its workspace, beyond who is in it:
// how long messages and files are kept, what is held regardless, what can be
// exported for a legal matter, which networks the workspace may be used
// from, and who may be invited in.
//
// docs/enterprise-audit-log.md §10. Owners change all of it, with a recent
// sign-in, and every change is in the audit log. A hold always wins: nothing
// a hold covers is deleted by retention, and an edit or an unsend of a held
// person's message, or of one in a held channel, keeps the words as they
// were — for the export, never for anyone's screen.

import { audit, person } from "./audit.js";
import { allowed } from "./permissions.js";
import { getSession, getUserByGithubId } from "./db.js";
import { ipAllowed, parseCidr } from "./orgKeys.js";
import { listMembers } from "./team.js";

const DAY = 86_400_000;
export const RETENTION_CHOICES = [null, 1, 7, 30, 90, 180, 365, 730, 1825, 3650];
export const INVITE_POLICIES = ["open", "company", "approval"];
const MAX_CIDRS = 50;
const EXPORT_DAYS = 7;
const MAX_EXPORT_MESSAGES = 200_000;
const PRUNE_BATCH = 500;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS } });
}

// ---- The settings ----

const cache = new Map(); // orgId -> { row, at }
export function forgetGovernance() { cache.clear(); }

export async function governanceOf(db, orgId) {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < 30_000) return hit.row;
  const row = await db.prepare("SELECT * FROM org_governance WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  cache.set(orgId, { row: row || null, at: Date.now() });
  return row || null;
}

export function presentGovernance(row) {
  return {
    retention: {
      publicDays: row?.retention_public_days ?? null,
      privateDays: row?.retention_private_days ?? null,
      dmDays: row?.retention_dm_days ?? null,
      filesDays: row?.retention_files_days ?? null,
    },
    network: { enforce: Boolean(row?.ip_enforce), allowlist: JSON.parse(row?.ip_allowlist || "[]") },
    invites: { policy: row?.invite_policy || "open", guestsExempt: row?.invite_guests_exempt === null || row?.invite_guests_exempt === undefined ? true : Boolean(row.invite_guests_exempt) },
  };
}

async function saveGovernance(db, orgId, fields, updatedBy) {
  const now = new Date().toISOString();
  const cols = Object.keys(fields);
  await db.prepare(
    `INSERT INTO org_governance (org_id, ${cols.join(", ")}, updated_by, updated_at)
     VALUES (?1, ${cols.map((_, i) => `?${i + 2}`).join(", ")}, ?${cols.length + 2}, ?${cols.length + 3})
     ON CONFLICT(org_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(orgId, ...cols.map((c) => fields[c]), String(updatedBy), now).run();
  cache.delete(orgId);
}

// ---- Networks ----

/// The refusal for a request from an address this workspace does not allow,
/// or null. With no address known (a scheduled job, local dev) there is
/// nothing to judge.
export async function ipDenial(env, orgId, ip) {
  if (!orgId || !ip) return null;
  const row = await governanceOf(env.DB, orgId);
  if (!row?.ip_enforce) return null;
  const list = JSON.parse(row.ip_allowlist || "[]");
  if (ipAllowed(ip, list)) return null;
  return { status: 403, body: { message: "This workspace can only be used from your company's network.", code: "ip-not-allowed", orgId } };
}

function cleanCidrs(input) {
  const list = (Array.isArray(input) ? input : String(input || "").split(/[\s,]+/)).map((c) => String(c).trim()).filter(Boolean);
  if (list.length > MAX_CIDRS) return { error: `At most ${MAX_CIDRS} address ranges.` };
  const bad = list.find((c) => !parseCidr(c));
  if (bad) return { error: `${bad} is not an IP address or range.` };
  return { cidrs: [...new Set(list.map((c) => parseCidr(c).text))] };
}

// ---- Invitations ----

/// Whether someone new may come in by an invitation, under the workspace's
/// rule: anyone; only people at its verified domains; or anyone else only
/// once an admin approves. Guests may be let through either way.
export async function inviteGate(env, orgId, userId, role) {
  const row = await governanceOf(env.DB, orgId);
  const policy = row?.invite_policy || "open";
  if (policy === "open") return { ok: true };
  const guestsExempt = row?.invite_guests_exempt === null || row?.invite_guests_exempt === undefined ? true : Boolean(row.invite_guests_exempt);
  if (role === "guest" && guestsExempt) return { ok: true };
  const user = await env.DB.prepare("SELECT email, email_verified_at FROM users WHERE github_id = ?1").bind(String(userId)).first();
  const email = String(user?.email || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  const { results } = await env.DB.prepare("SELECT domain FROM org_domains WHERE org_id = ?1 AND verified_at IS NOT NULL").bind(orgId).all();
  const { domainMatches } = await import("./domains.js");
  const inside = Boolean(user?.email_verified_at) && (results || []).some((r) => domainMatches(domain, r.domain));
  if (inside) return { ok: true };
  if (policy === "company") return { error: "This workspace only takes people at its company's email domains. Sign in with your work address, or ask an admin." };
  return { pending: true, email };
}

// ---- Holds ----

export async function holdsOf(db, orgId, { active = true } = {}) {
  const { results } = await db.prepare(`SELECT * FROM message_holds WHERE org_id = ?1 ${active ? "AND released_at IS NULL" : ""} ORDER BY created_at DESC`).bind(orgId).all().catch(() => ({ results: [] }));
  return results || [];
}

/// Whether a message — by its author, or where it was said — is under hold.
export function heldBy(holds, { login, channel }) {
  return holds.some((h) => (h.kind === "person" && h.target === login) || (h.kind === "channel" && h.target === channel));
}

/// Before a held message's words change or go: kept as they were.
export async function keepIfHeld(db, orgId, row, reason) {
  if (!row || row.kind !== "message") return;
  const holds = await holdsOf(db, orgId);
  if (!holds.length || !heldBy(holds, { login: row.author_login, channel: row.channel })) return;
  await db.prepare(
    `INSERT INTO message_history (org_id, message_id, channel, author_login, body, message_created_at, reason, recorded_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(orgId, row.id, row.channel, row.author_login, row.body, row.created_at, reason, new Date().toISOString()).run();
}

// ---- Retention ----

async function privateSlugs(db, orgId) {
  const { results } = await db.prepare("SELECT slug FROM businesses WHERE org_id = ?1 AND private = 1").bind(orgId).all().catch(() => ({ results: [] }));
  return new Set((results || []).map((r) => `b:${r.slug}`));
}
const kindOfKey = (key, privates) => (key.startsWith("b:") ? (privates.has(key) ? "private" : "public") : "dm");

/// Messages and files past the workspace's retention, deleted — never what
/// a hold covers, and never a message whose thread is still being kept.
export async function pruneMessages(env, { now = Date.now(), orgLimit = 50 } = {}) {
  const { results: orgs } = await env.DB.prepare(
    `SELECT * FROM org_governance WHERE retention_public_days IS NOT NULL OR retention_private_days IS NOT NULL
       OR retention_dm_days IS NOT NULL OR retention_files_days IS NOT NULL LIMIT ?1`
  ).bind(orgLimit).all().catch(() => ({ results: [] }));
  const out = [];
  for (const g of orgs || []) {
    const orgId = g.org_id;
    const holds = await holdsOf(env.DB, orgId);
    const privates = await privateSlugs(env.DB, orgId);
    const days = { public: g.retention_public_days, private: g.retention_private_days, dm: g.retention_dm_days };
    const cutoffs = Object.fromEntries(Object.entries(days).map(([k, d]) => [k, d ? new Date(now - d * DAY).toISOString() : null]));
    const oldest = Object.values(cutoffs).filter(Boolean).sort().pop();
    let messages = 0;
    if (oldest) {
      const { results } = await env.DB.prepare(
        `SELECT m.id, m.channel, m.author_login, m.created_at, m.parent_id,
                (SELECT MAX(r.created_at) FROM channel_messages r WHERE r.org_id = m.org_id AND r.parent_id = m.id) AS last_reply
           FROM channel_messages m WHERE m.org_id = ?1 AND m.created_at < ?2 ORDER BY m.created_at LIMIT ?3`
      ).bind(orgId, oldest, PRUNE_BATCH).all();
      const doomed = [];
      for (const m of results || []) {
        const cutoff = cutoffs[kindOfKey(m.channel, privates)];
        if (!cutoff || m.created_at >= cutoff) continue;
        if (m.last_reply && m.last_reply >= cutoff) continue;
        if (heldBy(holds, { login: m.author_login, channel: m.channel })) continue;
        doomed.push(m.id);
      }
      for (let i = 0; i < doomed.length; i += 50) {
        const ids = doomed.slice(i, i + 50);
        const marks = ids.map((_, j) => `?${j + 2}`).join(", ");
        const { results: files } = await env.DB.prepare(`SELECT id FROM message_files WHERE org_id = ?1 AND message_id IN (${marks})`).bind(orgId, ...ids).all();
        for (const f of files || []) await env.MEDIA?.delete(`file-${f.id}`).catch(() => {});
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM message_reactions WHERE org_id = ?1 AND message_id IN (${marks})`).bind(orgId, ...ids),
          env.DB.prepare(`DELETE FROM message_files WHERE org_id = ?1 AND message_id IN (${marks})`).bind(orgId, ...ids),
          env.DB.prepare(`DELETE FROM channel_messages WHERE org_id = ?1 AND id IN (${marks})`).bind(orgId, ...ids),
        ]);
      }
      messages = doomed.length;
    }
    // Files on their own clock, however long the words around them stay.
    let files = 0;
    if (g.retention_files_days) {
      const cutoff = new Date(now - g.retention_files_days * DAY).toISOString();
      const { results } = await env.DB.prepare(
        "SELECT id, channel, uploader FROM message_files WHERE org_id = ?1 AND created_at < ?2 ORDER BY created_at LIMIT ?3"
      ).bind(orgId, cutoff, PRUNE_BATCH).all();
      for (const f of results || []) {
        if (heldBy(holds, { login: f.uploader, channel: f.channel })) continue;
        await env.MEDIA?.delete(`file-${f.id}`).catch(() => {});
        await env.DB.prepare("DELETE FROM message_files WHERE org_id = ?1 AND id = ?2").bind(orgId, f.id).run();
        files += 1;
      }
    }
    if (messages || files) {
      await audit(env, null, { orgId, action: "retention.pruned", actor: { type: "system" }, details: { messages, files } });
      out.push({ orgId, messages, files });
    }
  }
  return out;
}

// ---- Exports ----

/// Everything said in the range asked, with the words that held messages
/// had before an edit or an unsend, as JSON Lines, gzipped, into storage for
/// a week. Private channels and direct messages included: that is what an
/// export for a legal matter is.
export async function runExport(env, { orgId, id, from, to, logins = null, channels = null }) {
  const members = await listMembers(env.DB, orgId, null);
  const nameOf = new Map(members.map((m) => [m.login, m.name]));
  const where = ["org_id = ?1", "created_at >= ?2", "created_at < ?3"];
  const args = [orgId, from, to];
  if (logins?.length) { where.push(`author_login IN (${logins.map((_, i) => `?${args.length + i + 1}`).join(", ")})`); args.push(...logins); }
  if (channels?.length) { where.push(`channel IN (${channels.map((_, i) => `?${args.length + i + 1}`).join(", ")})`); args.push(...channels); }
  const { results } = await env.DB.prepare(
    `SELECT id, channel, author_login, kind, body, created_at, edited_at, deleted_at, parent_id FROM channel_messages WHERE ${where.join(" AND ")} ORDER BY created_at LIMIT ${MAX_EXPORT_MESSAGES}`
  ).bind(...args).all();
  const rows = results || [];
  const lines = [];
  for (const r of rows) {
    lines.push(JSON.stringify({ type: "message", id: r.id, channel: r.channel, author: r.author_login ? { login: r.author_login, name: nameOf.get(r.author_login) || null } : { kind: r.kind }, text: r.body, created_at: r.created_at, edited_at: r.edited_at, deleted_at: r.deleted_at, parent_id: r.parent_id }));
  }
  const hwhere = where.map((w) => w.replace("created_at", "message_created_at"));
  const { results: history } = await env.DB.prepare(
    `SELECT message_id, channel, author_login, body, message_created_at, reason, recorded_at FROM message_history WHERE ${hwhere.join(" AND ")} ORDER BY recorded_at`
  ).bind(...args).all().catch(() => ({ results: [] }));
  for (const h of history || []) {
    lines.push(JSON.stringify({ type: "earlier_version", message_id: h.message_id, channel: h.channel, author: { login: h.author_login, name: nameOf.get(h.author_login) || null }, text: h.body, before: h.reason, recorded_at: h.recorded_at }));
  }
  const ids = rows.map((r) => r.id);
  let fileCount = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results: files } = await env.DB.prepare(`SELECT id, message_id, name, type, size, uploader, created_at FROM message_files WHERE org_id = ?1 AND message_id IN (${chunk.map((_, j) => `?${j + 2}`).join(", ")})`).bind(orgId, ...chunk).all();
    for (const f of files || []) { lines.push(JSON.stringify({ type: "file", ...f })); fileCount += 1; }
  }
  const text = lines.join("\n") + (lines.length ? "\n" : "");
  const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const key = `compliance-export-${id}`;
  await env.MEDIA.put(key, gz, { httpMetadata: { contentType: "application/gzip" } });
  return { key, messages: rows.length, earlier: (history || []).length, files: fileCount, truncated: rows.length >= MAX_EXPORT_MESSAGES };
}

/// Exports past their week: gone from storage and from the list.
export async function expireExports(env, { now = Date.now() } = {}) {
  const { results } = await env.DB.prepare("SELECT id, object_key FROM compliance_exports WHERE expires_at < ?1 AND object_key IS NOT NULL").bind(new Date(now).toISOString()).all().catch(() => ({ results: [] }));
  for (const r of results || []) {
    await env.MEDIA?.delete(r.object_key).catch(() => {});
    await env.DB.prepare("UPDATE compliance_exports SET object_key = NULL, status = 'expired' WHERE id = ?1").bind(r.id).run();
  }
}

function presentExport(r) {
  return { id: r.id, status: r.status, from: r.range_from, to: r.range_to, filters: JSON.parse(r.filters || "{}"), counts: r.counts ? JSON.parse(r.counts) : null, createdAt: r.created_at, expiresAt: r.expires_at };
}

// ---- The owner's door ----

/// GET/PUT /orgs/governance · GET/POST /orgs/holds · DELETE /orgs/holds/:id ·
/// GET/POST /orgs/compliance/exports · GET /orgs/compliance/exports/:id/download
export async function handleGovernance(request, env, url) {
  const path = url.pathname;
  if (!path.startsWith("/orgs/governance") && !path.startsWith("/orgs/holds") && !path.startsWith("/orgs/compliance/exports")) return null;
  const session = await getSession(env.DB, request.headers.get("x-session-token") || url.searchParams.get("token") || "");
  if (!session) return json({ message: "Please sign in." }, 401);
  const body = ["POST", "PUT"].includes(request.method) ? await request.json().catch(() => ({})) : {};
  const orgId = String(body.orgId || url.searchParams.get("orgId") || "");
  if (!orgId) return json({ message: "orgId is required." }, 400);
  const { memberGate, reauthDenial } = await import("./policy.js");
  const gate = await memberGate(env, session, orgId);
  if (gate) return gate;
  const userId = session.github_id;
  if (!(await allowed(env.DB, orgId, userId, "audit.read"))) return json({ message: "Only an admin can see these settings." }, 403);
  const owner = await allowed(env.DB, orgId, userId, "governance.manage");
  const user = await getUserByGithubId(env.DB, userId);
  const actor = person(user);
  const ownerOnly = async () => {
    if (!owner) {
      await audit(env, request, { orgId, action: "security.permission_denied", actor, entity: { type: "resource", id: "governance", name: "workspace governance" }, outcome: "denied" });
      return json({ message: "Only an owner can change this." }, 403);
    }
    const again = await reauthDenial(env, session, orgId, { owner: true });
    return again ? json(again.body, again.status) : null;
  };
  const members = await listMembers(env.DB, orgId, userId);
  const byRef = new Map(members.map((m) => [m.ref, m]));
  const byLogin = new Map(members.map((m) => [m.login, m]));

  if (path === "/orgs/governance" && request.method === "GET") {
    return json({ ...presentGovernance(await governanceOf(env.DB, orgId)), canEdit: owner, yourIp: request.headers.get("cf-connecting-ip") || null, retentionChoices: RETENTION_CHOICES });
  }
  if (path === "/orgs/governance" && request.method === "PUT") {
    const refused = await ownerOnly();
    if (refused) return refused;
    const before = presentGovernance(await governanceOf(env.DB, orgId));
    const fields = {};
    if (body.retention) {
      for (const [k, col] of [["publicDays", "retention_public_days"], ["privateDays", "retention_private_days"], ["dmDays", "retention_dm_days"], ["filesDays", "retention_files_days"]]) {
        if (!(k in body.retention)) continue;
        const v = body.retention[k] === null || body.retention[k] === "" ? null : Number(body.retention[k]);
        if (!RETENTION_CHOICES.includes(v)) return json({ message: "Choose how long to keep things from the list." }, 400);
        fields[col] = v;
      }
    }
    if (body.network) {
      const clean = cleanCidrs(body.network.allowlist ?? before.network.allowlist);
      if (clean.error) return json({ message: clean.error }, 400);
      const enforce = body.network.enforce === undefined ? before.network.enforce : Boolean(body.network.enforce);
      if (enforce && !clean.cidrs.length) return json({ message: "Add at least one address range before turning this on." }, 400);
      // Nobody locks themselves out: the owner doing this must be inside.
      const here = request.headers.get("cf-connecting-ip") || "";
      if (enforce && here && !ipAllowed(here, clean.cidrs)) return json({ message: `Your own address (${here}) is not in the list, so this would lock you out. Add it first.`, code: "would-lock-out" }, 409);
      fields.ip_allowlist = JSON.stringify(clean.cidrs);
      fields.ip_enforce = enforce ? 1 : 0;
    }
    if (body.invites) {
      const policy = body.invites.policy ?? before.invites.policy;
      if (!INVITE_POLICIES.includes(policy)) return json({ message: "Choose who may be invited." }, 400);
      fields.invite_policy = policy;
      fields.invite_guests_exempt = (body.invites.guestsExempt ?? before.invites.guestsExempt) ? 1 : 0;
    }
    if (!Object.keys(fields).length) return json({ message: "Nothing to change." }, 400);
    await saveGovernance(env.DB, orgId, fields, userId);
    const after = presentGovernance(await governanceOf(env.DB, orgId));
    if (JSON.stringify(before.retention) !== JSON.stringify(after.retention)) await audit(env, request, { orgId, action: "governance.retention_changed", actor, details: { from: before.retention, to: after.retention } });
    if (JSON.stringify(before.network) !== JSON.stringify(after.network)) await audit(env, request, { orgId, action: "governance.ip_allowlist_changed", actor, details: { enforce: after.network.enforce, ranges: after.network.allowlist.length } });
    if (JSON.stringify(before.invites) !== JSON.stringify(after.invites)) await audit(env, request, { orgId, action: "governance.invite_policy_changed", actor, details: after.invites });
    const { mailOwners } = await import("./owners.js");
    await mailOwners(env, orgId, { subject: "Workspace rules were changed", text: `${user?.name || "An owner"} changed how long things are kept, where the workspace can be used from, or who may be invited. The audit log has the details.` }).catch(() => {});
    return json({ ...after, canEdit: owner });
  }

  if (path === "/orgs/holds" && request.method === "GET") {
    const holds = await holdsOf(env.DB, orgId, { active: false });
    return json({
      holds: holds.map((h) => ({
        id: h.id, kind: h.kind, reason: h.reason, createdAt: h.created_at, releasedAt: h.released_at,
        target: h.kind === "person" ? { ref: byLogin.get(h.target)?.ref || null, name: byLogin.get(h.target)?.name || "(former member)" } : { channel: h.target },
      })),
      canEdit: owner,
    });
  }
  if (path === "/orgs/holds" && request.method === "POST") {
    const refused = await ownerOnly();
    if (refused) return refused;
    const reason = String(body.reason || "").trim().slice(0, 500);
    if (!reason) return json({ message: "Say why: the matter this hold is for." }, 400);
    let target = null;
    if (body.kind === "person") target = byRef.get(String(body.ref || ""))?.login || null;
    else if (body.kind === "channel") {
      const key = String(body.channel || "");
      const exists = key.startsWith("b:") && await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, key.slice(2)).first();
      target = exists ? key : null;
    }
    if (!target) return json({ message: "Choose a person or a channel in this workspace." }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO message_holds (id, org_id, kind, target, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, orgId, body.kind, target, reason, String(userId), new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "hold.placed", actor, entity: body.kind === "person" ? person(byLogin.get(target)) || { type: "user", id: target } : { type: "channel", id: target }, details: { kind: body.kind, reason } });
    return json({ id }, 201);
  }
  const holdMatch = path.match(/^\/orgs\/holds\/([^/]+)$/);
  if (holdMatch && request.method === "DELETE") {
    const refused = await ownerOnly();
    if (refused) return refused;
    const done = await env.DB.prepare("UPDATE message_holds SET released_at = ?3, released_by = ?4 WHERE org_id = ?1 AND id = ?2 AND released_at IS NULL")
      .bind(orgId, holdMatch[1], new Date().toISOString(), String(userId)).run();
    if (!done?.meta?.changes) return json({ message: "No such hold." }, 404);
    await audit(env, request, { orgId, action: "hold.released", actor, details: { hold: holdMatch[1] } });
    return json({ ok: true });
  }

  if (path === "/orgs/compliance/exports" && request.method === "GET") {
    if (!owner) return json({ message: "Only an owner can export." }, 403);
    const { results } = await env.DB.prepare("SELECT * FROM compliance_exports WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 50").bind(orgId).all();
    return json({ exports: (results || []).map(presentExport) });
  }
  if (path === "/orgs/compliance/exports" && request.method === "POST") {
    const refused = await ownerOnly();
    if (refused) return refused;
    if (!env.MEDIA) return json({ message: "Storage is not set up on this deployment." }, 503);
    const from = Date.parse(body.from || ""), to = Date.parse(body.to || "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json({ message: "Choose a start and an end date." }, 400);
    const logins = (Array.isArray(body.people) ? body.people : []).map((r) => byRef.get(String(r))?.login).filter(Boolean);
    const channels = (Array.isArray(body.channels) ? body.channels : []).map(String).filter((c) => /^b:[a-z0-9-]+$/.test(c));
    const reason = String(body.reason || "").trim().slice(0, 500);
    if (!reason) return json({ message: "Say why: the matter this export is for." }, 400);
    const id = crypto.randomUUID();
    const now = new Date();
    const filters = { people: logins.map((l) => byLogin.get(l)?.name || l), channels, reason };
    await env.DB.prepare(
      `INSERT INTO compliance_exports (id, org_id, requested_by, range_from, range_to, filters, status, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8)`
    ).bind(id, orgId, String(userId), new Date(from).toISOString(), new Date(to).toISOString(), JSON.stringify(filters), now.toISOString(), new Date(now.getTime() + EXPORT_DAYS * DAY).toISOString()).run();
    try {
      const out = await runExport(env, { orgId, id, from: new Date(from).toISOString(), to: new Date(to).toISOString(), logins: logins.length ? logins : null, channels: channels.length ? channels : null });
      await env.DB.prepare("UPDATE compliance_exports SET status = 'ready', object_key = ?2, counts = ?3 WHERE id = ?1").bind(id, out.key, JSON.stringify({ messages: out.messages, earlier: out.earlier, files: out.files, truncated: out.truncated })).run();
      await audit(env, request, { orgId, action: "compliance.exported", actor, details: { export: id, from: body.from, to: body.to, people: logins.length, channels: channels.length, messages: out.messages, reason } });
      const { mailOwners } = await import("./owners.js");
      await mailOwners(env, orgId, { subject: "A compliance export was made", text: `${user?.name || "An owner"} exported messages from your workspace (${body.from} to ${body.to}) for: ${reason}. It can be downloaded for ${EXPORT_DAYS} days.` }).catch(() => {});
    } catch (err) {
      await env.DB.prepare("UPDATE compliance_exports SET status = 'failed' WHERE id = ?1").bind(id).run();
      return json({ message: `The export failed: ${err?.message || err}` }, 500);
    }
    const row = await env.DB.prepare("SELECT * FROM compliance_exports WHERE id = ?1").bind(id).first();
    return json({ export: presentExport(row) }, 201);
  }
  const dl = path.match(/^\/orgs\/compliance\/exports\/([^/]+)\/download$/);
  if (dl && request.method === "GET") {
    if (!owner) return json({ message: "Only an owner can download an export." }, 403);
    const row = await env.DB.prepare("SELECT * FROM compliance_exports WHERE org_id = ?1 AND id = ?2").bind(orgId, dl[1]).first();
    if (!row?.object_key || row.status !== "ready" || row.expires_at < new Date().toISOString()) return json({ message: "That export has expired or is not ready." }, 404);
    const obj = await env.MEDIA.get(row.object_key);
    if (!obj) return json({ message: "That export has expired." }, 404);
    await audit(env, request, { orgId, action: "compliance.downloaded", actor, details: { export: row.id } });
    return new Response(obj.body, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="export-${row.id.slice(0, 8)}.jsonl.gz"`, "cache-control": "no-store", ...CORS } });
  }
  return json({ message: "not found" }, 404);
}
