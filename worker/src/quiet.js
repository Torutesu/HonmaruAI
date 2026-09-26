// Quiet time: when nothing reaches a person's phone, browser or inbox.
//
// Two ways, as in Slack:
//   paused    "Pause notifications" — for half an hour, an hour, until
//             tomorrow morning. Until `notify_paused_until`.
//   schedule  the hours notifications may come at all — "weekdays 9:00 to
//             18:00" — in the person's own timezone. Outside them it is quiet.
//
// Quiet stops the push and the email, not the message: it still arrives in
// the conversation and in Activity, and is there when they look.

import { zonedParts, isTimeZone } from "./schedule.js";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/// A schedule as stored: whether it is on, the days (0 = Sunday), and the
/// hours on those days. Anything malformed falls back to "off".
export function cleanSchedule(input) {
  // No days given: weekdays, the common case.
  const days = Array.isArray(input?.days)
    ? [...new Set(input.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [1, 2, 3, 4, 5];
  const from = TIME.test(String(input?.from || "")) ? input.from : "09:00";
  const to = TIME.test(String(input?.to || "")) ? input.to : "18:00";
  return { enabled: Boolean(input?.enabled), days, from, to };
}

export function parseSchedule(raw) {
  if (!raw) return cleanSchedule({ enabled: false, days: [1, 2, 3, 4, 5] });
  try { return cleanSchedule(JSON.parse(raw)); } catch { return cleanSchedule({ enabled: false, days: [1, 2, 3, 4, 5] }); }
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/// Whether `now` is outside the hours a schedule allows, where the person
/// is. On a day not in it, all day is quiet. Hours that cross midnight
/// ("22:00 to 06:00") are read as such.
export function outsideSchedule(schedule, timezone, now = new Date()) {
  if (!schedule?.enabled) return false;
  const p = zonedParts(now, isTimeZone(timezone) ? timezone : "UTC");
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const at = p.hour * 60 + p.minute;
  const from = minutes(schedule.from);
  const to = minutes(schedule.to);
  if (from === to) return !schedule.days.includes(weekday);
  if (from < to) return !schedule.days.includes(weekday) || at < from || at >= to;
  // Overnight: the evening belongs to today, the small hours to yesterday.
  if (at >= from) return !schedule.days.includes(weekday);
  if (at < to) return !schedule.days.includes((weekday + 6) % 7);
  return true;
}

/// The person's quiet state now: paused, outside their hours, or neither.
export async function quietFor(db, login, now = new Date()) {
  const row = await db.prepare("SELECT notify_paused_until, notify_schedule, timezone FROM users WHERE login = ?1").bind(login).first().catch(() => null);
  if (!row) return null;
  if (row.notify_paused_until && Date.parse(row.notify_paused_until) > now.getTime()) return { reason: "paused", until: row.notify_paused_until };
  if (outsideSchedule(parseSchedule(row.notify_schedule), row.timezone, now)) return { reason: "schedule" };
  return null;
}

/// "Pause for" — minutes from now, or an exact time; null resumes.
export function pauseUntil(input, now = new Date()) {
  if (input === null || input === false || input === 0) return null;
  if (typeof input === "number" && input > 0) return new Date(now.getTime() + Math.min(input, 7 * 24 * 60) * 60_000).toISOString();
  const at = Date.parse(String(input || ""));
  if (Number.isNaN(at) || at <= now.getTime()) return null;
  return new Date(Math.min(at, now.getTime() + 30 * 86400000)).toISOString();
}

// ---- Keywords ----
//
// Words that reach a person wherever they are said, as a mention would:
// "invoice", "見積", a client's name. Matched without regard to case or
// width; a word of Latin letters only as a whole word ("art" is not in
// "start"), anything else wherever it appears — Japanese has no spaces.

const MAX_KEYWORDS = 30;

export function cleanKeywords(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(/[,、\n]/);
  const out = [];
  for (const raw of list) {
    const word = String(raw || "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!word || [...word].length < 2 && !/[^\x00-\x7F]/.test(word)) continue;
    if (!out.some((w) => w.toLowerCase() === word.toLowerCase())) out.push(word);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

export function parseKeywords(raw) {
  if (!raw) return [];
  try { return cleanKeywords(JSON.parse(raw)); } catch { return []; }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/// The first of `keywords` that `text` says, or null.
export function keywordHit(text, keywords) {
  if (!text || !keywords?.length) return null;
  const hay = String(text).normalize("NFKC").toLowerCase();
  for (const word of keywords) {
    const w = word.toLowerCase();
    if (/^[a-z0-9][a-z0-9 _.-]*$/.test(w)) {
      if (new RegExp(`(^|[^a-z0-9_])${escape(w)}($|[^a-z0-9_])`).test(hay)) return word;
    } else if (hay.includes(w)) return word;
  }
  return null;
}

/// Everyone in a workspace with keywords, and theirs.
export async function keywordsIn(db, orgId) {
  const { results } = await db.prepare(
    `SELECT u.login, u.notify_keywords FROM memberships m JOIN users u ON u.github_id = m.user_github_id
      WHERE m.org_id = ?1 AND u.notify_keywords IS NOT NULL AND u.notify_keywords != '[]'`
  ).bind(orgId).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => ({ login: r.login, keywords: parseKeywords(r.notify_keywords) })).filter((r) => r.keywords.length);
}
