import Anthropic from "@anthropic-ai/sdk";
import { handleTaken } from "./customAgents.js";
import { aad, openField, sealField } from "./secrets.js";

// AI teammates: coding agents working in the workspace's channels the way
// Claude Tag works in Slack. An admin sets one up once, with an API key from
// an account made for it; anyone then writes "@claude" (or "@devin",
// "@cursor", "@codex") in a channel and it takes the thread as its task, works in a
// sandbox of its own on the team's repositories, and answers in the thread.
// Each is billed by its own company, to the workspace's own account; what it
// uses is counted here and capped by the month.
//
// Each service has an adapter below: how a key is checked (and, for Claude,
// what is made on Anthropic's side), how work starts, how a follow-up is
// handed on, and how a look at it reads. Everything else — setup, channels,
// the monthly limit, the runs and their posting — is shared.

export const PROVIDERS = {
  claude: {
    name: "Claude", handle: "claude", emoji: "✳️", company: "Anthropic",
    keyHint: "sk-ant-…", keySource: "the Claude Console",
    models: ["claude-opus-5-5", "claude-sonnet-5-5"], defaultModel: "claude-opus-5-5",
    // Its use in dollars (cents here); a task is not started with less than 50¢ left.
    unit: "usd", minLeft: 50, defaultLimit: 50000,
    githubToken: true, tools: true,
  },
  devin: {
    name: "Devin", handle: "devin", emoji: "🧑‍💻", company: "Devin",
    keyHint: "cog_…", keySource: "Devin's settings (a service user)",
    models: [], defaultModel: null,
    // Devin bills in ACUs (hundredths here); a task needs at least one.
    unit: "acu", minLeft: 100, defaultLimit: 10000,
    account: true,
  },
  cursor: {
    name: "Cursor", handle: "cursor", emoji: "🖱️", company: "Cursor",
    keyHint: "", keySource: "the Cursor dashboard",
    models: [], defaultModel: null, freeModel: true,
    // Cursor reports tokens, not money: its limit is a number of tasks.
    unit: "task", minLeft: 100, defaultLimit: 20000,
    reposRequired: true,
  },
  codex: {
    name: "Codex", handle: "codex", emoji: "🧩", company: "OpenAI",
    keyHint: "", keySource: "",
    models: [], defaultModel: null,
    // Codex runs on the team's ChatGPT plan; what is counted here is tasks.
    unit: "task", minLeft: 100, defaultLimit: 20000,
    // No key of its own: it is reached through GitHub, with a token that
    // may push to the repository Codex is connected to.
    keyless: true, githubToken: true, reposRequired: true,
  },
};

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const HOST = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCOUNT = /^[A-Za-z0-9_-]{3,80}$/;
const MODEL = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_TOOLS = 20;
const MAX_REPOS = 10;
/// A run that has said nothing for this long is given up on.
const STALE_MS = 6 * 60 * 60 * 1000;

const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

export async function loadTeammate(db, orgId, provider) {
  const row = await db.prepare("SELECT * FROM ai_teammates WHERE org_id = ?1 AND provider = ?2").bind(orgId, provider).first().catch(() => null);
  if (!row) return null;
  return {
    orgId: row.org_id, provider: row.provider, enabled: Boolean(row.enabled),
    apiKey: (await openField(row.api_key, aad.teammate(orgId, provider, "api_key"))) || null,
    githubToken: (await openField(row.github_token, aad.teammate(orgId, provider, "github_token"))) || null,
    repos: parse(row.repos, []), model: row.model || PROVIDERS[provider]?.defaultModel || null,
    instructions: row.instructions || "", channels: parse(row.channels, null),
    monthlyLimitCents: row.monthly_limit_cents == null ? null : Number(row.monthly_limit_cents),
    tools: parse(row.tools, []), remote: parse(row.remote, {}), agentId: row.agent_id || null,
    autoBuild: row.auto_build == null ? true : Boolean(row.auto_build),
    updatedBy: row.updated_by || null, updatedAt: row.updated_at || null,
  };
}

/// Whether it has what it signs in with: its key, or for Codex, GitHub's.
export const canSignIn = (t) => Boolean(t && (PROVIDERS[t.provider]?.keyless ? t.githubToken : t.apiKey));

/// What it has used this month (UTC), in hundredths of its unit: every run's.
export async function spentThisMonth(db, orgId, provider, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const row = await db.prepare("SELECT COALESCE(SUM(cost_cents), 0) AS c FROM ai_teammate_runs WHERE org_id = ?1 AND provider = ?2 AND created_at >= ?3")
    .bind(orgId, provider, start).first().catch(() => null);
  return Number(row?.c || 0);
}

/// A teammate as the setup screen sees it: never a key, only whether one is set.
export function toClientTeammate(t, provider, spentCents = 0) {
  const p = PROVIDERS[provider];
  return {
    provider, name: p.name, handle: p.handle, emoji: p.emoji, company: p.company, keyHint: p.keyHint, keySource: p.keySource,
    models: p.models, freeModel: Boolean(p.freeModel), unit: p.unit,
    needs: { apiKey: !p.keyless, githubToken: Boolean(p.githubToken), tools: Boolean(p.tools), account: Boolean(p.account), repos: Boolean(p.reposRequired) },
    hasKey: Boolean(p.keyless ? t?.githubToken : t?.apiKey),
    enabled: Boolean(t?.enabled), hasApiKey: Boolean(t?.apiKey), hasGithubToken: Boolean(t?.githubToken),
    account: t?.remote?.account || "",
    repos: t?.repos || [], model: t?.model || p.defaultModel || "", instructions: t?.instructions || "",
    channels: t?.channels ?? null,
    autoBuild: t ? t.autoBuild !== false : true,
    monthlyLimit: t ? (t.monthlyLimitCents == null ? null : t.monthlyLimitCents / 100) : p.defaultLimit / 100,
    spentThisMonth: spentCents / 100,
    tools: (t?.tools || []).map((x) => ({ name: x.name, secretName: x.secretName, host: x.host })),
    ready: Boolean(t?.enabled && t?.agentId),
    updatedAt: t?.updatedAt || null,
  };
}

/// What the admin sent, checked; secrets passed through untouched.
function cleanInput(input, current, provider) {
  const p = PROVIDERS[provider];
  const out = {};
  if (!p.keyless && typeof input.apiKey === "string") out.apiKey = input.apiKey.trim() || null;
  if (p.githubToken && typeof input.githubToken === "string") out.githubToken = input.githubToken.trim() || null;
  if (p.account && typeof input.account === "string") {
    const account = input.account.trim();
    if (account && !ACCOUNT.test(account)) return { error: `That does not look like a ${p.company} organization ID.` };
    out.account = account || null;
  }
  if (input.model !== undefined && input.model !== null) {
    if (p.freeModel) {
      const model = String(input.model).trim();
      if (model && !MODEL.test(model)) return { error: "Write a model's ID, or leave it blank for the default." };
      out.model = model || null;
    } else if (p.models.length) {
      if (!p.models.includes(input.model)) return { error: "Pick one of the models offered." };
      out.model = input.model;
    }
  }
  if (typeof input.instructions === "string") out.instructions = input.instructions.slice(0, 8000);
  if (input.repos !== undefined) {
    if (!Array.isArray(input.repos) || input.repos.length > MAX_REPOS) return { error: `Up to ${MAX_REPOS} repositories.` };
    const repos = [...new Set(input.repos.map((r) => String(r).trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")).filter(Boolean))];
    if (repos.some((r) => !REPO.test(r))) return { error: "Write each repository as owner/name." };
    out.repos = repos;
  }
  if (input.channels !== undefined) {
    if (input.channels === null) out.channels = null;
    else if (Array.isArray(input.channels)) out.channels = [...new Set(input.channels.map(String).filter((c) => /^[bg]:/.test(c)))].slice(0, 200);
    else return { error: "Channels are a list, or everywhere." };
  }
  // The limit, in the teammate's own unit (dollars, ACUs or tasks).
  const limit = input.monthlyLimit !== undefined ? input.monthlyLimit : input.monthlyLimitUsd;
  if (limit !== undefined) {
    if (limit === null) out.monthlyLimitCents = null;
    else {
      const n = Number(limit);
      if (!Number.isFinite(n) || n < 1 || n > 1000000) return { error: "A monthly limit is between 1 and 1,000,000, or none." };
      out.monthlyLimitCents = Math.round(n * 100);
    }
  }
  if (p.tools && input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length > MAX_TOOLS) return { error: `Up to ${MAX_TOOLS} tools.` };
    const tools = [];
    for (const t of input.tools) {
      const name = String(t?.name || "").trim().slice(0, 60);
      const secretName = String(t?.secretName || "").trim().toUpperCase();
      const host = String(t?.host || "").trim().toLowerCase();
      if (!name || !ENV_NAME.test(secretName) || !HOST.test(host)) return { error: "Each tool needs a name, a variable name like LINEAR_API_KEY and the host it is sent to, like api.linear.app." };
      const before = (current?.tools || []).find((x) => x.secretName === secretName);
      const secretValue = typeof t.secretValue === "string" && t.secretValue.trim() ? t.secretValue.trim() : null;
      if (!before && !secretValue) return { error: `Paste the key for ${name}.` };
      tools.push({ name, secretName, host, secretValue, credentialId: before?.credentialId || null, before });
    }
    if (new Set(tools.map((t) => t.secretName)).size !== tools.length) return { error: "Each tool needs its own variable name." };
    out.tools = tools;
  }
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
  if (input.autoBuild !== undefined) out.autoBuild = Boolean(input.autoBuild);
  return { out };
}

/// What the thread says, for new work: where, who asked, what came before.
function taskText({ where, askedBy, transcript, request }) {
  return [
    `Where: ${where}`,
    `Asked by: ${askedBy}`,
    transcript.length ? `The conversation so far:\n${transcript.join("\n")}` : "",
    `The request:\n${request}`,
  ].filter(Boolean).join("\n\n");
}

/// A service that is not Claude has no system prompt of ours: what it needs
/// to know about HonmaruAI comes first in the task itself.
function briefing(t) {
  const repos = (t.repos || []).length ? `The team's repositories: ${t.repos.join(", ")}.` : "";
  return [
    `You were handed this in HonmaruAI, a team chat; your final reply is posted into the thread it came from. Do the work, then say briefly what you did or found, and link any pull request you opened. Write in the language the request was written in, in plain chat text. Never push to a default branch.`,
    repos,
    t.instructions ? `The workspace's own instructions:\n${t.instructions}` : "",
  ].filter(Boolean).join("\n\n");
}

/// A service answered with an error: its status, and what it said.
class ServiceError extends Error {
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}

async function call(url, { key, method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.detail?.message || data?.message || data?.error?.message || (typeof data?.detail === "string" ? data.detail : null) || `HTTP ${res.status}`;
    throw new ServiceError(res.status, String(message), data?.code || data?.error?.code || data?.error || null);
  }
  return data;
}

// ---- Claude: Anthropic's Managed Agents -----------------------------------
// One agent, one environment and one vault per workspace, made at launch;
// one session per thread. Tools' keys live in the vault.

const anthropic = (apiKey) => new Anthropic({ apiKey, maxRetries: 1 });

function systemPrompt(t, workspaceName) {
  const tools = (t.tools || []).map((x) => `- ${x.name}: $${x.secretName} (for ${x.host})`).join("\n");
  const repos = (t.repos || []).map((r) => `- ${r} at /workspace/${r.split("/")[1]}`).join("\n");
  return [
    `You are Claude, a teammate in the "${workspaceName}" workspace of HonmaruAI, a team chat. People write @claude in a channel or a thread to hand you work, and what you write back is posted into that thread.`,
    "You work in a sandbox of your own. Do the work, then answer: say briefly what you did or found, and link anything you made. Write in the language the request was written in, in plain chat text: short paragraphs or a few bullets, no headings.",
    repos ? `The team's repositories are cloned here:\n${repos}\nFor a code change, work on a new branch, push it, and open a pull request with the GitHub REST API; git and GitHub API calls to these repositories are already authorised. Never push to the default branch.` : "No repository is attached. If a request needs code, say that an admin can grant one in HonmaruAI's Studio.",
    tools ? `These team tools are reachable with the keys in these environment variables (the values are placeholders the network fills in; never print or share them):\n${tools}` : "",
    "Ask one short question instead of guessing when the request is unclear.",
    t.instructions ? `The workspace's own instructions:\n${t.instructions}` : "",
  ].filter(Boolean).join("\n\n");
}

const textOf = (event) => (event.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

const claude = {
  /// The agent, environment and vault behind it, made or brought up to date;
  /// the tools' keys moved into the vault. Keys never stay here.
  async provision(t, { workspaceName, toolChanges }) {
    const api = anthropic(t.apiKey);
    const remote = { ...(t.remote || {}) };
    if (!remote.environmentId) {
      const env = await api.beta.environments.create({ name: `honmaru-${t.orgId}`.slice(0, 60), config: { type: "cloud", networking: { type: "unrestricted" } } });
      remote.environmentId = env.id;
    }
    if (!remote.vaultId) {
      const vault = await api.beta.vaults.create({ display_name: `HonmaruAI ${workspaceName}`.slice(0, 255), metadata: { org: String(t.orgId).slice(0, 512) } });
      remote.vaultId = vault.id;
    }
    const tools = [];
    for (const tool of toolChanges.kept) tools.push(tool);
    for (const tool of toolChanges.removed) {
      if (tool.credentialId) await api.beta.vaults.credentials.delete(tool.credentialId, { vault_id: remote.vaultId }).catch(() => {});
    }
    for (const tool of toolChanges.written) {
      if (tool.credentialId) await api.beta.vaults.credentials.delete(tool.credentialId, { vault_id: remote.vaultId }).catch(() => {});
      const cred = await api.beta.vaults.credentials.create(remote.vaultId, {
        display_name: tool.name,
        auth: {
          type: "environment_variable", secret_name: tool.secretName, secret_value: tool.secretValue,
          networking: { type: "limited", allowed_hosts: [tool.host] }, injection_location: { header: true },
        },
      });
      tools.push({ name: tool.name, secretName: tool.secretName, host: tool.host, credentialId: cred.id });
    }
    const config = {
      name: `Claude · ${workspaceName}`.slice(0, 100),
      model: t.model,
      system: systemPrompt({ ...t, tools }, workspaceName),
      tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
    };
    if (remote.agentId) {
      const agent = await api.beta.agents.update(remote.agentId, config);
      remote.agentVersion = agent.version;
    } else {
      const agent = await api.beta.agents.create(config);
      remote.agentId = agent.id;
      remote.agentVersion = agent.version;
    }
    return { remote, tools };
  },
  async start(t, { task, title, remaining, orgId, key, threadId }) {
    const resources = (t.repos || []).map((r) => ({ type: "github_repository", url: `https://github.com/${r}`, authorization_token: t.githubToken || undefined }));
    const session = await anthropic(t.apiKey).beta.sessions.create({
      agent: t.remote.agentId,
      environment_id: t.remote.environmentId,
      ...(t.remote.vaultId ? { vault_ids: [t.remote.vaultId] } : {}),
      ...(resources.length ? { resources } : {}),
      ...(remaining != null ? { budget: { type: "limit", max_list_cost: { amount: String(Math.max(1, remaining)), currency: "USD" } } } : {}),
      title,
      metadata: { org: String(orgId).slice(0, 512), channel: key.slice(0, 512), thread: String(threadId) },
      initial_events: [{ type: "user.message", content: [{ type: "text", text: task }] }],
    });
    return { remoteId: session.id };
  },
  async send(t, run, text) {
    await anthropic(t.apiKey).beta.sessions.events.send(run.remote_id, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
    return {};
  },
  /// The agent's words since the last hand-off, and whether it has stopped.
  async read(t, run) {
    const api = anthropic(t.apiKey);
    const query = { order: "asc", limit: 200, ...(run.last_event_at ? { "created_at[gt]": run.last_event_at } : {}) };
    const texts = [];
    let stop = null;
    let last = run.last_event_at;
    let error = null;
    for await (const event of api.beta.sessions.events.list(run.remote_id, query)) {
      last = event.processed_at || last;
      if (event.type === "agent.message") { const text = textOf(event); if (text) texts.push(text); }
      else if (event.type === "user.message") texts.length = 0;
      else if (event.type === "session.error") error = event.error?.message || event.error?.type || "error";
      else if (event.type === "session.status_idle") stop = event.stop_reason?.type || "end_turn";
      else if (event.type === "session.status_terminated") stop = "terminated";
      else if (event.type === "session.status_running") stop = null;
    }
    let costCents = null;
    if (stop) {
      const session = await api.beta.sessions.retrieve(run.remote_id).catch(() => null);
      const amount = Number(session?.usage?.list_cost?.amount);
      if (Number.isFinite(amount)) costCents = amount;
    }
    return { texts, stop, last, error, costCents };
  },
};

// ---- Devin: Cognition's v3 API ----------------------------------------------
// A session per thread in the workspace's Devin organization, capped in ACUs;
// its messages read by cursor.

const DEVIN = "https://api.devin.ai/v3/organizations";
/// Why Devin stopped when it ran out of what it may use.
const DEVIN_BUDGET = new Set(["usage_limit_exceeded", "out_of_credits", "out_of_quota", "no_quota_allocation", "payment_declined", "org_usage_limit_exceeded", "user_usage_limit_exceeded", "total_session_limit_exceeded", "contract_expired"]);

const devin = {
  async provision(t) {
    const account = t.remote?.account;
    if (!account) throw new ServiceError(400, "Add your Devin organization ID (org-…).", "account");
    await call(`${DEVIN}/${encodeURIComponent(account)}/sessions?first=1`, { key: t.apiKey });
    return { remote: { account }, tools: [] };
  },
  async start(t, { task, title, remaining }) {
    const session = await call(`${DEVIN}/${encodeURIComponent(t.remote.account)}/sessions`, {
      key: t.apiKey, method: "POST",
      body: {
        prompt: `${briefing(t)}\n\n${task}`, title, tags: ["honmaruai"],
        ...((t.repos || []).length ? { repos: t.repos } : {}),
        ...(remaining != null ? { max_acu_limit: Math.max(1, Math.floor(remaining / 100)) } : {}),
      },
    });
    return { remoteId: session.session_id };
  },
  async send(t, run, text) {
    await call(`${DEVIN}/${encodeURIComponent(t.remote.account)}/sessions/${encodeURIComponent(run.remote_id)}/messages`, { key: t.apiKey, method: "POST", body: { message: text } });
    return {};
  },
  async read(t, run) {
    const base = `${DEVIN}/${encodeURIComponent(t.remote.account)}/sessions/${encodeURIComponent(run.remote_id)}`;
    const texts = [];
    let answered = false;
    let cursor = run.last_event_at || null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ first: "200", ...(cursor ? { after: cursor } : {}) });
      const data = await call(`${base}/messages?${q}`, { key: t.apiKey });
      for (const m of data?.items || []) {
        if (m.source === "user") { texts.length = 0; answered = false; }
        else if (m.source === "devin" && String(m.message || "").trim()) { texts.push(String(m.message).trim()); answered = true; }
      }
      if (data?.end_cursor) cursor = data.end_cursor;
      if (!data?.has_next_page) break;
    }
    const session = await call(base, { key: t.apiKey });
    const detail = session?.status_detail || null;
    let stop = null;
    if (session?.status === "error" || detail === "error") stop = "terminated";
    else if (DEVIN_BUDGET.has(detail)) stop = "budget_reached";
    else if (session?.status === "exit") stop = "end_turn";
    // Waiting on someone, or done — once it has answered what it was last
    // handed; just after a hand-off it may still read as waiting.
    else if (answered && (detail === "waiting_for_user" || detail === "finished" || detail === "inactivity" || session?.status === "suspended")) stop = "end_turn";
    if (stop) {
      const said = texts.join("\n");
      for (const pr of session?.pull_requests || []) if (pr?.pr_url && !said.includes(pr.pr_url)) texts.push(pr.pr_url);
    }
    const acus = Number(session?.acus_consumed);
    return { texts, stop, last: cursor, error: null, costCents: stop && Number.isFinite(acus) ? Math.round(acus * 100) : null };
  },
};

// ---- Cursor: Cloud Agents v1 ------------------------------------------------
// An agent per thread on the team's repositories, a run per hand-off; each
// run is a task toward the month's limit.

const CURSOR = "https://api.cursor.com/v1";

const cursor = {
  async provision(t) {
    if (!(t.repos || []).length) throw new ServiceError(400, "Add at least one repository for Cursor to work in.", "repos");
    await call(`${CURSOR}/me`, { key: t.apiKey });
    return { remote: {}, tools: [] };
  },
  async start(t, { task, title }) {
    const made = await call(`${CURSOR}/agents`, {
      key: t.apiKey, method: "POST",
      body: {
        prompt: { text: `${briefing(t)}\n\n${task}` }, name: title.slice(0, 100),
        repos: (t.repos || []).map((r) => ({ url: `https://github.com/${r}` })),
        autoCreatePR: true,
        ...(t.model ? { model: { id: t.model } } : {}),
      },
    });
    return { remoteId: made.agent.id, turn: made.run?.id || made.agent.latestRunId || null, tasks: 1 };
  },
  async send(t, run, text) {
    try {
      const made = await call(`${CURSOR}/agents/${encodeURIComponent(run.remote_id)}/runs`, { key: t.apiKey, method: "POST", body: { prompt: { text } } });
      return { turn: made.run?.id || null, tasks: 1 };
    } catch (err) {
      if (err?.status === 409) return { busy: true };
      throw err;
    }
  },
  async read(t, run) {
    if (!run.remote_turn) return { texts: [], stop: "terminated", last: null, error: "no run", costCents: null };
    const got = await call(`${CURSOR}/agents/${encodeURIComponent(run.remote_id)}/runs/${encodeURIComponent(run.remote_turn)}`, { key: t.apiKey });
    let stop = null;
    if (got?.status === "FINISHED") stop = "end_turn";
    else if (got?.status === "ERROR" || got?.status === "CANCELLED" || got?.status === "EXPIRED") stop = "terminated";
    const texts = [];
    if (stop) {
      if (got.result && String(got.result).trim()) texts.push(String(got.result).trim());
      const said = texts.join("\n");
      for (const b of got?.git?.branches || []) if (b?.prUrl && !said.includes(b.prUrl)) texts.push(b.prUrl);
    }
    return { texts, stop, last: null, error: got?.status === "ERROR" ? "error" : null, costCents: null };
  },
};


// ---- Codex: through GitHub -------------------------------------------------
// Codex has no API of its own to hand work to; it answers "@codex" in a pull
// request's comments. So each thread gets a draft pull request of its own in
// the team's repository (an empty commit on a codex/ branch), the task goes
// in as an "@codex" comment, and Codex's replies there come back into the
// thread. A follow-up is another "@codex" comment on the same pull request.

const GITHUB = "https://api.github.com";

async function gh(t, path, { method = "GET", body } = {}) {
  const res = await fetch(`${GITHUB}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.githubToken}`, accept: "application/vnd.github+json", "user-agent": "HonmaruAI",
      "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ServiceError(res.status, String(data?.message || `HTTP ${res.status}`));
  return data;
}

const codexRepo = (t) => t.repos[0];
const codexPr = (run) => { const m = String(run.remote_id).match(/^(.+)#(\d+)$/); return m ? { repo: m[1], number: Number(m[2]) } : null; };
const mention = (text) => `@codex ${text}`;

const codex = {
  async provision(t) {
    if (!(t.repos || []).length) throw new ServiceError(400, "Add the repository Codex works in.", "repos");
    try {
      const me = await gh(t, "/user");
      const repo = await gh(t, `/repos/${codexRepo(t)}`);
      if (repo?.permissions && !repo.permissions.push) throw new ServiceError(400, `That GitHub token cannot push to ${codexRepo(t)}.`);
      return { remote: { login: me?.login || null, defaultBranch: repo?.default_branch || "main" }, tools: [] };
    } catch (err) {
      if (err?.status === 401) throw new ServiceError(400, "GitHub did not accept that token.");
      if (err?.status === 403 || err?.status === 404) throw new ServiceError(400, `That GitHub token cannot reach ${codexRepo(t)}.`);
      throw err;
    }
  },
  async start(t, { task, title }) {
    const repo = codexRepo(t);
    const base = t.remote?.defaultBranch || (await gh(t, `/repos/${repo}`)).default_branch;
    const head = await gh(t, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    const parent = await gh(t, `/repos/${repo}/git/commits/${head.object.sha}`);
    const commit = await gh(t, `/repos/${repo}/git/commits`, { method: "POST", body: { message: `Codex task: ${title}`.slice(0, 200), tree: parent.tree.sha, parents: [head.object.sha] } });
    const branch = `codex/honmaru-${crypto.randomUUID().slice(0, 8)}`;
    await gh(t, `/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
    const pr = { title: `Codex: ${title}`.slice(0, 250), head: branch, base, body: `Asked from HonmaruAI. Codex works here; its replies go back to the thread.\n\n${task}`.slice(0, 60000) };
    let made;
    try {
      made = await gh(t, `/repos/${repo}/pulls`, { method: "POST", body: { ...pr, draft: true } });
    } catch (err) {
      // Draft pull requests are not on every plan: an ordinary one, then.
      if (err?.status !== 422) throw err;
      made = await gh(t, `/repos/${repo}/pulls`, { method: "POST", body: pr });
    }
    const said = await gh(t, `/repos/${repo}/issues/${made.number}/comments`, { method: "POST", body: { body: mention(`${briefing(t)}\n\n${task}`).slice(0, 60000) } });
    return { remoteId: `${repo}#${made.number}`, turn: String(said.id), tasks: 1 };
  },
  async send(t, run, text) {
    const pr = codexPr(run);
    const said = await gh(t, `/repos/${pr.repo}/issues/${pr.number}/comments`, { method: "POST", body: { body: mention(text) } });
    return { turn: String(said.id), tasks: 1 };
  },
  async read(t, run) {
    const pr = codexPr(run);
    if (!pr) return { texts: [], stop: "terminated", last: null, error: "no pull request", costCents: null };
    const after = Number(run.remote_turn || 0);
    const texts = [];
    for (let page = 1; page <= 5; page++) {
      const comments = await gh(t, `/repos/${pr.repo}/issues/${pr.number}/comments?per_page=100&page=${page}`);
      for (const c of comments || []) {
        const login = String(c?.user?.login || "");
        if (Number(c.id) <= after || login === t.remote?.login || !/codex/i.test(login)) continue;
        if (String(c.body || "").trim()) texts.push(String(c.body).trim());
      }
      if (!Array.isArray(comments) || comments.length < 100) break;
    }
    if (!texts.length) return { texts, stop: null, last: null, error: null, costCents: null };
    const link = `https://github.com/${pr.repo}/pull/${pr.number}`;
    if (!texts.join("\n").includes(link)) texts.push(link);
    return { texts, stop: "end_turn", last: null, error: null, costCents: null };
  },
};

const ADAPTERS = { claude, devin, cursor, codex };

/// The one custom agent that answers to @claude (or @devin, @cursor) here,
/// made or hidden.
async function ensureAgentRow(db, orgId, provider, login, on, existingId, members = []) {
  const p = PROVIDERS[provider];
  const now = new Date().toISOString();
  if (!on) {
    if (existingId) await db.prepare("UPDATE custom_agents SET deleted_at = ?3 WHERE org_id = ?1 AND id = ?2").bind(orgId, existingId, now).run();
    return existingId;
  }
  // A person or agent already called @claude keeps the name: this one is
  // then @claude-ai, never silently taking over.
  const id = existingId || `tm-${provider}-${crypto.randomUUID().slice(0, 8)}`;
  if (existingId) {
    await db.prepare("UPDATE custom_agents SET deleted_at = NULL, updated_at = ?3 WHERE org_id = ?1 AND id = ?2").bind(orgId, id, now).run();
  } else {
    const handle = (await handleTaken(db, orgId, p.handle, { members, scope: "team", ownerLogin: login })) ? `${p.handle}-ai` : p.handle;
    await db.prepare(
      `INSERT INTO custom_agents (org_id, id, handle, name, emoji, description, instructions, scope, owner_login, preset, provider, created_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', 'team', ?7, NULL, ?8, ?9, ?7, ?9)`
    ).bind(orgId, id, handle, p.name, p.emoji, `Works on what you hand it in a thread, with the team's repositories and tools.`, login, provider, now).run();
  }
  return id;
}

/// Setup, saved: checked, the service's side checked (or made) when it is
/// on, and the agent that answers to its name made or hidden.
export async function saveTeammate(env, orgId, provider, input, { login, workspaceName, members = [] }) {
  const p = PROVIDERS[provider];
  if (!p) return { error: "Unknown teammate." };
  const current = await loadTeammate(env.DB, orgId, provider);
  const { out, error } = cleanInput(input || {}, current, provider);
  if (error) return { error };
  const next = {
    orgId, provider, enabled: current?.enabled || false, apiKey: current?.apiKey || null, githubToken: current?.githubToken || null,
    repos: current?.repos || [], model: current?.model || p.defaultModel, instructions: current?.instructions || "",
    channels: current ? current.channels : null, monthlyLimitCents: current ? current.monthlyLimitCents : p.defaultLimit,
    tools: current?.tools || [], remote: current?.remote || {}, agentId: current?.agentId || null,
    autoBuild: current ? current.autoBuild !== false : true,
    ...Object.fromEntries(Object.entries(out).filter(([k]) => k !== "tools" && k !== "account")),
  };
  if (out.account !== undefined) next.remote = { ...next.remote, account: out.account };
  if (p.githubToken && !p.keyless && next.repos.length && !next.githubToken) return { error: `Add a GitHub token so ${p.name} can reach the repositories.` };
  let toolChanges = { kept: next.tools, written: [], removed: [] };
  if (out.tools) {
    const keep = new Set(out.tools.map((t) => t.secretName));
    toolChanges = {
      kept: out.tools.filter((t) => !t.secretValue && t.before).map((t) => ({ name: t.name, secretName: t.secretName, host: t.host, credentialId: t.credentialId })),
      written: out.tools.filter((t) => t.secretValue),
      removed: (current?.tools || []).filter((t) => !keep.has(t.secretName)),
    };
  }
  if (next.enabled) {
    if (p.keyless ? !next.githubToken : !next.apiKey) return { error: p.keyless ? `Add a GitHub token that can push to the repository ${p.name} works in.` : `Paste an API key from ${p.keySource} first.` };
    try {
      const made = await ADAPTERS[provider].provision(next, { workspaceName, toolChanges });
      next.remote = { ...next.remote, ...made.remote };
      next.tools = made.tools;
    } catch (err) {
      const status = err?.status || 0;
      if (status === 401 || status === 403) return { error: `${p.company} did not accept that API key.` };
      if (err instanceof ServiceError && status === 400) return { error: err.message };
      if (provider === "devin" && status === 404) return { error: "Devin did not find that organization ID." };
      return { error: `${p.company} could not set ${p.name} up: ${String(err?.message || "unknown error").slice(0, 200)}` };
    }
  } else if (out.tools) {
    // Off: tool edits wait for the next launch; new keys are not kept.
    if (toolChanges.written.length) return { error: `Turn ${p.name} on to add tool keys; they go straight to ${p.company}'s vault.` };
    next.tools = toolChanges.kept;
  }
  next.agentId = await ensureAgentRow(env.DB, orgId, provider, login, next.enabled, next.agentId, members);
  await env.DB.prepare(
    `INSERT INTO ai_teammates (org_id, provider, enabled, api_key, github_token, repos, model, instructions, channels, monthly_limit_cents, tools, remote, agent_id, updated_by, updated_at, auto_build)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
     ON CONFLICT(org_id, provider) DO UPDATE SET enabled = excluded.enabled, api_key = excluded.api_key, github_token = excluded.github_token,
       repos = excluded.repos, model = excluded.model, instructions = excluded.instructions, channels = excluded.channels,
       monthly_limit_cents = excluded.monthly_limit_cents, tools = excluded.tools, remote = excluded.remote, agent_id = excluded.agent_id,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at, auto_build = excluded.auto_build`
  ).bind(
    orgId, provider, next.enabled ? 1 : 0,
    await sealField(next.apiKey, aad.teammate(orgId, provider, "api_key")), await sealField(next.githubToken, aad.teammate(orgId, provider, "github_token")), JSON.stringify(next.repos), next.model, next.instructions,
    next.channels === null ? null : JSON.stringify(next.channels), next.monthlyLimitCents, JSON.stringify(next.tools), JSON.stringify(next.remote),
    next.agentId, login, new Date().toISOString(), next.autoBuild ? 1 : 0,
  ).run();
  return { teammate: await loadTeammate(env.DB, orgId, provider) };
}

/// The teammate behind a custom agent row, when it is one.
export async function teammateForAgent(db, orgId, agent) {
  const provider = agent?.provider;
  if (!provider || !PROVIDERS[provider]) return null;
  const t = await loadTeammate(db, orgId, provider);
  return t && t.enabled && t.agentId === agent.id ? t : null;
}

/// @claude (or another) in a thread: new work for a new thread, the same
/// work handed on for a follow-up. Returns the run to watch, or why not.
export async function startTeammateRun(env, { orgId, t, key, threadId, where, askedBy, transcript, request, login, onBehalfOf = null, now = new Date() }) {
  const p = PROVIDERS[t.provider];
  const adapter = ADAPTERS[t.provider];
  if (t.channels && key.startsWith("b:") && !t.channels.includes(key)) return { refused: "notHere" };
  const spent = await spentThisMonth(env.DB, orgId, t.provider, now);
  const remaining = t.monthlyLimitCents == null ? null : t.monthlyLimitCents - spent;
  if (remaining != null && remaining < p.minLeft) return { refused: "limit" };
  const existing = await env.DB.prepare(
    "SELECT * FROM ai_teammate_runs WHERE org_id = ?1 AND provider = ?2 AND channel = ?3 AND thread_id = ?4 ORDER BY created_at DESC LIMIT 1"
  ).bind(orgId, t.provider, key, threadId).first().catch(() => null);
  const stamp = now.toISOString();
  if (existing && existing.status !== "failed" && existing.status !== "budget") {
    const sent = await adapter.send(t, existing, `${askedBy}: ${request}`);
    if (sent.busy) return { refused: "busy" };
    // The next answer is for whoever this turn was asked for.
    await env.DB.prepare("UPDATE ai_teammate_runs SET status = 'running', remote_turn = COALESCE(?3, remote_turn), cost_cents = cost_cents + ?4, on_behalf_of = ?5, updated_at = ?2 WHERE id = ?1")
      .bind(existing.id, stamp, sent.turn || null, (sent.tasks || 0) * 100, onBehalfOf).run();
    return { run: { ...existing, status: "running", remote_turn: sent.turn || existing.remote_turn, on_behalf_of: onBehalfOf }, continued: true };
  }
  const started = await adapter.start(t, {
    task: taskText({ where, askedBy, transcript, request }), title: `${where}: ${request}`.slice(0, 200),
    remaining, orgId, key, threadId,
  });
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO ai_teammate_runs (id, org_id, provider, channel, thread_id, remote_id, remote_turn, status, cost_cents, last_event_at, started_by, created_at, updated_at, on_behalf_of)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, NULL, ?9, ?10, ?10, ?11)`
  ).bind(id, orgId, t.provider, key, threadId, started.remoteId, started.turn || null, (started.tasks || 0) * 100, login, stamp, onBehalfOf).run();
  return { run: { id, org_id: orgId, provider: t.provider, channel: key, thread_id: threadId, remote_id: started.remoteId, remote_turn: started.turn || null, status: "running", last_event_at: null, on_behalf_of: onBehalfOf } };
}

/// What a run has done since it was last looked at: its words since the last
/// hand-off, and whether it has stopped, and why.
export async function readRun(env, t, run) {
  return ADAPTERS[t.provider].read(t, run);
}

/// Runs still working, oldest first: what the minute cron looks in on.
export async function openRuns(db, { limit = 25, ids = null } = {}) {
  if (ids) {
    if (!ids.length) return [];
    const marks = ids.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await db.prepare(`SELECT * FROM ai_teammate_runs WHERE id IN (${marks}) AND status = 'running'`).bind(...ids).all();
    return results || [];
  }
  const { results } = await db.prepare("SELECT * FROM ai_teammate_runs WHERE status = 'running' ORDER BY updated_at LIMIT ?1").bind(limit).all();
  return results || [];
}

/// A run's state after a look. While it works nothing moves: the next look
/// reads from the same place, so nothing it said is lost. When it stops, the
/// one look that marks it so (a second one racing it changes nothing) is the
/// one to post its answer. Returns the new status, or null when there is
/// nothing to post.
export async function settleRun(db, run, read, now = new Date()) {
  let status = null;
  if (read.stop === "end_turn" || read.stop === "requires_action" || read.stop === "retries_exhausted") status = "idle";
  else if (read.stop === "budget_reached") status = "budget";
  else if (read.stop === "terminated") status = "failed";
  else if (!read.stop && now - new Date(run.updated_at) > STALE_MS) status = "failed";
  if (!status) return null;
  const out = await db.prepare(
    "UPDATE ai_teammate_runs SET status = ?2, last_event_at = COALESCE(?3, last_event_at), cost_cents = COALESCE(?4, cost_cents) WHERE id = ?1 AND status = 'running'"
  ).bind(run.id, status, read.last || null, read.costCents).run();
  return Number(out?.meta?.changes || 0) > 0 ? status : null;
}
