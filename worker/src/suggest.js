import { getSession, isMember, getUserByGithubId, loadContexts } from "./db.js";
import { enforce } from "./ratelimit.js";
import { listMembers } from "./team.js";
import { listRoutines } from "./routines.js";
import { providerFor } from "./orgAI.js";
import { allowanceFor } from "./gate.js";
import { noteUsage, settleUsage } from "./ledger.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";
import { displayName } from "./notifyCopy.js";
import { safe } from "./log.js";

// What to tell your AI, suggested from your own work: the teammates you have,
// the channels you talk in, what is waiting on whom, what already runs on a
// schedule, and what you said about how you work. The empty "Your AI"
// conversation offers these instead of the same three examples for everyone.
//
// Written by the model in the reader's language when there is one; otherwise
// picked from the same material by rule. Kept for a few hours per person, so
// opening the conversation does not cost a model call each time.

export const SUGGESTIONS = 3;
const FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_CHARS = 90;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS },
  });
}

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function cardTitle(data) {
  const card = parse(data) || {};
  return clip(card.title || card.summary || "", 80);
}

/// Everything about this person's work that a suggestion may draw on. Names,
/// never logins: the material goes to a model.
export async function gatherMaterial(db, orgId, user, members, { now = new Date() } = {}) {
  const nameOf = (login) => {
    const m = members.find((x) => x.login === login);
    return m?.name || displayName(login);
  };
  const me = members.find((m) => m.login === user.login);
  const [cards, businesses, routines, messages, contexts] = await Promise.all([
    db.prepare(
      `SELECT data, status, created_at, sender_user_id, recipient_user_id FROM cards
        WHERE org_id = ?1 AND (sender_user_id = ?2 OR recipient_user_id = ?2)
        ORDER BY created_at DESC LIMIT 40`
    ).bind(orgId, user.login).all().then((r) => r.results || []).catch(() => []),
    db.prepare("SELECT slug, name FROM businesses WHERE org_id = ?1 ORDER BY created_at ASC LIMIT 15")
      .bind(orgId).all().then((r) => r.results || []).catch(() => []),
    listRoutines(db, orgId, user.github_id).catch(() => []),
    db.prepare(
      `SELECT channel, body FROM channel_messages
        WHERE org_id = ?1 AND author_login = ?2 AND deleted_at IS NULL AND channel LIKE 'b:%'
        ORDER BY created_at DESC LIMIT 12`
    ).bind(orgId, user.login).all().then((r) => r.results || []).catch(() => []),
    loadContexts(db, orgId).catch(() => ({})),
  ]);

  const day = 24 * 60 * 60 * 1000;
  const sentWaiting = [];
  const toMe = [];
  const recent = [];
  for (const c of cards) {
    const mineSent = c.sender_user_id === user.login && c.recipient_user_id !== user.login;
    const title = cardTitle(c.data);
    if (!title) continue;
    if (mineSent && c.status === "pending") {
      sentWaiting.push({ title, to: nameOf(c.recipient_user_id), days: Math.floor((now - Date.parse(c.created_at)) / day) });
    } else if (c.recipient_user_id === user.login && c.status === "pending") {
      toMe.push({ title, from: c.sender_user_id && c.sender_user_id !== user.login ? nameOf(c.sender_user_id) : null });
    } else {
      recent.push({ title, with: nameOf(mineSent ? c.recipient_user_id : c.sender_user_id), status: c.status || null });
    }
  }
  const channelName = (key) => businesses.find((b) => `b:${b.slug}` === key)?.name || key.slice(2);
  return {
    me: { name: me?.name || user.name || displayName(user.login), title: me?.title || null },
    howIWork: clip(contexts?.[user.login]?.text || "", 600) || null,
    teammates: members.filter((m) => m.login !== user.login).slice(0, 15).map((m) => ({ name: m.name, title: m.title || null })),
    channels: businesses.map((b) => ({ name: b.name, slug: b.slug })),
    waitingOnOthers: sentWaiting.slice(0, 8),
    waitingOnMe: toMe.slice(0, 6),
    recentDecisions: recent.slice(0, 10),
    automations: routines.map((r) => ({ kind: r.kind, title: r.title, cadence: r.cadence })),
    iSaid: messages.map((m) => ({ channel: channelName(m.channel), text: clip(m.body, 160) })),
  };
}

/// Without a model: from the same material, by rule — a real teammate, a
/// real channel, something that is actually waiting.
export function ruleSuggestions(material, locale) {
  const out = [];
  const push = (key, vars, kind) => {
    const text = serverText(locale, key, vars);
    if (text && !out.some((s) => s.text === text)) out.push({ text: clip(text, MAX_CHARS), kind });
  };
  const channel = material.channels[0]?.name || null;
  const teammate = material.teammates.find((t) => t.title) || material.teammates[0] || null;

  // What you are already waiting on, longest first.
  const stuck = [...material.waitingOnOthers].sort((a, b) => b.days - a.days)[0];
  if (stuck && stuck.days >= 1) push("suggest.nudge", { name: stuck.to, title: clip(stuck.title, 40) }, "follow_up");

  if (teammate) {
    push(channel ? "suggest.askIn" : "suggest.ask", { name: teammate.name, channel: channel || "" }, "decision");
  }

  const hasReport = material.automations.some((a) => a.kind === "report" || a.kind === "brief");
  if (!hasReport) push(channel ? "suggest.weeklyIn" : "suggest.weekly", { channel: channel || "" }, "automation");
  else push("suggest.friday", {}, "automation");

  const recent = material.recentDecisions[0] || material.waitingOnMe[0];
  if (recent) push("suggest.followUp", { title: clip(recent.title, 40) }, "reminder");

  for (const key of ["suggest.friday", ...(hasReport ? [] : ["suggest.weekly"]), "suggest.tomorrow", "suggest.monthly"]) {
    if (out.length >= SUGGESTIONS) break;
    push(key, {}, key === "suggest.tomorrow" ? "reminder" : "automation");
  }
  return out.slice(0, SUGGESTIONS);
}

const PROMPT = `You suggest what a person could tell their AI assistant next, in a work app where the AI turns an instruction into a decision card for the right teammate, sets up recurring reports ("every Monday at 9, summarise …"), and sends reminders.
Return JSON: {"suggestions":[{"text":"...","kind":"decision|follow_up|automation|reminder"}]} with exactly ${SUGGESTIONS} items.
- Each "text" is one instruction written as the person would type it to their AI, in the reader's language, under ${MAX_CHARS} characters.
- Ground every one in the material: real teammate names, real channels, real waiting items. Never invent people, amounts or dates that are not in the material.
- Make them different from each other: prefer one asking a teammate to decide or approve something, one following up on something waiting, and one recurring automation the person does not already have.
- If there is little material, suggest useful first steps for someone in their role.`;

export async function modelSuggestions(material, { locale, provider, allowance }) {
  if (!provider || (allowance && !allowance.allowed)) return null;
  try {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model, temperature: 0.5, max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: `Reader language: ${locale}\n<material>\n${JSON.stringify(material)}\n</material>` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    noteUsage(provider, "suggestions", data);
    if (allowance?.metered) await allowance.consume();
    const parsed = parse(data?.choices?.[0]?.message?.content || "");
    const kinds = new Set(["decision", "follow_up", "automation", "reminder"]);
    const items = (Array.isArray(parsed?.suggestions) ? parsed.suggestions : [])
      .map((s) => ({ text: clip(s?.text, MAX_CHARS), kind: kinds.has(s?.kind) ? s.kind : "decision" }))
      .filter((s) => s.text);
    const unique = items.filter((s, i) => items.findIndex((x) => x.text === s.text) === i).slice(0, SUGGESTIONS);
    return unique.length ? unique : null;
  } catch (err) {
    console.error("suggestions failed", safe(err?.message));
    return null;
  }
}

/// The suggestions for one person, from the cache when they are fresh.
export async function suggestionsFor(env, orgId, user, { locale, refresh = false, now = new Date() } = {}) {
  const db = env.DB;
  if (!refresh) {
    const hit = await db.prepare(
      "SELECT items, by_model, created_at FROM ai_suggestions WHERE org_id = ?1 AND login = ?2 AND locale = ?3"
    ).bind(orgId, user.login, locale).first().catch(() => null);
    if (hit && now - Date.parse(hit.created_at) < FRESH_MS) {
      const items = parse(hit.items);
      if (Array.isArray(items) && items.length) return { suggestions: items, byModel: Boolean(hit.by_model), cached: true };
    }
  }
  const members = await listMembers(db, orgId, user.github_id);
  const material = await gatherMaterial(db, orgId, user, members, { now });
  const provider = await providerFor(env, orgId);
  const allowance = provider ? await allowanceFor(env, orgId, { githubId: String(user.github_id) }) : null;
  let written = null;
  try {
    written = await modelSuggestions(material, { locale, provider, allowance });
  } finally {
    await settleUsage(db, provider, { orgId, githubId: user.github_id });
  }
  const suggestions = written || ruleSuggestions(material, locale);
  await db.prepare(
    `INSERT INTO ai_suggestions (org_id, login, locale, items, by_model, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (org_id, login, locale) DO UPDATE SET items = excluded.items, by_model = excluded.by_model, created_at = excluded.created_at`
  ).bind(orgId, user.login, locale, JSON.stringify(suggestions), written ? 1 : 0, now.toISOString()).run().catch(() => {});
  return { suggestions, byModel: Boolean(written), cached: false };
}

/// GET /ai/suggestions?orgId=…[&refresh=1]
export async function handleSuggestions(request, env, url) {
  if (url.pathname !== "/ai/suggestions") return null;
  if (request.method !== "GET") return json({ message: "GET only." }, 405);
  const limited = await enforce(env, request, "ai/suggest");
  if (limited) return limited;
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ message: "orgId is required" }, 400);
  if (!(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
  const user = await getUserByGithubId(env.DB, session.github_id);
  if (!user?.login) return json({ message: "Please sign in." }, 401);
  const locale = await loadCopy(env, user.locale || "en", { orgId });
  const out = await suggestionsFor(env, orgId, { ...user, github_id: session.github_id }, {
    locale, refresh: url.searchParams.get("refresh") === "1",
  });
  return json(out);
}
