/// Where agents answer from in production. A request may keep working for
/// only half a minute after it has answered (ctx.waitUntil); an agent that
/// searches, reads pages and searches again needs longer. So the message's
/// request hands the job here and returns; this Durable Object — one per
/// workspace — keeps it and answers from its alarm, which may run for
/// minutes. A job is taken off the list before it runs, so a failure never
/// answers twice.

import { getSession, getUserByGithubId, isMember, sessionByKey } from "./db.js";
import { getMessage, resolveChannel, viewOf } from "./channels.js";
import { listMembers } from "./team.js";
import { respondingAgents } from "./customAgents.js";
import { runAgents } from "./channelRoutes.js";
import { runProxy } from "./proxy.js";
import { useSecretKey } from "./secrets.js";
import { useMirrorEnv } from "./store/mirror.js";
import { useMediaEnv } from "./mediaToken.js";

const MAX_JOBS = 50;

export class AgentRunner {
  constructor(state, env) {
    useSecretKey(env);
    useMirrorEnv(env);
    useMediaEnv(env);
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/enqueue") return new Response("Not found", { status: 404 });
    const job = await request.json().catch(() => null);
    // A proxy's job carries whose agent it is, not a session: it works for
    // the person mentioned, not the person who wrote.
    if (!job?.orgId || !job?.rowId || (job.kind === "proxy" ? !job.owner : !job.token)) return new Response("Bad job", { status: 400 });
    // The same message may reach enqueue again after a response is lost.
    // Keep the receipt after dequeue too: a running or completed request must
    // not start another paid run. A new request uses a new message ID.
    const receipt = `accepted:${JSON.stringify([job.orgId, job.kind === "proxy" ? "proxy" : "agent", job.rowId, job.kind === "proxy" ? job.owner : null])}`;
    const accepted = await this.state.storage.transaction(async storage => {
      if (await storage.get(receipt)) return true;
      const waiting = await storage.list({ prefix: "job:", limit: MAX_JOBS + 1 });
      // Recognize jobs queued by the previous version before receipts existed.
      const existing = [...waiting.values()].some(value => value.orgId === job.orgId && value.rowId === job.rowId &&
        (value.kind === "proxy") === (job.kind === "proxy") && (job.kind !== "proxy" || value.owner === job.owner));
      if (!existing && waiting.size >= MAX_JOBS) return false;
      const queuedAt = Date.now();
      if (!existing) await storage.put(`job:${queuedAt}:${job.rowId}${job.kind === "proxy" ? `:${job.owner}` : ""}`, { ...job, queuedAt });
      await storage.put(receipt, { acceptedAt: queuedAt });
      return true;
    });
    if (!accepted) return new Response("Busy", { status: 503 });
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now());
    return new Response("Queued", { status: 202 });
  }

  async alarm() {
    const jobs = await this.state.storage.list({ prefix: "job:", limit: 10 });
    // Off the list first: an alarm that fails is retried, and an answer
    // posted twice is worse than one that never came.
    await this.state.storage.delete([...jobs.keys()]);
    await Promise.allSettled([...jobs.values()].map((job) => (job.kind === "proxy" ? runProxy(this.env, job) : runQueuedAgents(this.env, job)).catch((err) => {
      console.error("queued agent failed", err?.message || err);
    })));
    const more = await this.state.storage.list({ prefix: "job:", limit: 1 });
    if (more.size) await this.state.storage.setAlarm(Date.now());
  }
}

/// One job: the message, who wrote it and where, found again from what was
/// kept — then the agents it calls answer.
export async function runQueuedAgents(env, { orgId, token, rowId, locale }) {
  // The session's stored key (channelRoutes.js); a job queued before
  // sessions were stored hashed carries the token itself.
  const session = String(token || "").startsWith("h1:") ? await sessionByKey(env.DB, token) : await getSession(env.DB, token);
  if (!session) return 0;
  // Whether this person may still ask here is decided now, as at the door
  // (channelRoutes.js caller): someone removed from the workspace, or held
  // out by its sign-in rules, since the job was queued has nothing answered.
  if (!(await isMember(env.DB, orgId, session.github_id))) return 0;
  const { policyDenial } = await import("./policy.js");
  if (await policyDenial(env, session, orgId)) return 0;
  const user = await getUserByGithubId(env.DB, session.github_id);
  const row = await getMessage(env.DB, orgId, rowId);
  if (!user?.login || !row || row.deleted_at) return 0;
  const members = await listMembers(env.DB, orgId, session.github_id);
  const view = viewOf(row.channel, user.login, members);
  const resolved = view ? await resolveChannel(env.DB, orgId, { ...user, github_id: session.github_id }, view, members) : null;
  if (!resolved || resolved.key !== row.channel) return 0;
  const agents = await respondingAgents(env.DB, { orgId, login: user.login, resolved, row });
  if (!agents.length) return 0;
  return runAgents(env, { orgId, session, user: { ...user, github_id: session.github_id }, resolved, row, members, locale, agents });
}
