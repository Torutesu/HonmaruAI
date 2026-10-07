/// Work posted in a channel, started on its own.
///
/// A GitHub issue link pasted into a channel, or a bug report or feature
/// request written there, used to wait for somebody to copy it into Claude
/// and ask for it to be built. Now the workspace's Claude teammate starts on
/// it the moment it is posted, in the message's thread, and posts the pull
/// request there when it is done. An admin can turn it off (the teammate's
/// "Start on issues and reports posted in channels").
///
/// Each issue is started once per workspace, however often it is linked;
/// a report once. A message that is already somebody's to answer — one that
/// calls an agent or @AI, asks for a decision or names a person — is left
/// to them.

import { loadTeammate, canSignIn, startTeammateRun } from "./teammates.js";
import { workspaceRepos } from "./proxy.js";
import { postMessage, MAX_MESSAGE_CHARS } from "./channels.js";
import { contextFor } from "./customAgents.js";
import { providerFor } from "./orgAI.js";
import { allowanceFor } from "./gate.js";
import { settleUsage, noteUsage } from "./ledger.js";
import { serverText } from "./serverCopy.js";
import { safe } from "./log.js";

const TEAMMATE = "claude";
/// How many issues one message may start.
const MAX_ISSUES = 3;
const ISSUE_URL = /https?:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/gi;

/// The issues a message links to, in the workspace's own repositories:
/// another repository's issue is not this team's work to start.
export function issueLinks(body, repos) {
  const out = [];
  const seen = new Set();
  for (const m of String(body || "").matchAll(ISSUE_URL)) {
    const repo = m[1].replace(/\.git$/, "");
    const number = Number(m[2]);
    const key = `${repo.toLowerCase()}#${number}`;
    if (!repos.has(repo.toLowerCase()) || !(number > 0) || seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, number, url: `https://github.com/${repo}/issues/${number}`, key });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/// Words that a report of something broken, or a request for something
/// new, nearly always has. Only a message with one is shown to the model,
/// so the chat's every "thanks" costs nothing.
const REPORT_WORDS = /\b(bugs?|crash(es|ed)?|broken|errors?|regression|fails?|failing|doesn'?t work|not working|stuck|freezes?|feature request|can'?t|cannot|should be able|please (add|fix|support))\b|\[(bug|feature|ux|performance|perf)\]|不具合|バグ|エラー|動かない|表示されない|できない|落ちる|固まる|直して|修正して|おかしい|要望|機能追加|ほしい|欲しい|してほしい|改善して/i;
export const looksLikeReport = (body) => String(body || "").trim().length >= 20 && REPORT_WORDS.test(String(body || ""));

/// Whether a message is a report concrete enough to build from: something
/// broken in the product, or something it should do. Not a question, not
/// news, not a complaint about something outside the code.
export async function classifyReport(provider, { body, transcript = [] }) {
  if (!provider) return { build: false, called: false };
  const system = `A message was posted in a software team's chat. The team's AI engineer can change the team's code. Decide whether the message reports a bug in the team's product or asks for a feature or change to it, concretely enough that an engineer could start on it now.
Reply with JSON only: {"build":true} or {"build":false}.
- true: a bug report (what is wrong, where), a feature or UX request, a performance problem in the product.
- false: a question, news or FYI, thanks, chat, a problem outside the product's code (an outage elsewhere, a billing question), or something too vague to act on.`;
  const user = `${transcript.length ? `Earlier:\n${transcript.slice(-6).join("\n").slice(-2000)}\n\n` : ""}The message: ${String(body).slice(0, 3000)}`;
  try {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: provider.model, temperature: 0, max_tokens: 12, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) return { build: false, called: false };
    const data = await res.json();
    noteUsage(provider, "autobuild", data);
    return { build: /"build"\s*:\s*true/.test(String(data?.choices?.[0]?.message?.content || "")), called: true };
  } catch {
    return { build: false, called: false };
  }
}

/// What Claude is asked to do.
export function buildRequest({ issues, body, author }) {
  if (issues.length) {
    const list = issues.map((i) => `- ${i.repo}#${i.number}: ${i.url}`).join("\n");
    return `${author} posted ${issues.length === 1 ? "this GitHub issue" : "these GitHub issues"} in the channel. Implement ${issues.length === 1 ? "it" : "them"}:
${list}

Read each issue and its comments on GitHub first; they are the specification. Make the change on a new branch, run the repository's tests and checks, and open a pull request whose description says "Fixes #<number>" for each issue it closes. Then reply here with the pull request's link and a few lines on what changed. If an issue is unclear or not something to build, say so here instead of guessing.

What ${author} wrote: ${body}`;
  }
  return `${author} reported this in the channel, and it looks like work for the code:
${body}

Find the cause (or where the change belongs) in the team's repositories, fix or build it on a new branch, run the tests and checks, and open a pull request that says what it fixes. Then reply here with the pull request's link and a few lines on what changed. If it is not clear enough to act on, ask one short question here instead of guessing.`;
}

/// Kept once: false when it was started before.
async function claim(db, orgId, key, messageId) {
  const res = await db.prepare("INSERT OR IGNORE INTO auto_builds (org_id, key, message_id, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(orgId, key, messageId, new Date().toISOString()).run();
  return Boolean(res?.meta?.changes);
}
async function release(db, orgId, keys) {
  for (const key of keys) await db.prepare("DELETE FROM auto_builds WHERE org_id = ?1 AND key = ?2").bind(orgId, key).run().catch(() => {});
}

/// After a person's message in a channel: start Claude on it, when it is
/// an issue of the workspace's or a report to build from. Returns what was
/// done, for tests.
export async function autoBuild(env, { orgId, resolved, row, user, members, locale, skip = false, deadline = 0 }) {
  if (skip || !row || row.kind !== "message" || !row.author_login || String(row.author_login).startsWith("agent:")) return { started: false, why: "not-a-post" };
  if (resolved.kind !== "business" && resolved.kind !== "group") return { started: false, why: "not-a-channel" };
  // A reply in a thread is part of a conversation already under way.
  if (row.parent_id) return { started: false, why: "reply" };
  const db = env.DB;
  const t = await loadTeammate(db, orgId, TEAMMATE).catch(() => null);
  if (!t?.enabled || !t.agentId || !canSignIn(t) || t.autoBuild === false) return { started: false, why: "off" };
  if (t.channels && resolved.key.startsWith("b:") && !t.channels.includes(resolved.key)) return { started: false, why: "not-here" };

  const author = user?.name || user?.login || row.author_login;
  const issues = issueLinks(row.body, await workspaceRepos(env, orgId));
  let keys;
  if (issues.length) {
    keys = [];
    for (const i of issues) if (await claim(db, orgId, `issue:${i.key}`, row.id)) keys.push(`issue:${i.key}`);
    if (!keys.length) return { started: false, why: "already" };
    // Only the ones not started before.
    issues.splice(0, issues.length, ...issues.filter((i) => keys.includes(`issue:${i.key}`)));
  } else {
    if (!looksLikeReport(row.body)) return { started: false, why: "not-a-report" };
    const provider = await providerFor(env, orgId);
    const allowance = provider ? await allowanceFor(env, orgId, { githubId: String(user?.github_id || "") }) : null;
    if (!provider || !allowance?.allowed) return { started: false, why: "no-model" };
    const transcript = await contextFor(db, orgId, row.channel, row).catch(() => []);
    const decided = await classifyReport(provider, { body: row.body, transcript });
    if (decided.called && allowance.metered) await allowance.consume();
    await settleUsage(db, provider, { orgId, githubId: user?.github_id }).catch(() => {});
    if (!decided.build) return { started: false, why: "not-a-report" };
    if (!(await claim(db, orgId, `message:${row.id}`, row.id))) return { started: false, why: "already" };
    keys = [`message:${row.id}`];
  }

  const { broadcastWithParent, watchTeammateRuns } = await import("./channelRoutes.js");
  const say = async (body) => {
    const out = await postMessage(db, { orgId, key: resolved.key, authorLogin: `agent:${t.agentId}`, body: String(body).slice(0, MAX_MESSAGE_CHARS), kind: "agent", parentId: row.id });
    if (out.row) await broadcastWithParent(env, orgId, resolved, out.row, members);
  };
  let started;
  try {
    started = await startTeammateRun(env, {
      orgId, t, key: resolved.key, threadId: row.id,
      where: resolved.kind === "business" ? `the #${resolved.slug} channel` : "a group conversation",
      askedBy: author, transcript: [], request: buildRequest({ issues, body: row.body, author }), login: row.author_login,
    });
  } catch (err) {
    console.error("auto-build start failed", safe(err?.message));
    await release(db, orgId, keys);
    return { started: false, why: "failed" };
  }
  if (started.refused) {
    // Not started: another post may try again later.
    await release(db, orgId, keys);
    if (started.refused !== "notHere") await say(serverText(locale, started.refused === "limit" ? "teammate.limit" : "teammate.busy"));
    return { started: false, why: started.refused };
  }
  for (const key of keys) {
    await db.prepare("UPDATE auto_builds SET run_id = ?3 WHERE org_id = ?1 AND key = ?2").bind(orgId, key, started.run.id).run().catch(() => {});
  }
  await say(issues.length
    ? serverText(locale, "autobuild.issue", { issues: issues.map((i) => `${i.repo}#${i.number}`).join(", ") })
    : serverText(locale, "autobuild.report"));
  if (deadline) await watchTeammateRuns(env, { ids: [started.run.id], deadline });
  return { started: true, run: started.run.id, issues: issues.map((i) => i.key) };
}
