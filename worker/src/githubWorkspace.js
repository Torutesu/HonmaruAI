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

import { executeTool, createConnectLink, listConnectedAccounts, createManagedAuthConfig } from "./composio.js";

const GH = "https://api.github.com";
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KV_AUTH_CONFIG = "composio_auth_config_github";

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "tiktokforwork",
  "x-github-api-version": "2022-11-28",
});

export async function getWorkspaceGitHub(db, orgId) {
  if (!db || !orgId) return null;
  const row = await db
    .prepare("SELECT repo, token, composio_user, connected_by, updated_at FROM org_github WHERE org_id = ?1")
    .bind(orgId)
    .first()
    .catch(() => null);
  if (!row?.repo) return null;
  return {
    repo: row.repo, token: row.token || null, composioUser: row.composio_user || null,
    connectedBy: row.connected_by || null, updatedAt: row.updated_at || null,
  };
}

// ---------------------------------------------------------------------------
// Signing in with GitHub, from the web, without a token to paste.
//
// GitHub's own OAuth needs a callback URL registered on the OAuth app, and
// the one this deployment registered is the phone's. Composio hosts the
// OAuth for the same tools the Tools screen already connects — Gmail, Slack,
// Notion — and does so for GitHub as well, on its own managed credentials.
// So "connect GitHub" here is the same journey as connecting Gmail: a page
// opens, GitHub asks, the person says yes, they come back. The auth config
// that journey needs is made once, by the Worker, and remembered.

/// The Composio auth config for GitHub: the one the deployment names, the
/// one it made before, or one made now on Composio's managed OAuth.
export async function githubAuthConfig(env) {
  if (!env.COMPOSIO_API_KEY) return null;
  const named = typeof env.CONNECTOR_AUTH_GITHUB === "string" ? env.CONNECTOR_AUTH_GITHUB.trim() : "";
  if (named) return named;
  const kept = await env.DB.prepare("SELECT value FROM kv WHERE key = ?1").bind(KV_AUTH_CONFIG).first().catch(() => null);
  if (kept?.value) return kept.value;
  try {
    const id = await createManagedAuthConfig(env.COMPOSIO_API_KEY, "github", "Honmaru AI · GitHub");
    if (!id) return null;
    await env.DB
      .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(KV_AUTH_CONFIG, id, new Date().toISOString())
      .run();
    return id;
  } catch (err) {
    console.error("github auth config", err?.message || err);
    return null;
  }
}

/// Where to send someone to connect their GitHub.
export async function githubConnectLink(env, githubId) {
  const authConfig = await githubAuthConfig(env);
  if (!authConfig) return { error: "GitHub sign-in is not available on this deployment." };
  const link = await createConnectLink(env.COMPOSIO_API_KEY, String(githubId), authConfig);
  return { redirectUrl: link.redirect_url, connectedAccountId: link.connected_account_id };
}

/// Whether this person's GitHub is connected through Composio.
export async function myGithubAccount(env, githubId) {
  if (!env.COMPOSIO_API_KEY) return null;
  try {
    const accounts = await listConnectedAccounts(env.COMPOSIO_API_KEY, String(githubId));
    return accounts.find((a) => {
      const slug = typeof a.toolkit === "string" ? a.toolkit : a.toolkit?.slug;
      return String(slug).toLowerCase() === "github" && String(a.status).toUpperCase() === "ACTIVE";
    }) || null;
  } catch (err) {
    console.error("github account lookup", err?.message || err);
    return null;
  }
}

const unwrap = (payload) => payload?.data?.data ?? payload?.data ?? payload?.results?.[0]?.response?.data ?? payload;

/// The repositories this person's connected GitHub can write issues to.
export async function listMyRepositories(env, githubId) {
  const payload = await executeTool(env.COMPOSIO_API_KEY, "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", String(githubId), {
    per_page: 100, sort: "updated",
  });
  const data = unwrap(payload);
  const list = Array.isArray(data) ? data : (data?.details || data?.repositories || data?.items || []);
  return list
    .filter((r) => r && r.full_name)
    .filter((r) => { const p = r.permissions || {}; return p.push || p.maintain || p.admin || p.triage || r.permissions === undefined; })
    .map((r) => ({ repo: r.full_name, url: r.html_url || `https://github.com/${r.full_name}`, private: Boolean(r.private) }));
}

async function checkRepositoryAs(env, githubId, repo) {
  if (!REPO_SHAPE.test(String(repo || ""))) return { error: "Name the repository as owner/repo." };
  const [owner, name] = repo.split("/");
  let payload;
  try {
    payload = await executeTool(env.COMPOSIO_API_KEY, "GITHUB_GET_A_REPOSITORY", String(githubId), { owner, repo: name });
  } catch (err) {
    return { error: `GitHub did not answer: ${String(err?.message || err).slice(0, 120)}` };
  }
  const data = unwrap(payload) || {};
  const p = data.permissions || {};
  if (data.permissions && !(p.push || p.maintain || p.admin || p.triage)) {
    return { error: "Your GitHub account can read that repository but not write issues there." };
  }
  return { ok: true, repo: data.full_name || repo, url: data.html_url || `https://github.com/${repo}` };
}

/// Connect the workspace to a repository through a member's connected
/// GitHub: no token stored, the Worker writes issues as that person.
export async function connectWorkspaceGitHubAs(env, { orgId, repo, githubId }) {
  const account = await myGithubAccount(env, githubId);
  if (!account) return { error: "Connect your GitHub first." };
  const checked = await checkRepositoryAs(env, githubId, repo);
  if (checked.error) return checked;
  await env.DB
    .prepare(
      `INSERT INTO org_github (org_id, repo, token, composio_user, connected_by, updated_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5)
       ON CONFLICT(org_id) DO UPDATE SET repo = excluded.repo, token = NULL, composio_user = excluded.composio_user,
         connected_by = excluded.connected_by, updated_at = excluded.updated_at`
    )
    .bind(orgId, checked.repo, String(githubId), String(githubId), new Date().toISOString())
    .run();
  return { ok: true, repo: checked.repo, url: checked.url };
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
      `INSERT INTO org_github (org_id, repo, token, composio_user, connected_by, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5)
       ON CONFLICT(org_id) DO UPDATE SET repo = excluded.repo, token = excluded.token, composio_user = NULL,
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
  const account = session ? await myGithubAccount(env, session.github_id) : null;
  const base = {
    builtIn: isRepoOrg && isGitHubSession,
    connected: Boolean(settings?.repo),
    repo: settings?.repo || (isRepoOrg ? orgId : null),
    via: settings?.composioUser ? "account" : settings?.token ? "token" : null,
    canEdit: Boolean(canEdit),
    // Whether this person can connect the workspace with their own GitHub:
    // through the OAuth journey (Composio) or a GitHub sign-in.
    mine: Boolean(account) || Boolean(isGitHubSession),
    // Whether the OAuth journey is offered here at all.
    oauth: Boolean(env.COMPOSIO_API_KEY),
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
  if (!settings?.repo || !card?.id) return null;
  const title = `[${TYPE_LABEL[card.type] || "Decision"}] ${card.title || card.id}`;
  const body = issueBody(card);
  if (settings.composioUser && env.COMPOSIO_API_KEY) return syncThroughAccount(env, settings, card, title, body);
  if (!settings.token) return null;
  const base = (env.GITHUB_API_BASE || GH).replace(/\/$/, "");
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

/// The same write, as the member whose GitHub is connected.
async function syncThroughAccount(env, settings, card, title, body) {
  const [owner, repo] = settings.repo.split("/");
  const user = String(settings.composioUser);
  try {
    if (card.githubIssueNumber && (!card.githubRepository || card.githubRepository === settings.repo)) {
      await executeTool(env.COMPOSIO_API_KEY, "GITHUB_UPDATE_AN_ISSUE", user, {
        owner, repo, issue_number: card.githubIssueNumber, title, body, state: issueState(card.status),
      });
      return { ...card, githubRepository: settings.repo, githubIssueURL: card.githubIssueURL || `https://github.com/${settings.repo}/issues/${card.githubIssueNumber}` };
    }
    const payload = await executeTool(env.COMPOSIO_API_KEY, "GITHUB_CREATE_AN_ISSUE", user, { owner, repo, title, body });
    const data = unwrap(payload) || {};
    if (typeof data.number !== "number") return null;
    const next = { ...card, githubIssueNumber: data.number, githubIssueURL: data.html_url || `https://github.com/${settings.repo}/issues/${data.number}`, githubRepository: settings.repo };
    if (issueState(card.status) === "closed") {
      await executeTool(env.COMPOSIO_API_KEY, "GITHUB_UPDATE_AN_ISSUE", user, { owner, repo, issue_number: data.number, state: "closed" }).catch(() => {});
    }
    return next;
  } catch (err) {
    console.error("github sync (account) failed", err?.message || err);
    return null;
  }
}
