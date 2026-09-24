// GitHub as a tool any workspace can connect — the way Gmail and Slack are.
//
// A repository workspace ("owner/repo") has always synced decisions to that
// repository's issues, as the deciding person's own GitHub account, from the
// phone. A team made at sign-up had nowhere to open an issue and no token to
// write with, so the Tools screen said "not in this workspace" and stopped.
//
// Now a workspace can name a repository and hold a token that writes to it:
// an admin connects it once — with their own GitHub account, when they signed
// in with one, or with a fine-grained token that has Issues: write — and from
// then on every decision in the workspace becomes an issue there, written by
// the Worker, whoever decided it and whatever they signed in with. The token
// lives in D1 the way connector tokens and the workspace's AI keys do, and it
// never comes back out.

const GH = "https://api.github.com";
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "tiktokforwork",
  "x-github-api-version": "2022-11-28",
});

export async function getWorkspaceGitHub(db, orgId) {
  if (!db || !orgId) return null;
  const row = await db
    .prepare("SELECT repo, token, connected_by, updated_at FROM org_github WHERE org_id = ?1")
    .bind(orgId)
    .first()
    .catch(() => null);
  if (!row?.repo) return null;
  return { repo: row.repo, token: row.token || null, connectedBy: row.connected_by || null, updatedAt: row.updated_at || null };
}

/// Where this workspace's issues go: the repository it is, or the one it
/// named. Null when neither.
export function repoFor(orgId, settings) {
  const id = String(orgId || "");
  if (REPO_SHAPE.test(id)) return id;
  return settings?.repo || null;
}

/// Look at the repository as the token would, and say whether issues can
/// be written there. Anything short of that is refused before it is saved.
export async function checkRepository(env, repo, token) {
  if (!REPO_SHAPE.test(String(repo || ""))) return { error: "Name the repository as owner/repo." };
  if (typeof token !== "string" || token.trim().length < 20 || /\s/.test(token.trim())) {
    return { error: "That does not look like a GitHub token." };
  }
  const base = (env.GITHUB_API_BASE || GH).replace(/\/$/, "");
  let res;
  try {
    res = await fetch(`${base}/repos/${repo}`, { headers: headers(token.trim()), signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { error: `GitHub did not answer: ${err?.message || err}` };
  }
  if (res.status === 401) return { error: "GitHub refused that token." };
  if (res.status === 404) return { error: "That repository is not one this token can see." };
  if (!res.ok) return { error: `GitHub answered ${res.status}.` };
  const data = await res.json().catch(() => ({}));
  const p = data.permissions || {};
  // Pushing, maintaining or administering all include writing issues; so
  // does triage. A read-only token can see the repository and not write it.
  if (!(p.push || p.maintain || p.admin || p.triage)) {
    return { error: "That token can read the repository but not write issues there." };
  }
  return { ok: true, repo: data.full_name || repo, url: data.html_url || `https://github.com/${repo}` };
}

export async function connectWorkspaceGitHub(env, { orgId, repo, token, byGithubId }) {
  const checked = await checkRepository(env, repo, token);
  if (checked.error) return checked;
  await env.DB
    .prepare(
      `INSERT INTO org_github (org_id, repo, token, connected_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(org_id) DO UPDATE SET repo = excluded.repo, token = excluded.token,
         connected_by = excluded.connected_by, updated_at = excluded.updated_at`
    )
    .bind(orgId, checked.repo, token.trim(), String(byGithubId), new Date().toISOString())
    .run();
  return { ok: true, repo: checked.repo, url: checked.url };
}

export async function disconnectWorkspaceGitHub(db, orgId) {
  await db.prepare("DELETE FROM org_github WHERE org_id = ?1").bind(orgId).run();
}

/// What the Tools screen shows. `builtIn` keeps its old meaning — a
/// repository workspace synced by the phone as the person's own account —
/// and `connected` is the new one: the workspace writes issues itself.
export async function githubStatus(env, { session, orgId, canEdit, isGitHubSession }) {
  const settings = await getWorkspaceGitHub(env.DB, orgId);
  const isRepoOrg = REPO_SHAPE.test(String(orgId || ""));
  const base = {
    builtIn: isRepoOrg && isGitHubSession,
    connected: Boolean(settings?.repo),
    repo: settings?.repo || (isRepoOrg ? orgId : null),
    canEdit: Boolean(canEdit),
    // A GitHub sign-in can connect the workspace with one tap; anyone else
    // enters a token.
    mine: Boolean(isGitHubSession),
    reason: null,
  };
  if (settings?.repo) return base;
  if (isRepoOrg) {
    return {
      ...base,
      reason: isGitHubSession ? null : "Decisions sync as your GitHub account. Sign in with GitHub to turn this on.",
    };
  }
  return {
    ...base,
    reason: "Not connected. Name a repository and decisions become issues there.",
  };
}

const TYPE_LABEL = { approval: "Approval", delegation: "Delegation", notification: "Notice", task: "Task", revision: "Revision" };

function issueBody(card) {
  const lines = [];
  if (card.summary) lines.push(card.summary, "");
  if (card.context) lines.push(card.context, "");
  if (card.routingReason) lines.push(`_Why ${card.recipientUserID}: ${card.routingReason}_`, "");
  if (card.decision?.action) {
    lines.push(`**Decision:** ${card.decision.action}${card.decision.actorUserID ? ` by ${card.decision.actorUserID}` : ""}${card.decision.decidedAt ? ` on ${card.decision.decidedAt}` : ""}`);
    if (card.decision.replyText) lines.push("", card.decision.replyText);
  } else {
    lines.push(`**Status:** waiting on ${card.recipientUserID}`);
  }
  lines.push("", "_Opened by Honmaru AI._");
  return lines.join("\n");
}

const issueState = (status) => (status === "completed" || status === "rejected" ? "closed" : "open");

/// Write this card to the workspace's repository: a new issue, or the one it
/// already has brought up to date. Returns the card with its issue fields
/// set, or null when there is nothing to do or GitHub would not have it.
export async function syncCardToGitHub(env, orgId, card) {
  const settings = await getWorkspaceGitHub(env.DB, orgId);
  if (!settings?.repo || !settings.token || !card?.id) return null;
  const base = (env.GITHUB_API_BASE || GH).replace(/\/$/, "");
  const title = `[${TYPE_LABEL[card.type] || "Decision"}] ${card.title || card.id}`;
  const body = issueBody(card);
  try {
    if (card.githubIssueNumber && (!card.githubRepository || card.githubRepository === settings.repo)) {
      const res = await fetch(`${base}/repos/${settings.repo}/issues/${card.githubIssueNumber}`, {
        method: "PATCH",
        headers: { ...headers(settings.token), "content-type": "application/json" },
        body: JSON.stringify({ title, body, state: issueState(card.status) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { console.error(`github issue update ${res.status}`); return null; }
      return { ...card, githubRepository: settings.repo, githubIssueURL: card.githubIssueURL || `https://github.com/${settings.repo}/issues/${card.githubIssueNumber}` };
    }
    const res = await fetch(`${base}/repos/${settings.repo}/issues`, {
      method: "POST",
      headers: { ...headers(settings.token), "content-type": "application/json" },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { console.error(`github issue create ${res.status}`); return null; }
    const data = await res.json().catch(() => ({}));
    if (typeof data.number !== "number") return null;
    const next = { ...card, githubIssueNumber: data.number, githubIssueURL: data.html_url || `https://github.com/${settings.repo}/issues/${data.number}`, githubRepository: settings.repo };
    if (issueState(card.status) === "closed") {
      // Decided before it was ever written: open it and close it in one go.
      await fetch(`${base}/repos/${settings.repo}/issues/${data.number}`, {
        method: "PATCH",
        headers: { ...headers(settings.token), "content-type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {});
    }
    return next;
  } catch (err) {
    console.error("github sync failed", err?.message || err);
    return null;
  }
}
