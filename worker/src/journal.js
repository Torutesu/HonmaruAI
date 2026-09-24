import { zonedParts, zonedTime } from "./schedule.js";
import { serverText } from "./serverCopy.js";
import { noteUsage } from "./ledger.js";
import { linksIn } from "./channelDetails.js";
import { safe } from "./log.js";

// A channel's journal: what was said in it, a day at a time, in a few lines
// each — the context someone new to the channel, or back from a week away,
// reads before scrolling. Each line cites the messages it came from, so
// nothing in it is taken on trust. Written by the model in the reader's
// language when there is one, else picked from the day's busiest messages.

/// Days on one page of the journal.
export const JOURNAL_DAYS = 5;
/// Messages read for one page — a day cut off by this is left for the next.
const PAGE_ROWS = 800;
/// Messages of a day the model reads.
const DAY_ROWS = 150;
/// Days the model writes per request; the rest wait, with their digest.
const MODEL_DAYS_PER_REQUEST = 3;
/// Today's lines are written again at most this often.
const TODAY_FRESH_MS = 10 * 60 * 1000;
/// Lines in a day's summary.
const MAX_ITEMS = 5;

const SYSTEM_PROMPT = `You write a channel's journal: what happened in one day of a team chat, for a teammate who was not there.
Return JSON: {"items":[{"text":"...","cites":[1,4]}]}.
- 1 to ${MAX_ITEMS} items, the most important first: decisions made, work done or handed over, problems raised, questions still open, links shared and why.
- Each item one or two plain sentences, in the reader's language, naming people as the messages name them. No headings, no markdown, no emoji.
- "cites": the numbers of the messages the item comes from, at least one each.
- Say only what the messages say. Leave out greetings and chatter.`;

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/// A moment's calendar date where the reader lives.
export function localDay(iso, tz) {
  const p = zonedParts(new Date(iso), tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/// When a local date began, as an instant.
export function dayStart(day, tz) {
  const [year, month, date] = day.split("-").map(Number);
  return zonedTime({ year, month, day: date, hour: 0, minute: 0 }, tz);
}

export function validDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

export function validZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/// Newest rows first → days, newest first, each with its rows oldest first.
export function groupByDay(rows, tz) {
  const days = [];
  for (const row of rows) {
    const day = localDay(row.created_at, tz);
    let slot = days[days.length - 1];
    if (!slot || slot.day !== day) { slot = { day, rows: [] }; days.push(slot); }
    slot.rows.unshift(row);
  }
  return days;
}

function authorOf(row, members, locale) {
  if (row.kind === "ai") return serverText(locale, "channel.agentYourAI");
  return members.find((m) => m.login === row.author_login)?.name || row.author_login || "?";
}

/// The day without a model: its busiest conversations, each opened by what
/// started it — the message most replied to, then the longest — in the
/// order they happened.
export function dayDigest(rows, members, locale) {
  const replies = new Map();
  for (const r of rows) if (r.parent_id) replies.set(r.parent_id, (replies.get(r.parent_id) || 0) + 1);
  const tops = rows.filter((r) => !r.parent_id && String(r.body || "").trim());
  const picked = [...tops]
    .sort((a, b) => (replies.get(b.id) || 0) - (replies.get(a.id) || 0) || (a.kind === "ai") - (b.kind === "ai") || String(b.body).length - String(a.body).length)
    .slice(0, 4);
  return tops
    .filter((r) => picked.includes(r))
    .map((r) => ({ text: `${authorOf(r, members, locale)}: ${clip(plain(r.body), 180)}`, messageIds: [r.id] }));
}

/// A message as a line of prose: its formatting marks gone, its lines and
/// list items run together.
export function plain(body) {
  const lines = String(body || "")
    .split("\n")
    .map((line) => ({
      // A line that is all bold is a heading: what follows is under it.
      heading: /^\s*\*[^*]+\*\s*$/.test(line),
      text: line.replace(/^\s*(?:[-•]\s+|\d+[.)]\s+|>\s?)/, "").replace(/[*_~`]+/g, "").trim(),
    }))
    .filter((l) => l.text);
  return lines
    .map((l, i) => (i === lines.length - 1 || /[.!?。！？:：;]$/.test(l.text) ? l.text : `${l.text}${l.heading ? ":" : ";"}`))
    .join(" ");
}

/// The day by the model, in the reader's language. Null when it could not.
export async function summarizeDay(rows, { locale, members, provider, allowance, channelName }) {
  if (!provider || (allowance && !allowance.allowed)) return null;
  const shown = rows.slice(-DAY_ROWS);
  const material = shown.map((r, i) => ({
    n: i + 1,
    who: authorOf(r, members, locale),
    ...(r.parent_id ? { reply: true } : {}),
    text: clip(r.body, 400),
  }));
  try {
    const res = await fetch(provider.endpoint, {
      signal: AbortSignal.timeout(45_000),
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model, temperature: 0.2, max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Reader language: ${locale}\nChannel: ${channelName}\n<messages>\n${JSON.stringify(material)}\n</messages>` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    noteUsage(provider, "journal", data);
    if (allowance?.metered) await allowance.consume();
    let parsed = null;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || ""); } catch { /* not JSON */ }
    const items = (Array.isArray(parsed?.items) ? parsed.items : [])
      .map((item) => ({
        text: clip(item?.text, 400),
        messageIds: [...new Set((Array.isArray(item?.cites) ? item.cites : [])
          .map((n) => shown[Number(n) - 1]?.id).filter(Boolean))].slice(0, 6),
      }))
      .filter((item) => item.text)
      .slice(0, MAX_ITEMS);
    return items.length ? items : null;
  } catch (err) {
    console.error("journal failed", safe(err?.message));
    return null;
  }
}

/// Each item's citations — where the message is, so a click can go to it,
/// a reply by way of its thread — and the links they carried, for chips.
function withLinks(items, rows, members) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return items.map((item) => {
    const cited = item.messageIds.map((id) => byId.get(id)).filter(Boolean);
    return {
      ...item,
      cites: cited.map((r) => ({ id: r.id, parentId: r.parent_id || null, at: r.created_at })),
      links: linksIn(cited, members).slice(0, 3).map(({ url, host }) => ({ url, host })),
    };
  });
}

/// One page of the journal: the `JOURNAL_DAYS` days with messages before
/// `before` (a local date, exclusive), newest first. `more` says whether
/// there are older days; when there are none the page ends at the start of
/// the journal.
export async function channelJournal(env, orgId, { resolved, members, tz, before, locale = "en", provider = null, allowance = null, channelName = "", now = new Date() }) {
  const until = before ? dayStart(before, tz).toISOString() : "9999-12-31T00:00:00.000Z";
  const { results = [] } = await env.DB.prepare(
    `SELECT id, author_login, kind, body, created_at, parent_id FROM channel_messages
      WHERE org_id = ?1 AND channel = ?2 AND deleted_at IS NULL AND created_at < ?3
      ORDER BY created_at DESC LIMIT ${PAGE_ROWS}`
  ).bind(orgId, resolved.key, until).all();

  let days = groupByDay(results, tz);
  // The page stopped mid-day: that day belongs to the next page, whole —
  // unless it is the only one, when part of it is better than nothing.
  if (results.length === PAGE_ROWS && days.length > 1) days = days.slice(0, -1);
  days = days.slice(0, JOURNAL_DAYS);

  const oldest = days[days.length - 1];
  const more = oldest
    ? Boolean(await env.DB.prepare(
      "SELECT 1 AS x FROM channel_messages WHERE org_id = ?1 AND channel = ?2 AND deleted_at IS NULL AND created_at < ?3 LIMIT 1"
    ).bind(orgId, resolved.key, dayStart(oldest.day, tz).toISOString()).first())
    : false;

  const cached = new Map();
  if (days.length) {
    const marks = days.map((_, i) => `?${i + 5}`).join(", ");
    const { results: rows = [] } = await env.DB.prepare(
      `SELECT day, count, items, by_model, updated_at FROM channel_journal
        WHERE org_id = ?1 AND channel = ?2 AND tz = ?3 AND locale = ?4 AND day IN (${marks})`
    ).bind(orgId, resolved.key, tz, locale, ...days.map((d) => d.day)).all().catch(() => ({ results: [] }));
    for (const row of rows) cached.set(row.day, row);
  }

  const today = localDay(now.toISOString(), tz);
  let modelBudget = MODEL_DAYS_PER_REQUEST;
  const out = [];
  for (const { day, rows } of days) {
    const hit = cached.get(day);
    let items = null;
    let byModel = false;
    if (hit) {
      try { items = JSON.parse(hit.items); } catch { items = null; }
      byModel = Boolean(hit.by_model);
    }
    const stale = !items
      || hit.count !== rows.length && (day !== today || now - Date.parse(hit.updated_at) > TODAY_FRESH_MS)
      || (!byModel && provider && modelBudget > 0);
    if (stale) {
      let written = null;
      if (provider && modelBudget > 0) {
        modelBudget -= 1;
        written = await summarizeDay(rows, { locale, members, provider, allowance, channelName });
      }
      byModel = Boolean(written);
      // A model that failed leaves the model's older lines in place.
      if (!written && items && hit?.by_model && hit.count === rows.length) {
        byModel = true;
      } else {
        items = written || dayDigest(rows, members, locale);
        await env.DB.prepare(
          `INSERT INTO channel_journal (org_id, channel, day, tz, locale, count, items, by_model, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT (org_id, channel, day, tz, locale) DO UPDATE SET
             count = excluded.count, items = excluded.items, by_model = excluded.by_model, updated_at = excluded.updated_at`
        ).bind(orgId, resolved.key, day, tz, locale, rows.length, JSON.stringify(items), byModel ? 1 : 0, now.toISOString()).run().catch(() => {});
      }
    }
    // Cited messages that were since deleted are not cited.
    const live = new Set(rows.map((r) => r.id));
    const kept = (items || [])
      .map((item) => ({ text: item.text, messageIds: (item.messageIds || []).filter((id) => live.has(id)) }))
      .filter((item) => item.text);
    out.push({
      day,
      count: rows.length,
      firstAt: rows[0]?.created_at || null,
      byModel,
      items: withLinks(kept, rows, members),
    });
  }
  return { days: out, more, next: more && oldest ? oldest.day : null };
}

/// A channel's journal lines are about what was said; when a message goes,
/// its day is written again next time someone reads it.
export async function forgetJournalDay(db, orgId, key, createdAt) {
  const day = String(createdAt || "").slice(0, 10);
  if (!day) return;
  // The stored day is local to each reader's zone, which may be a day
  // either side of UTC's.
  const around = [-1, 0, 1].map((d) => new Date(Date.parse(`${day}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10));
  await db.prepare(
    "DELETE FROM channel_journal WHERE org_id = ?1 AND channel = ?2 AND day IN (?3, ?4, ?5)"
  ).bind(orgId, key, ...around).run().catch(() => {});
}
