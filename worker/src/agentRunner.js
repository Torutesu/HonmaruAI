/// Where agents answer from in production. A request may keep working for
/// only half a minute after it has answered (ctx.waitUntil); an agent that
/// searches, reads pages and searches again needs longer. So the message's
/// request hands the job here and returns; this Durable Object — one per
/// workspace — keeps it and answers from its alarm, which may run for
/// minutes. A job is taken off the list before it runs, so a failure never
/// answers twice.

import { getSession, getUserByGithubId } from "./db.js";
import { getMessage, resolveChannel, viewOf } from "./channels.js";
import { listMembers } from "./team.js";
import { agentsHere, agentsCalled, listAgents } from "./customAgents.js";
import { runAgents } from "./channelRoutes.js";

const MAX_JOBS = 50;

export class AgentRunner {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/enqueue") return new Response("Not found", { status: 404 });
    const job = await request.json().catch(() => null);
    if (!job?.orgId || !job?.token || !job?.rowId) return new Response("Bad job", { status: 400 });
    const waiting = await this.state.storage.list({ prefix: "job:", limit: MAX_JOBS + 1 });
    if (waiting.size >= MAX_JOBS) return new Response("Busy", { status: 503 });
    await this.state.storage.put(`job:${Date.now()}:${job.rowId}`, { ...job, queuedAt: Date.now() });
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now());
    return new Response("Queued", { status: 202 });
  }

  async alarm() {
    const jobs = await this.state.storage.list({ prefix: "job:", limit: 10 });
    // Off the list first: an alarm that fails is retried, and an answer
    // posted twice is worse than one that never came.
    await this.state.storage.delete([...jobs.keys()]);
    await Promise.allSettled([...jobs.values()].map((job) => runQueuedAgents(this.env, job).catch((err) => {
      console.error("queued agent failed", err?.message || err);
    })));
    const more = await this.state.storage.list({ prefix: "job:", limit: 1 });
    if (more.size) await this.state.storage.setAlarm(Date.now());
  }
}

/// One job: the message, who wrote it and where, found again from what was
/// kept — then the agents it calls answer.
export async function runQueuedAgents(env, { orgId, token, rowId, locale }) {
  const session = await getSession(env.DB, token);
  if (!session) return 0;
  const user = await getUserByGithubId(env.DB, session.github_id);
  const row = await getMessage(env.DB, orgId, rowId);
  if (!user?.login || !row || row.deleted_at) return 0;
  const members = await listMembers(env.DB, orgId, session.github_id);
  const view = viewOf(row.channel, user.login, members);
  const resolved = view ? await resolveChannel(env.DB, orgId, { ...user, github_id: session.github_id }, view, members) : null;
  if (!resolved || resolved.key !== row.channel) return 0;
  let agents = agentsCalled(row.body, await agentsHere(env.DB, orgId, user.login, resolved.key));
  if (resolved.kind === "agent" && !agents.some((a) => a.id === resolved.agent.id)) {
    const own = (await listAgents(env.DB, orgId, user.login)).find((a) => a.id === resolved.agent.id);
    if (own) agents = [own, ...agents].slice(0, 3);
  }
  if (!agents.length) return 0;
  return runAgents(env, { orgId, session, user: { ...user, github_id: session.github_id }, resolved, row, members, locale, agents });
}
