import { mayUseConversation } from './conversationAccess.js';
// Follow-ups (docs/kylon-gap-plan.md): "check whether Acme paid in three
// days". An agent — or the team's AI — comes back to the conversation at the
// time, does it, and says what it found where the thread is. Anyone in the
// conversation sees what is scheduled there and may cancel it.

import { postMessage } from "../channels.js";
import { completer } from "./model.js";
import { prepareAgent, mayRunAgent } from "./agents.js";
import { withRoomGuidelines } from "./guidelines.js";

export const MAX_PER_CHANNEL = 50;

const now = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

const pub = (r) => r && ({
  id: r.id, channel: r.channel, threadId: r.thread_id, agentId: r.agent_id, instruction: r.instruction,
  dueAt: r.due_at, status: r.status, createdBy: r.created_by, createdAt: r.created_at, doneAt: r.done_at, result: r.result,
});

export async function scheduleFollowup(db, { orgId, channel, threadId = null, agentId = null, instruction, dueAt, by }) {
  const text = String(instruction || "").trim().slice(0, 2000);
  if (!text) return { error: "Say what to follow up on." };
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) return { error: "A follow-up is for a time still to come." };
  if (!channel) return { error: "channel is required" };
  if (!(await mayUseConversation(db, orgId, by, channel))) return { error: "No such conversation.", status: 404 };
  if (agentId) {
    const agent = await db.prepare("SELECT * FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(orgId, agentId).first();
    if (!agent || !(await mayRunAgent(db, orgId, agent, by))) return { error: "No such agent.", status: 404 };
  }
  const n = await db.prepare("SELECT COUNT(*) AS n FROM hx_followups WHERE org_id = ?1 AND channel = ?2 AND status = 'scheduled'").bind(orgId, channel).first();
  if (Number(n?.n || 0) >= MAX_PER_CHANNEL) return { error: "This conversation has as many follow-ups waiting as it can hold." };
  const id = newId("fu");
  await db
    .prepare(`INSERT INTO hx_followups (id, org_id, channel, thread_id, agent_id, instruction, due_at, status, created_by, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'scheduled', ?8, ?9)`)
    .bind(id, orgId, String(channel), threadId, agentId, text, due.toISOString(), String(by), now())
    .run();
  return { followup: pub(await db.prepare("SELECT * FROM hx_followups WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first()) };
}

export async function listFollowups(db, orgId, { channel, status = "scheduled", viewerId } = {}) {
  const { results } = channel
    ? await db.prepare("SELECT * FROM hx_followups WHERE org_id = ?1 AND channel = ?2 AND status = ?3 ORDER BY due_at").bind(orgId, channel, status).all()
    : await db.prepare("SELECT * FROM hx_followups WHERE org_id = ?1 AND status = ?2 ORDER BY due_at LIMIT 200").bind(orgId, status).all();
  const visible = [];
  for (const row of results || []) {
    if (viewerId && await mayUseConversation(db, orgId, viewerId, row.channel)) visible.push(pub(row));
  }
  return visible;
}

export async function cancelFollowup(db, orgId, id) {
  const res = await db.prepare("UPDATE hx_followups SET status = 'cancelled', done_at = ?1 WHERE id = ?2 AND org_id = ?3 AND status = 'scheduled'").bind(now(), id, orgId).run();
  return res.meta?.changes ? { cancelled: true } : { error: "Nothing scheduled by that id.", status: 404 };
}

/// "follow up in 3 days: check whether Acme paid" / "3日後にフォローして: 入金確認".
/// Returns { minutes, text } or null.
export function followupRequest(text) {
  const t = String(text || "").trim();
  const unit = (u) => {
    const s = u.toLowerCase();
    if (/^(m|min|mins|minute|minutes|分)$/.test(s)) return 1;
    if (/^(h|hr|hrs|hour|hours|時間)$/.test(s)) return 60;
    if (/^(d|day|days|日)$/.test(s)) return 1440;
    if (/^(w|wk|week|weeks|週間)$/.test(s)) return 10080;
    return null;
  };
  const en = t.match(/^follow[\s-]?up\s+in\s+(\d+)\s*([a-z]+)\s*[:,-]?\s*(.+)$/is);
  if (en && unit(en[2])) return { minutes: Number(en[1]) * unit(en[2]), text: en[3].trim() };
  const ja = t.match(/^(\d+)\s*(分|時間|日|週間)後に(?:フォロー(?:アップ)?|確認)(?:して)?\s*[:：、,]?\s*(.+)$/s);
  if (ja) return { minutes: Number(ja[1]) * unit(ja[2]), text: ja[3].trim() };
  return null;
}

/// The cron's part: follow-ups whose time has come. Each is claimed before
/// it runs, so two crons cannot both answer it.
export async function runDueFollowups(env, { now: at = new Date(), limit = 25 } = {}) {
  const { results } = await env.DB
    // Every workspace's, by design: the cron's sweep. Each row then acts
    // only in its own org_id.
    .prepare("SELECT * FROM hx_followups WHERE status = 'scheduled' AND due_at <= ?1 ORDER BY due_at LIMIT ?2")
    .bind(at.toISOString(), limit)
    .all()
    .catch(() => ({ results: [] }));
  let done = 0;
  for (const r of results || []) {
    const claim = await env.DB.prepare("UPDATE hx_followups SET status = 'running' WHERE id = ?1 AND org_id = ?2 AND status = 'scheduled'").bind(r.id, r.org_id).run();
    if (!claim.meta?.changes) continue;
    let body = r.instruction;
    let author = null;
    let kind = "ai";
    try {
      if (!(await mayUseConversation(env.DB, r.org_id, r.created_by, r.channel))) throw new Error("Conversation access required.");
      const agentRow = r.agent_id
        ? await env.DB.prepare("SELECT * FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(r.org_id, r.agent_id).first()
        : null;
      if (r.agent_id && (!agentRow || !(await mayRunAgent(env.DB, r.org_id, agentRow, r.created_by)))) throw new Error("Agent access required.");
      if (agentRow) { author = `agent:${agentRow.id}`; kind = "agent"; }
      // The maker of a follow-up pays for it, as for anything they ask: a
      // person in this workspace, whichever way their account was made. The
      // shape of the id used to decide it, and an account made by SSO or by
      // the company's directory got the bare reminder instead of the answer.
      // A maker who is nobody's account here spends nobody's allowance.
      const member = await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(r.org_id, String(r.created_by)).first();
      const payer = member ? r.created_by : null;
      const complete = payer ? await completer(env, r.org_id, payer, "followup", { json: false, maxTokens: 800 }) : null;
      if (complete) {
        const prepared = agentRow
          ? await prepareAgent(env, r.org_id, { id: agentRow.id, name: agentRow.name, handle: agentRow.handle, instructions: agentRow.instructions }, null, { channel: r.channel || "", userId: r.created_by })
          : { agent: { name: "AI", handle: "AI", instructions: "You are the team's AI." } };
        const agent = await withRoomGuidelines(env.DB, r.org_id, r.channel, prepared.agent);
        const answer = await complete(
          `You are ${agent.name}. You said you would follow up on something, and the time has come. Do it now and say what you found, briefly, as a colleague would.\n\n<agent_instructions>\n${agent.researchInstructions || String(agent.instructions).slice(0, 8000)}\n</agent_instructions>`,
          `Follow-up you scheduled on ${String(r.created_at).slice(0, 10)}: ${r.instruction}`,
          { tools: prepared.skillTools, fallbackSystem: `You are ${agent.name}. Complete your scheduled follow-up and answer briefly.\n\n${agent.instructions}` },
        );
        if (!answer) throw new Error("The follow-up did not receive a result. No completion was posted.");
        body = answer;
      } else {
        body = `⏰ Follow-up: ${r.instruction}`;
      }
      const out = await postMessage(env.DB, { orgId: r.org_id, key: r.channel, authorLogin: author, body: String(body).slice(0, 8000), kind, parentId: r.thread_id || null });
      if (out?.row) {
        const { broadcastStored } = await import("../channelRoutes.js");
        await broadcastStored(env, r.org_id, r.channel, out.row).catch(() => {});
      }
      await env.DB.prepare("UPDATE hx_followups SET status = 'done', done_at = ?1, result = ?2 WHERE id = ?3 AND org_id = ?4").bind(now(), String(body).slice(0, 2000), r.id, r.org_id).run();
      done += 1;
    } catch (e) {
      await env.DB.prepare("UPDATE hx_followups SET status = 'failed', done_at = ?1, result = ?2 WHERE id = ?3 AND org_id = ?4").bind(now(), String(e?.message || e).slice(0, 300), r.id, r.org_id).run();
    }
  }
  return done;
}
