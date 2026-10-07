/// A person's agent, answering for them when they are mentioned.
///
/// "@toru review PR 858" used to wait for Toru to read it, copy it into an
/// AI and paste the answer back. With his proxy on, his agent reads the
/// message the moment it is sent and, when it asks for something an agent
/// can do, does it and answers in the thread — as Toru's agent, never as
/// Toru. Work on code goes to the workspace's AI teammate (Claude), which
/// has the repositories; anything else to his own agent.
///
/// Answering in the chat needs nobody's yes. Writing anywhere else — a
/// comment on a pull request — does: the agent proposes it, and it waits
/// as a card for Toru to approve before it is posted with his GitHub.

import { getUserByLogin, saveCard } from "./db.js";
import { getMessage, postMessage, resolveChannel, viewOf, MAX_MESSAGE_CHARS } from "./channels.js";
import { resolveMentions } from "./threads.js";
import { listAgents, saveAgent, askAgent, contextFor, cleanAgentHandle } from "./customAgents.js";
import { agentTools } from "./agentTools.js";
import { accessFor, mayRead } from "./access.js";
import { providerFor } from "./orgAI.js";
import { allowanceFor } from "./gate.js";
import { settleUsage, noteUsage } from "./ledger.js";
import { loadTeammate, canSignIn, startTeammateRun } from "./teammates.js";
import { getWorkspaceGitHub } from "./githubWorkspace.js";
import { EMAIL_AUTH_TOKEN } from "./auth.js";
import { appendCardEvent } from "./events.js";
import { announceCards } from "./announce.js";
import { localizeForRecipient } from "./localize.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";
import { safe } from "./log.js";

/// How many people one message may set to work at once.
export const MAX_PROXIES = 2;
/// The provider of the teammate that takes work on code.
const CODE_TEAMMATE = "claude";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ACTION_BODY = 20000;

const clip = (s, n) => {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- Settings ----

/// One person's proxy, as it is set: off until they turn it on.
export async function getProxy(db, orgId, login) {
  const row = await db.prepare("SELECT enabled, agent_id, use_teammate FROM proxies WHERE org_id = ?1 AND login = ?2")
    .bind(orgId, login).first().catch(() => null);
  return { enabled: Boolean(row?.enabled), agentId: row?.agent_id || null, useTeammate: row ? Boolean(row.use_teammate) : true };
}

/// The agent that answers for this person: one of their own personal
/// agents, the one they chose.
async function ownAgent(db, orgId, login, agentId) {
  if (!agentId) return null;
  return (await listAgents(db, orgId, login)).find((a) => a.id === agentId && a.scope === "personal" && a.ownerLogin === login && !a.provider) || null;
}

const defaultInstructions = (name) => `# ${name}'s agent

You answer for ${name} when teammates mention ${name} in the team chat and ask for something.

- Do what was asked, now, the way ${name} would: look it up, read it, review it, draft it.
- Be brief and concrete. Say what you checked.
- What only ${name} can give — a decision, a personal opinion, a promise of their time — leave to ${name}, and say so in one line.`;

/// Turn the proxy on or off, or change who answers. Turned on without an
/// agent chosen, one is made for them: "<Name> AI", @<handle>-ai.
export async function saveProxy(db, orgId, user, input, members) {
  const current = await getProxy(db, orgId, user.login);
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : current.enabled;
  const useTeammate = typeof input?.useTeammate === "boolean" ? input.useTeammate : current.useTeammate;
  let agentId = input?.agentId === null ? null : typeof input?.agentId === "string" ? input.agentId : current.agentId;
  if (agentId && !(await ownAgent(db, orgId, user.login, agentId))) return { error: "Choose one of your own personal agents.", status: 400 };
  if (enabled && !agentId) {
    const name = clip(`${user.name || user.login} AI`, 40);
    const base = cleanAgentHandle(`${String(user.login).replace(/^(u:|email:)/, "").split("@")[0]}-ai`) || "my-ai";
    for (const handle of [base, `${base}${Math.floor(Math.random() * 90 + 10)}`, `${base}${Math.floor(Math.random() * 900 + 100)}`]) {
      const made = await saveAgent(db, orgId, {
        input: { name, handle, emoji: "🤖", scope: "personal", description: `Answers for ${user.name || user.login} when they are mentioned`, instructions: defaultInstructions(user.name || user.login) },
        login: user.login, members,
      });
      if (made.agent) { agentId = made.agent.id; break; }
      if (made.status !== 409) return { error: made.error, status: made.status || 400 };
    }
    if (!agentId) return { error: "Could not make an agent for you. Choose one of yours.", status: 409 };
  }
  await db.prepare(
    `INSERT INTO proxies (org_id, login, enabled, agent_id, use_teammate, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(org_id, login) DO UPDATE SET enabled = excluded.enabled, agent_id = excluded.agent_id, use_teammate = excluded.use_teammate, updated_at = excluded.updated_at`
  ).bind(orgId, user.login, enabled ? 1 : 0, agentId, useTeammate ? 1 : 0, new Date().toISOString()).run();
  return { proxy: await getProxy(db, orgId, user.login) };
}

// ---- Who was mentioned ----

/// The people a message names one by one — not "@channel", not a group,
/// not its own author, not an agent.
export function mentionedPeople(body, members, authorLogin) {
  const one = members.map((m) => ({ ...m, groups: [] }));
  return resolveMentions(body, one, { here: false })
    .filter((m) => m.login && m.login !== authorLogin && !String(m.login).startsWith("agent:"))
    .slice(0, MAX_PROXIES);
}

/// After a person's message is posted: the agents of the people it names
/// who turned theirs on. Long work goes to the AgentRunner, like the
/// agents a message calls by name; tests and local runs do it here.
export async function answerAsProxies(env, { orgId, resolved, row, members, locale }) {
  if (resolved.kind === "agent" || row.kind !== "message" || !row.author_login) return 0;
  const people = mentionedPeople(row.body, members, row.author_login);
  let started = 0;
  for (const person of people) {
    const proxy = await getProxy(env.DB, orgId, person.login);
    if (!proxy.enabled) continue;
    // Only where they could read it themselves.
    if (!mayRead(row.channel, await accessFor(env.DB, orgId, person.login))) continue;
    const job = { kind: "proxy", orgId, rowId: row.id, owner: person.login, locale: locale || "en" };
    if (env.AGENT_RUNNER && env.AGENT_INLINE !== "1") {
      try {
        const stub = env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(orgId));
        const res = await stub.fetch("https://agents/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
        if (res.ok) { started += 1; continue; }
      } catch (err) {
        console.error("proxy enqueue failed", safe(err?.message));
      }
    }
    await runProxy(env, job).catch((err) => console.error("proxy failed", safe(err?.message)));
    started += 1;
  }
  return started;
}

// ---- Deciding what to do ----

/// Whether a message that mentions someone asks them for something their
/// agent can do now: "none" (thanks, news, a decision only they can make),
/// "answer" (a question, a look-up, a draft), or "code" (a repository: a
/// pull request to review, code to read or fix).
export async function classifyAsk(provider, { owner, asker, body, transcript = [] }) {
  if (!provider) return { act: "none", called: false };
  const system = `A message in a team chat mentions ${owner}. ${owner}'s AI agent can act for ${owner}. Decide whether the message asks ${owner} for something the agent could do right now.
Reply with JSON only: {"act":"none"} or {"act":"answer"} or {"act":"code"}.
- none: greetings, thanks, news or FYI, social chat, a status update, scheduling ${owner}'s time, or a decision, approval or personal opinion only ${owner} can give.
- answer: a question to answer, something to look up, explain, summarize, write or draft.
- code: work in a code repository — review a pull request, read or explain code, find or fix a bug in code.`;
  const user = `${transcript.length ? `Earlier:\n${transcript.slice(-8).join("\n").slice(-2500)}\n\n` : ""}${asker} wrote: ${clip(body, 2000)}`;
  try {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: provider.model, temperature: 0, max_tokens: 20, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) return { act: "none", called: false };
    const data = await res.json();
    noteUsage(provider, "proxy", data);
    const text = String(data?.choices?.[0]?.message?.content || "");
    const act = /"act"\s*:\s*"(none|answer|code)"/.exec(text)?.[1] || "none";
    return { act, called: true };
  } catch {
    return { act: "none", called: false };
  }
}

// ---- What it would do outside the chat ----

const ACTION_BLOCK = /```proxy-action[^\n]*\n([\s\S]*?)```\s*$/;

/// An answer and the one thing it proposes doing outside the chat, apart.
/// Only a comment on a GitHub pull request or issue is understood; a block
/// that is anything else is taken out and dropped.
export function takeAction(text) {
  const raw = String(text || "");
  const m = ACTION_BLOCK.exec(raw.trimEnd());
  if (!m) return { text: raw.trim(), action: null };
  const rest = raw.trimEnd().slice(0, m.index).trim();
  let parsed = null;
  try { parsed = JSON.parse(m[1]); } catch { parsed = null; }
  const number = Number(parsed?.number);
  const body = typeof parsed?.body === "string" ? parsed.body.trim() : "";
  const ok = parsed?.kind === "github_comment" && REPO.test(String(parsed.repo || "")) && Number.isSafeInteger(number) && number > 0 && body;
  return { text: rest, action: ok ? { kind: "github_comment", repo: String(parsed.repo), number, body: body.slice(0, MAX_ACTION_BODY) } : null };
}

const ACTION_RULES = (owner) => `
If something should be written outside this chat for ${owner} — a review or a comment on a GitHub pull request or issue — write it in full at the very end of your reply, after your answer, exactly like this:
\`\`\`proxy-action
{"kind":"github_comment","repo":"owner/name","number":123,"body":"the comment, in Markdown"}
\`\`\`
${owner} approves it before it is posted. Only when it is clearly wanted, and at most one.`;

/// What the agent is asked: who mentioned whom, what they wrote, and that
/// it works for the person mentioned.
export function proxyRequest({ owner, asker, body }) {
  return `${asker} mentioned ${owner}, and you are ${owner}'s agent: you answer for ${owner}, as ${owner}'s agent, never as ${owner}.
What ${asker} wrote: ${body}

Do what was asked, now. You only read: you do not post, push, merge or change anything outside this chat yourself.${ACTION_RULES(owner)}`;
}

// ---- Running one ----

/// A GitHub token to act with for this person: their own, from a session
/// they signed in to with GitHub, else the workspace's repository token.
export async function githubTokenFor(env, orgId, login) {
  const user = await getUserByLogin(env.DB, login);
  if (user?.github_id) {
    const row = await env.DB.prepare(
      `SELECT github_access_token AS token FROM sessions
        WHERE github_id = ?1 AND github_access_token IS NOT NULL AND github_access_token != ?2 AND github_access_token != '' AND expires_at > ?3
        ORDER BY created_at DESC LIMIT 1`
    ).bind(String(user.github_id), EMAIL_AUTH_TOKEN, new Date().toISOString()).first().catch(() => null);
    if (row?.token) return row.token;
  }
  const workspace = await getWorkspaceGitHub(env.DB, orgId).catch(() => null);
  return workspace?.token || null;
}

const gh = (token, path, init = {}) => fetch(`https://api.github.com${path}`, {
  ...init,
  headers: {
    authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "HonmaruAI", "x-github-api-version": "2022-11-28",
    ...(init.body ? { "content-type": "application/json" } : {}),
  },
});

/// The repositories a proxy may read and comment on: the workspace's own —
/// its connected repository and the ones its AI teammates work in. Not
/// whatever the person's GitHub can reach: whoever mentions them must not
/// be able to have a private repository they cannot see read out to them.
export async function workspaceRepos(env, orgId) {
  const out = new Set();
  const ws = await getWorkspaceGitHub(env.DB, orgId).catch(() => null);
  if (ws?.repo) out.add(String(ws.repo).toLowerCase());
  const { results } = await env.DB.prepare("SELECT repos FROM ai_teammates WHERE org_id = ?1 AND enabled = 1").bind(orgId).all().catch(() => ({ results: [] }));
  for (const r of results || []) {
    try { for (const repo of JSON.parse(r.repos || "[]")) out.add(String(repo).toLowerCase()); } catch { /* none */ }
  }
  return out;
}

/// A pull request as an agent reads it: what it says it does, and its
/// changes, file by file, cut to fit.
export async function readPullRequest(token, repo, number, { max = 40000 } = {}) {
  if (!REPO.test(repo) || !(Number(number) > 0)) return "That is not a pull request (owner/name and a number).";
  const [pr, files] = await Promise.all([
    gh(token, `/repos/${repo}/pulls/${Number(number)}`),
    gh(token, `/repos/${repo}/pulls/${Number(number)}/files?per_page=100`),
  ]);
  if (!pr.ok) return `Could not read ${repo}#${number}: GitHub said ${pr.status}.`;
  const p = await pr.json();
  const list = files.ok ? await files.json() : [];
  let out = `${repo}#${number}: ${p.title}\nBy ${p.user?.login || "?"} · ${p.state}${p.merged ? " (merged)" : ""} · ${p.head?.ref} → ${p.base?.ref}\n\n${clip(p.body || "(no description)", 4000)}\n\nFiles changed (${list.length}):\n`;
  for (const f of list) {
    const piece = `\n--- ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n${f.patch ? f.patch : "(no text diff)"}\n`;
    if (out.length + piece.length > max) { out += `\n… ${list.length - list.indexOf(f)} more file(s) not shown.`; break; }
    out += piece;
  }
  return out;
}

/// One proxy's turn: the message found again, what it asks decided, and
/// the work done by the teammate (code) or the person's own agent.
export async function runProxy(env, { orgId, rowId, owner: ownerLogin, locale = "en" }) {
  const db = env.DB;
  const row = await getMessage(db, orgId, rowId);
  if (!row || row.deleted_at || row.kind !== "message") return null;
  const proxy = await getProxy(db, orgId, ownerLogin);
  if (!proxy.enabled) return null;
  const owner = await getUserByLogin(db, ownerLogin);
  const askerUser = row.author_login ? await getUserByLogin(db, row.author_login) : null;
  if (!owner || !askerUser) return null;
  const { listMembers } = await import("./team.js");
  const members = await listMembers(db, orgId, null);
  if (!mayRead(row.channel, await accessFor(db, orgId, owner.login))) return null;
  const view = viewOf(row.channel, owner.login, members);
  const resolved = view ? await resolveChannel(db, orgId, owner, view, members) : null;
  if (!resolved || resolved.key !== row.channel) return null;
  const ownerName = owner.name || owner.login;
  const askerName = askerUser.name || askerUser.login;
  locale = await loadCopy(env, locale || owner.locale || "en", { orgId });

  const provider = await providerFor(env, orgId);
  const allowance = provider ? await allowanceFor(env, orgId, { githubId: String(owner.github_id) }) : null;
  if (!provider || !allowance?.allowed) return null;
  const transcript = await contextFor(db, orgId, row.channel, row).catch(() => []);
  const decided = await classifyAsk(provider, { owner: ownerName, asker: askerName, body: row.body, transcript });
  if (decided.called && allowance.metered) await allowance.consume();
  if (decided.act === "none") { await settleUsage(db, provider, { orgId, githubId: owner.github_id }); return { act: "none" }; }

  const parentId = row.parent_id || row.id;
  const { broadcastWithParent } = await import("./channelRoutes.js");
  const say = async (authorLogin, body) => {
    const out = await postMessage(db, { orgId, key: row.channel, authorLogin, body: clip(body, MAX_MESSAGE_CHARS), kind: "agent", parentId, onBehalfOf: owner.login });
    if (out.row) {
      await broadcastWithParent(env, orgId, resolved, out.row, members);
      const { queueMessagePushes } = await import("./pushes.js");
      await queueMessagePushes(env, orgId, out.row, { members }).catch(() => {});
    }
    return out.row || null;
  };

  // Code: the workspace's teammate, which has the repositories.
  if (decided.act === "code" && proxy.useTeammate) {
    const t = await loadTeammate(db, orgId, CODE_TEAMMATE).catch(() => null);
    if (t?.enabled && t.agentId && canSignIn(t) && !(t.channels && row.channel.startsWith("b:") && !t.channels.includes(row.channel))) {
      await settleUsage(db, provider, { orgId, githubId: owner.github_id });
      try {
        const started = await startTeammateRun(env, {
          orgId, t, key: row.channel, threadId: parentId, where: resolved.kind === "business" ? `the #${resolved.slug} channel` : "a direct conversation",
          askedBy: askerName, transcript, request: proxyRequest({ owner: ownerName, asker: askerName, body: row.body }), login: owner.login, onBehalfOf: owner.login,
        });
        if (started.refused) {
          await say(`agent:${t.agentId}`, serverText(locale, started.refused === "limit" ? "teammate.limit" : started.refused === "busy" ? "teammate.busy" : "teammate.notHere"));
          return { act: "code", refused: started.refused };
        }
        await say(`agent:${t.agentId}`, serverText(locale, "proxy.started", { name: ownerName }));
        const { watchTeammateRuns } = await import("./channelRoutes.js");
        await watchTeammateRuns(env, { ids: [started.run.id], deadline: Date.now() + (env.AGENT_INLINE === "1" || !env.AGENT_RUNNER ? 20000 : 240000) });
        return { act: "code", run: started.run.id };
      } catch (err) {
        console.error("proxy teammate failed", safe(err?.message));
        // Falls through to the person's own agent.
      }
    }
  }

  const agent = await ownAgent(db, orgId, owner.login, proxy.agentId);
  if (!agent) { await settleUsage(db, provider, { orgId, githubId: owner.github_id }); return null; }
  const tools = await agentTools(env, { orgId, session: null, language: locale, personal: false }).catch(() => ({}));
  const token = await githubTokenFor(env, orgId, owner.login).catch(() => null);
  const repos = await workspaceRepos(env, orgId);
  if (token && repos.size) {
    tools.read_github_pull_request = {
      description: `Read a GitHub pull request: its title, description and the diff of every changed file. Use it whenever the request names a pull request (a link, or a repository and a number), before reviewing it. The team's repositories: ${[...repos].join(", ")}.`,
      parameters: {
        type: "object",
        properties: { repo: { type: "string", description: "owner/name" }, number: { type: "integer", description: "The pull request number." } },
        required: ["repo", "number"],
        additionalProperties: false,
      },
      run: async ({ repo, number }) => (repos.has(String(repo || "").toLowerCase())
        ? readPullRequest(token, String(repo), Number(number))
        : `Not read: only the team's repositories can be read here (${[...repos].join(", ")}).`),
    };
  }
  let text = null;
  try {
    const result = await askAgent({
      provider, agent, request: proxyRequest({ owner: ownerName, asker: askerName, body: row.body }), transcript, playbook: [],
      where: resolved.kind === "business" ? `#${resolved.slug}` : "a direct conversation", askedBy: askerName, readerLanguage: locale,
      tools, env, deadline: Date.now() + (env.AGENT_INLINE === "1" || !env.AGENT_RUNNER ? 25000 : 240000),
    });
    if (result.called && allowance.metered) await allowance.consume();
    text = result.answer;
  } catch (err) {
    console.error("proxy agent failed", safe(err?.message));
  }
  await settleUsage(db, provider, { orgId, githubId: owner.github_id });
  if (!text) return { act: decided.act, answered: false };
  const { text: words, action: proposed } = takeAction(text);
  // A comment only where the agent may read: the team's repositories.
  const action = proposed && repos.has(proposed.repo.toLowerCase()) ? proposed : null;
  const posted = await say(`agent:${agent.id}`, action ? `${words}\n\n${serverText(locale, "proxy.waiting", { name: ownerName, where: `${action.repo}#${action.number}` })}` : words);
  if (action && posted) await proposeAction(env, { orgId, owner, asker: askerUser, action, key: row.channel, threadId: parentId, agentLogin: `agent:${agent.id}`, where: resolved.kind === "business" ? `#${resolved.slug}` : null });
  return { act: decided.act, answered: true, action };
}

// ---- Approval ----

/// The thing the agent would do outside the chat, as a card to the person
/// it works for. Nothing happens until they approve it.
export async function proposeAction(env, { orgId, owner, asker, action, key, threadId, agentLogin, where = null }) {
  const db = env.DB;
  const locale = await loadCopy(env, owner.locale || "en", { orgId });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cardId = `proxy-${id.slice(0, 13)}`;
  const target = `${action.repo}#${action.number}`;
  const card = {
    id: cardId,
    recipientUserID: owner.login,
    senderUserID: owner.login,
    type: "approval",
    title: clip(serverText(locale, "proxy.cardTitle", { where: target }), 120),
    summary: clip(action.body.replace(/\s+/g, " "), 400),
    context: clip(action.body, 8000),
    priority: "medium",
    status: "pending",
    createdAt: now,
    sourceApp: "Your agent",
    sourceDetail: where || target,
    requestedBy: { login: asker.login, name: asker.name || asker.login },
    originalLanguage: locale,
    proxyAction: { id, kind: action.kind, repo: action.repo, number: action.number },
  };
  await saveCard(db, orgId, card);
  await db.prepare(
    `INSERT INTO proxy_actions (id, org_id, login, card_id, kind, payload, channel, thread_id, agent_login, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)`
  ).bind(id, orgId, owner.login, cardId, action.kind, JSON.stringify(action), key, threadId || null, agentLogin, now).run();
  await appendCardEvent(db, orgId, { cardId, type: "created", actorUserId: owner.login, note: "proxy action", snapshot: card });
  const shown = await localizeForRecipient(env, orgId, card).catch(() => card);
  await announceCards(env, orgId, [shown]).catch(() => {});
  if (anyChannelConfigured(env)) await notifyCard(env, { card: shown, kind: "created", excludeLogin: null, orgId }).catch(() => {});
  return { card, id };
}

/// A proxy card decided: approved, the comment is posted with the person's
/// GitHub and the thread is told where; declined, it is dropped. Settled
/// once, and only by the person it was proposed to.
export async function settleProxyAction(env, orgId, card) {
  const ref = card?.proxyAction;
  const action = card?.decision?.action;
  if (!ref?.id || !action) return null;
  const db = env.DB;
  const row = await db.prepare("SELECT * FROM proxy_actions WHERE id = ?1 AND org_id = ?2").bind(ref.id, orgId).first().catch(() => null);
  if (!row || row.status !== "pending" || row.card_id !== card.id || row.login !== card.recipientUserID) return null;
  if (card.decision.actorUserID && card.decision.actorUserID !== row.login) return null;
  const accepted = action === "approve" || action === "choose";
  if (!accepted && action !== "decline" && action !== "reject") return null;
  const claimed = await db.prepare("UPDATE proxy_actions SET status = ?3, settled_at = ?4 WHERE id = ?1 AND org_id = ?2 AND status = 'pending'")
    .bind(row.id, orgId, accepted ? "approved" : "declined", new Date().toISOString()).run();
  if (!(claimed?.meta?.changes > 0) || !accepted) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload) || {}; } catch { payload = {}; }
  // Still one of the team's repositories, now that it is to be written.
  const allowed = await workspaceRepos(env, orgId);
  const owner = await getUserByLogin(db, row.login);
  const locale = await loadCopy(env, owner?.locale || "en", { orgId });
  let note;
  let result = null;
  try {
    if (!allowed.has(String(payload.repo || "").toLowerCase())) throw new Error("not the team's repository");
    const token = await githubTokenFor(env, orgId, row.login);
    if (!token) throw new Error("no GitHub");
    const res = await gh(token, `/repos/${payload.repo}/issues/${Number(payload.number)}/comments`, { method: "POST", body: JSON.stringify({ body: payload.body }) });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const made = await res.json();
    result = made?.html_url || null;
    note = serverText(locale, "proxy.posted", { where: `${payload.repo}#${payload.number}`, url: result || "" }).trim();
  } catch (err) {
    console.error("proxy action failed", safe(err?.message));
    note = serverText(locale, "proxy.postFailed", { where: `${payload.repo}#${payload.number}` });
  }
  await db.prepare("UPDATE proxy_actions SET status = ?3, result = ?4 WHERE id = ?1 AND org_id = ?2")
    .bind(row.id, orgId, result ? "done" : "failed", result).run();
  const out = await postMessage(db, { orgId, key: row.channel, authorLogin: row.agent_login, body: note, kind: "agent", parentId: row.thread_id || null, onBehalfOf: row.login });
  if (out.row) {
    const { broadcastStored } = await import("./channelRoutes.js");
    await broadcastStored(env, orgId, row.channel, out.row).catch(() => {});
  }
  return result;
}

/// What a teammate's answer for a person becomes before it is posted: its
/// proposal taken out and waiting on that person, a line saying so in its
/// place. Used by postTeammateResult when a run works for someone.
export async function proxyTeammateAnswer(env, { orgId, run, body, agentLogin }) {
  const { text, action } = takeAction(body);
  if (!action || !(await workspaceRepos(env, orgId)).has(action.repo.toLowerCase())) return text;
  const owner = await getUserByLogin(env.DB, run.on_behalf_of);
  if (!owner) return text;
  const asker = run.started_by ? await getUserByLogin(env.DB, run.started_by) : null;
  const thread = run.thread_id === "-" ? null : run.thread_id;
  const head = thread ? await getMessage(env.DB, orgId, thread) : null;
  const askedBy = head?.author_login ? await getUserByLogin(env.DB, head.author_login) : asker;
  await proposeAction(env, { orgId, owner, asker: askedBy || owner, action, key: run.channel, threadId: thread, agentLogin });
  const locale = await loadCopy(env, owner.locale || "en", { orgId });
  return `${text}\n\n${serverText(locale, "proxy.waiting", { name: owner.name || owner.login, where: `${action.repo}#${action.number}` })}`;
}

