import { saveCard, getUserByLogin } from "./db.js";
import { sha256Hex } from "./auth.js";
import { termsOf } from "./memory.js";
import { describeSchedule, defaultTimeZoneFor, zonedParts } from "./schedule.js";
import { createRoutine } from "./routines.js";
import { appendCardEvent } from "./events.js";
import { announceCards } from "./announce.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { safe } from "./log.js";

// The AI proposes work it noticed, as a decision.
//
// The most useful thing an assistant does is offer the automation nobody
// thought to ask for. Here the offer is itself a card: "You have asked for
// the weekly numbers three Mondays running — shall I do it every Monday at
// 9?" Approve, and it is a routine. Decline, and it is never proposed again.
// Nothing runs on the AI's own say: the swipe is the permission.
//
// Detection is plain and local — no model: the same person asking for
// nearly the same thing on at least three different days in six weeks.

export const LOOKBACK_DAYS = 45;
const MIN_REPEATS = 3;
const SIMILARITY = 0.5;
/// Nobody is offered more than one automation a week. An AI that keeps
/// proposing gets its notifications turned off.
const PER_PERSON_DAYS = 7;
const MAX_ORGS_PER_RUN = 50;

function parse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/// What a person typed, as opposed to what arrived from a connector or was
/// made by the AI itself.
function isInstruction(card) {
  return card && !card.report && !card.proposal && !card.sourceApp && (card.sourceInstruction || card.title);
}

/// Groups of near-identical requests per sender. Returns
/// `[{ sender, cards: [...] }]`, each with at least three distinct days.
export function findRepeats(cards) {
  const bySender = new Map();
  for (const c of cards) {
    if (!isInstruction(c) || !c.senderUserID) continue;
    const list = bySender.get(c.senderUserID) || [];
    list.push({ card: c, terms: termsOf(c.sourceInstruction || c.title) });
    bySender.set(c.senderUserID, list);
  }
  const groups = [];
  for (const [sender, list] of bySender) {
    const used = new Set();
    for (let i = 0; i < list.length; i += 1) {
      if (used.has(i) || list[i].terms.size < 2) continue;
      const cluster = [i];
      for (let j = i + 1; j < list.length; j += 1) {
        if (used.has(j)) continue;
        if (similarity(list[i].terms, list[j].terms) >= SIMILARITY) cluster.push(j);
      }
      const days = new Set(cluster.map((k) => String(list[k].card.createdAt || "").slice(0, 10)));
      if (days.size < MIN_REPEATS) continue;
      for (const k of cluster) used.add(k);
      groups.push({ sender, cards: cluster.map((k) => list[k].card) });
    }
  }
  return groups;
}

/// The schedule the repeats suggest: the same weekday every time is weekly,
/// every working day is weekdays, otherwise the most common weekday. The
/// hour is when the person usually asked, rounded down.
export function inferSchedule(cards, timezone) {
  const parts = cards
    .map((c) => Date.parse(c.createdAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .map((t) => zonedParts(new Date(t), timezone));
  const weekdays = parts.map((p) => p.weekday);
  const counts = new Map();
  for (const d of weekdays) counts.set(d, (counts.get(d) || 0) + 1);
  const [topDay, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0] || [1, 0];
  const hours = parts.map((p) => p.hour).sort((a, b) => a - b);
  const hour = hours.length ? hours[Math.floor(hours.length / 2)] : 9;
  const distinctDays = new Set(weekdays).size;
  if (topCount >= Math.ceil(parts.length * 0.6)) {
    return { cadence: "weekly", weekday: topDay, hour, minute: 0 };
  }
  if (distinctDays >= 3 && weekdays.every((d) => d >= 1 && d <= 5)) {
    return { cadence: "weekdays", hour, minute: 0 };
  }
  return { cadence: "weekly", weekday: topDay, hour, minute: 0 };
}

const COPY = {
  en: {
    title: (what) => `Automate: ${what}`,
    summary: (n, schedule) => `You asked for this ${n} times in the last few weeks. Approve, and your AI will do it ${schedule.toLowerCase()} and bring the result here.`,
    context: (dates) => `Asked on ${dates}. Decline and this will not be proposed again. You can change or stop the routine any time under Automations.`,
  },
  ja: {
    title: (what) => `自動化しませんか: ${what}`,
    summary: (n, schedule) => `この数週間で${n}回依頼しています。承認すると、AIが${schedule}に実行して結果をここに届けます。`,
    context: (dates) => `依頼日: ${dates}。却下すると二度と提案しません。ルーティンはいつでも「自動化」から変更・停止できます。`,
  },
};

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/// Propose for one workspace. Returns the cards made.
export async function proposeForOrg(env, orgId, { now = new Date() } = {}) {
  const db = env.DB;
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString();
  const { results } = await db
    .prepare("SELECT data FROM cards WHERE org_id = ?1 AND created_at >= ?2 ORDER BY created_at ASC LIMIT 500")
    .bind(orgId, since)
    .all();
  const cards = (results || []).map((r) => parse(r.data)).filter(Boolean);
  const groups = findRepeats(cards);
  if (!groups.length) return [];

  const recentCutoff = new Date(now.getTime() - PER_PERSON_DAYS * 86400000).toISOString();
  const made = [];
  const offered = new Set();
  for (const group of groups) {
    const login = group.sender;
    if (offered.has(login)) continue;
    const user = await getUserByLogin(db, login);
    if (!user) continue;
    const member = await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, user.github_id).first();
    if (!member) continue;

    const representative = group.cards[group.cards.length - 1];
    const instruction = clip(representative.sourceInstruction || representative.title, 600);
    const signature = (await sha256Hex(`${login}\u0000${[...termsOf(instruction)].sort().join(" ")}`)).slice(0, 24);
    const seen = await db.prepare("SELECT 1 FROM proposals WHERE org_id = ?1 AND signature = ?2").bind(orgId, signature).first();
    if (seen) continue;
    const lately = await db
      .prepare("SELECT 1 FROM proposals WHERE org_id = ?1 AND login = ?2 AND created_at >= ?3 LIMIT 1")
      .bind(orgId, login, recentCutoff)
      .first();
    if (lately) { offered.add(login); continue; }
    // Already automated: a routine of theirs that says the same thing.
    const { results: theirs } = await db
      .prepare("SELECT instruction FROM routines WHERE org_id = ?1 AND owner_login = ?2")
      .bind(orgId, login)
      .all();
    const wanted = termsOf(instruction);
    if ((theirs || []).some((r) => similarity(termsOf(r.instruction), wanted) >= SIMILARITY)) continue;

    const locale = user.locale === "ja" ? "ja" : "en";
    const timezone = defaultTimeZoneFor(user.locale);
    const schedule = inferSchedule(group.cards, timezone);
    const routine = { title: clip(representative.title || instruction, 60), instruction, timezone, ...schedule };
    const copy = COPY[locale];
    const dates = group.cards.map((c) => String(c.createdAt).slice(0, 10)).join(", ");
    const cardId = `proposal-${signature}`;
    const card = {
      id: cardId,
      recipientUserID: login,
      senderUserID: login,
      type: "approval",
      title: clip(copy.title(routine.title), 120),
      summary: copy.summary(group.cards.length, describeSchedule(routine, locale)),
      context: copy.context(dates),
      priority: "low",
      status: "pending",
      createdAt: now.toISOString(),
      sourceApp: "Your AI",
      sourceDetail: locale === "ja" ? "自動化の提案" : "Automation proposal",
      originalLanguage: locale,
      proposal: { kind: "routine", signature, routine, evidence: group.cards.slice(-5).map((c) => ({ id: c.id, title: clip(c.title, 100), createdAt: c.createdAt })) },
    };
    await saveCard(db, orgId, card);
    await db
      .prepare("INSERT INTO proposals (org_id, signature, login, card_id, routine, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)")
      .bind(orgId, signature, login, cardId, JSON.stringify(routine), now.toISOString())
      .run();
    await appendCardEvent(db, orgId, { cardId, type: "created", actorUserId: login, note: "proposal", snapshot: card });
    offered.add(login);
    made.push(card);
  }
  if (made.length) {
    await announceCards(env, orgId, made);
    if (anyChannelConfigured(env)) {
      for (const card of made) {
        await notifyCard(env, { card, kind: "created", excludeLogin: null }).catch((err) => console.error("proposal notify failed", safe(err?.message)));
      }
    }
  }
  return made;
}

/// The cron's part, once a day: every workspace with recent instructions.
export async function runProposals(env, { now = new Date() } = {}) {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString();
  const { results } = await env.DB
    .prepare(
      `SELECT org_id FROM cards WHERE created_at >= ?1
        GROUP BY org_id HAVING COUNT(*) >= ?2 ORDER BY MAX(created_at) DESC LIMIT ?3`
    )
    .bind(since, MIN_REPEATS, MAX_ORGS_PER_RUN)
    .all();
  let proposed = 0;
  for (const { org_id: orgId } of results || []) {
    try {
      proposed += (await proposeForOrg(env, orgId, { now })).length;
    } catch (err) {
      console.error("proposals failed", orgId, safe(err?.message));
    }
  }
  return { orgs: (results || []).length, proposed };
}

/// Whether this tick is the day's proposal tick: the first quarter hour of
/// the UTC day.
export function isProposalTick(now) {
  return now.getUTCHours() === 0 && now.getUTCMinutes() < 15;
}

/// A decision on a proposal card. Approved: the routine is made, owned by
/// whoever approved it. Declined: the proposal is closed for good. Never
/// throws; returns the routine when one was made.
export async function settleProposal(env, orgId, card) {
  const proposal = card?.proposal;
  if (proposal?.kind !== "routine" || !proposal.signature) return null;
  const action = card.decision?.action;
  if (!action) return null;
  try {
    const row = await env.DB
      .prepare("SELECT status, login, card_id, routine FROM proposals WHERE org_id = ?1 AND signature = ?2")
      .bind(orgId, proposal.signature)
      .first();
    // Settled once. An undo and a second approval must not make a second
    // routine. And only the card the proposal was made as, decided by the
    // person it was made to: a card carrying a copied signature is not it.
    if (!row || row.status !== "pending") return null;
    if (row.card_id !== card.id || row.login !== card.recipientUserID) return null;
    if (card.decision.actorUserID && card.decision.actorUserID !== row.login) return null;
    const accepted = action === "approve" || action === "choose";
    await env.DB
      .prepare("UPDATE proposals SET status = ?3 WHERE org_id = ?1 AND signature = ?2")
      .bind(orgId, proposal.signature, accepted ? "accepted" : "declined")
      .run();
    if (!accepted) return null;
    const owner = await getUserByLogin(env.DB, card.recipientUserID);
    if (!owner) return null;
    let r = {};
    try { r = JSON.parse(row.routine) || {}; } catch { r = {}; }
    const out = await createRoutine(env.DB, {
      orgId,
      owner: { github_id: owner.github_id, login: owner.login },
      recipientLogin: owner.login,
      origin: "proposal",
      input: {
        kind: "report", title: clip(r.title, 80) || "Routine", instruction: clip(r.instruction, 2000),
        cadence: r.cadence, weekday: r.weekday, monthday: r.monthday, hour: r.hour, minute: r.minute || 0,
        timezone: r.timezone || "UTC",
      },
    });
    return out.routine || null;
  } catch (err) {
    console.error("proposal settle failed", safe(err?.message));
    return null;
  }
}
