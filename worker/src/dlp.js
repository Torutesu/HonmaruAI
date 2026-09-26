// Data loss prevention: what a workspace does not want said in it.
//
// docs/enterprise-audit-log.md §10. Before a person's message is kept, it is
// read against the workspace's rules: built-in detectors (a My Number, a
// card number, a secret key), a pattern of the admin's own, or a list of
// words. A rule either warns — the person is asked, and may send it anyway —
// or blocks. Nothing matched is ever stored or logged: the audit log says
// which rule, never what it found.

import { audit } from "./audit.js";
import { allowed } from "./permissions.js";
import { getSession, getUserByGithubId } from "./db.js";

const MAX_RULES = 50;
const MAX_PATTERN = 200;
const MAX_KEYWORDS = 100;

// The Studio and the composer call this from the web app's own origin.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS } });
}

// ---- The built-in detectors ----

const digitsOf = (s) => s.replace(/[\s-]/g, "");

/// The check digit of a Japanese Individual Number (マイナンバー).
export function myNumberValid(twelve) {
  if (!/^\d{12}$/.test(twelve)) return false;
  const body = twelve.slice(0, 11).split("").reverse().map(Number);
  let sum = 0;
  for (let n = 1; n <= 11; n++) sum += body[n - 1] * (n <= 6 ? n + 1 : n - 5);
  const r = sum % 11;
  return Number(twelve[11]) === (r <= 1 ? 0 : 11 - r);
}

/// The Luhn check every card number carries.
export function luhnValid(number) {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return number.length >= 13 && sum % 10 === 0;
}

const SECRET_PATTERNS = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk_live_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bhmo_[0-9a-f]{64}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
];

export const DETECTORS = {
  my_number: {
    name: "My Number (Japan)",
    test(text) {
      for (const m of text.matchAll(/(?<!\d)(\d{4}[\s-]?\d{4}[\s-]?\d{4})(?!\d)/g)) if (myNumberValid(digitsOf(m[1]))) return true;
      return false;
    },
  },
  credit_card: {
    name: "Card number",
    test(text) {
      for (const m of text.matchAll(/(?<!\d)([3-6]\d{3}(?:[\s-]?\d{2,4}){2,4})(?!\d)/g)) {
        const d = digitsOf(m[1]);
        if (d.length >= 13 && d.length <= 19 && luhnValid(d)) return true;
      }
      return false;
    },
  },
  secret_key: {
    name: "Secret key or token",
    test: (text) => SECRET_PATTERNS.some((p) => p.test(text)),
  },
  us_ssn: {
    name: "US Social Security number",
    test: (text) => /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/.test(text),
  },
};

// ---- Rules ----

/// A pattern an admin wrote, if it is one this server will run: short, and
/// without the nested repetition that can make matching take forever.
export function cleanPattern(raw) {
  const pattern = String(raw || "").trim();
  if (!pattern || pattern.length > MAX_PATTERN) return { error: `A pattern is 1 to ${MAX_PATTERN} characters.` };
  if (/\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d*,\d*\})/.test(pattern) || /\\[1-9]/.test(pattern)) return { error: "That pattern repeats a repetition, which can take too long to check. Simplify it." };
  try { new RegExp(pattern, "iu"); } catch { return { error: "That is not a valid pattern." }; }
  return { pattern };
}

function cleanKeywords(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw || "").split(/[\n,]/)).map((w) => String(w).trim()).filter(Boolean);
  const unique = [...new Set(list.map((w) => w.slice(0, 80)))].slice(0, MAX_KEYWORDS);
  return unique.length ? { keywords: unique } : { error: "List at least one word." };
}

function presentRule(row) {
  return {
    id: row.id, name: row.name, kind: row.kind, detector: row.detector || null,
    pattern: row.kind === "regex" ? row.pattern : null,
    keywords: row.kind === "keywords" ? JSON.parse(row.pattern || "[]") : null,
    action: row.action, enabled: Boolean(row.enabled), updatedAt: row.updated_at,
  };
}

export async function rulesOf(db, orgId, { enabledOnly = false } = {}) {
  const { results } = await db.prepare(`SELECT * FROM dlp_rules WHERE org_id = ?1 ${enabledOnly ? "AND enabled = 1" : ""} ORDER BY created_at, id`).bind(orgId).all()
    .catch(() => ({ results: [] }));
  return results || [];
}

/// Which rules a text breaks. Returns [{ id, name, action }]; never what matched.
export function scan(rules, text) {
  const hits = [];
  const body = String(text || "").normalize("NFKC");
  for (const r of rules) {
    let hit = false;
    if (r.kind === "builtin") hit = Boolean(DETECTORS[r.detector]?.test(body));
    else if (r.kind === "regex") { try { hit = new RegExp(r.pattern, "iu").test(body); } catch { hit = false; } }
    else if (r.kind === "keywords") {
      const lower = body.toLowerCase();
      hit = JSON.parse(r.pattern || "[]").some((w) => lower.includes(String(w).normalize("NFKC").toLowerCase()));
    }
    if (hit) hits.push({ id: r.id, name: r.name, action: r.action });
  }
  return hits;
}

/// Before a person's words are kept: null to go ahead, or the answer to
/// give instead. `ack` is the person having seen the warning and sending
/// anyway; a block is never passed that way.
export async function checkOutgoing(env, request, { orgId, login, text, ack = false, where = "message" }) {
  if (!text) return null;
  const rules = await rulesOf(env.DB, orgId, { enabledOnly: true });
  if (!rules.length) return null;
  const hits = scan(rules, text);
  if (!hits.length) return null;
  const actor = { type: "user", id: login };
  const blocking = hits.filter((h) => h.action === "block");
  if (blocking.length) {
    await audit(env, request, { orgId, action: "dlp.blocked", actor, details: { rules: blocking.map((h) => h.name), where }, outcome: "denied" });
    return json({
      code: "dlp-blocked", rules: blocking.map((h) => h.name),
      message: `This can't be sent here: it looks like it contains ${blocking.map((h) => h.name).join(", ")}. Take it out and try again.`,
    }, 422);
  }
  if (!ack) {
    return json({
      code: "dlp-warning", rules: hits.map((h) => h.name),
      message: `This looks like it contains ${hits.map((h) => h.name).join(", ")}. Send it anyway?`,
    }, 409);
  }
  await audit(env, request, { orgId, action: "dlp.warning_overridden", actor, details: { rules: hits.map((h) => h.name), where } });
  return null;
}

// ---- The admin's side ----

/// GET    /orgs/dlp?orgId=           the rules (admins)
/// POST   /orgs/dlp                  {orgId, name, kind, detector|pattern|keywords, action}
/// PATCH  /orgs/dlp/:id              {orgId, name?, action?, enabled?, pattern?, keywords?}
/// DELETE /orgs/dlp/:id?orgId=
/// POST   /orgs/dlp/test             {orgId, text} → which rules it breaks
export async function handleDlp(request, env, url) {
  if (url.pathname !== "/orgs/dlp" && !url.pathname.startsWith("/orgs/dlp/")) return null;
  const body = ["POST", "PATCH"].includes(request.method) ? await request.json().catch(() => ({})) : {};
  const orgId = String(body.orgId || url.searchParams.get("orgId") || "");
  const session = await getSession(env.DB, request.headers.get("x-session-token") || "");
  if (!session) return json({ message: "Sign in first." }, 401);
  if (!orgId) return json({ message: "orgId is required." }, 400);
  const userId = session.github_id;
  if (!(await allowed(env.DB, orgId, userId, "audit.read"))) return json({ message: "Only an admin can see these rules." }, 403);
  const canEdit = await allowed(env.DB, orgId, userId, "dlp.manage");
  const user = await getUserByGithubId(env.DB, userId);
  const actor = { type: "user", id: user?.login || userId, name: user?.name || null };

  if (url.pathname === "/orgs/dlp" && request.method === "GET") {
    return json({ rules: (await rulesOf(env.DB, orgId)).map(presentRule), detectors: Object.entries(DETECTORS).map(([id, d]) => ({ id, name: d.name })), canEdit });
  }
  if (url.pathname === "/orgs/dlp/test" && request.method === "POST") {
    const text = String(body.text || "").slice(0, 8000);
    return json({ hits: scan(await rulesOf(env.DB, orgId), text) });
  }
  if (!canEdit) return json({ message: "Only an admin can change these rules." }, 403);
  const action = (a) => (a === "block" ? "block" : a === "warn" ? "warn" : null);
  const now = new Date().toISOString();

  if (url.pathname === "/orgs/dlp" && request.method === "POST") {
    if ((await rulesOf(env.DB, orgId)).length >= MAX_RULES) return json({ message: `A workspace has at most ${MAX_RULES} rules.` }, 400);
    const kind = ["builtin", "regex", "keywords"].includes(body.kind) ? body.kind : null;
    if (!kind) return json({ message: "Say what kind of rule: builtin, regex or keywords." }, 400);
    const act = action(body.action);
    if (!act) return json({ message: "A rule warns or blocks." }, 400);
    let detector = null; let pattern = null;
    if (kind === "builtin") {
      if (!DETECTORS[body.detector]) return json({ message: "No such detector." }, 400);
      detector = body.detector;
    } else if (kind === "regex") {
      const clean = cleanPattern(body.pattern);
      if (clean.error) return json({ message: clean.error }, 400);
      pattern = clean.pattern;
    } else {
      const clean = cleanKeywords(body.keywords);
      if (clean.error) return json({ message: clean.error }, 400);
      pattern = JSON.stringify(clean.keywords);
    }
    const name = String(body.name || (detector ? DETECTORS[detector].name : "")).trim().slice(0, 80);
    if (!name) return json({ message: "Give the rule a name." }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO dlp_rules (id, org_id, name, kind, detector, pattern, action, enabled, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?9)`
    ).bind(id, orgId, name, kind, detector, pattern, act, String(userId), now).run();
    await audit(env, request, { orgId, action: "dlp.rule_created", actor, entity: { type: "dlp_rule", id, name }, details: { kind, detector, action: act } });
    return json({ rule: presentRule(await env.DB.prepare("SELECT * FROM dlp_rules WHERE id = ?1").bind(id).first()) }, 201);
  }
  const m = url.pathname.match(/^\/orgs\/dlp\/([^/]+)$/);
  if (!m) return json({ message: "not found" }, 404);
  const row = await env.DB.prepare("SELECT * FROM dlp_rules WHERE org_id = ?1 AND id = ?2").bind(orgId, m[1]).first();
  if (!row) return json({ message: "No such rule." }, 404);
  const entity = { type: "dlp_rule", id: row.id, name: row.name };
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM dlp_rules WHERE org_id = ?1 AND id = ?2").bind(orgId, row.id).run();
    await audit(env, request, { orgId, action: "dlp.rule_deleted", actor, entity });
    return json({ ok: true });
  }
  if (request.method !== "PATCH") return json({ message: "not found" }, 404);
  const next = { ...row };
  const details = {};
  if (typeof body.name === "string" && body.name.trim()) { next.name = body.name.trim().slice(0, 80); details.name = next.name; }
  if (body.action !== undefined) {
    if (!action(body.action)) return json({ message: "A rule warns or blocks." }, 400);
    next.action = action(body.action); details.action = next.action;
  }
  if (typeof body.enabled === "boolean") { next.enabled = body.enabled ? 1 : 0; details.enabled = body.enabled; }
  if (row.kind === "regex" && body.pattern !== undefined) {
    const clean = cleanPattern(body.pattern);
    if (clean.error) return json({ message: clean.error }, 400);
    next.pattern = clean.pattern; details.pattern_changed = true;
  }
  if (row.kind === "keywords" && body.keywords !== undefined) {
    const clean = cleanKeywords(body.keywords);
    if (clean.error) return json({ message: clean.error }, 400);
    next.pattern = JSON.stringify(clean.keywords); details.keywords_changed = true;
  }
  await env.DB.prepare("UPDATE dlp_rules SET name = ?3, action = ?4, enabled = ?5, pattern = ?6, updated_at = ?7 WHERE org_id = ?1 AND id = ?2")
    .bind(orgId, row.id, next.name, next.action, next.enabled, next.pattern, now).run();
  await audit(env, request, { orgId, action: "dlp.rule_changed", actor, entity, details });
  return json({ rule: presentRule({ ...next, updated_at: now }) });
}
