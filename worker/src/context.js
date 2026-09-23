// What the team's connected tools know, as research the AI can draw on.
//
// A connector used to be an input only: mail and Slack messages became
// cards. The same connections can answer questions — "what did the Notion
// page say about the lease?", "is there an issue open for this?" — so the
// router looks before it writes and "Ask anything" answers from more than
// the feed. Each lookup is bounded (a handful of hits, a few seconds), runs
// as the asking person's own connection, and fails to an empty list: a
// tool that is down is a card routed the old way, not a card not routed.

import { executeTool } from "./composio.js";
import { getConnectorConfig } from "./db.js";

const MAX_HITS = 5;
const TIMEOUT_MS = 6000;

/// Which sources this person can be searched through, in this workspace.
export async function connectedSources(env, session, orgId) {
  const sources = { notion: false, github: false };
  if (!session) return sources;
  if (env.COMPOSIO_API_KEY) {
    try {
      const notion = await getConnectorConfig(env.DB, session.github_id, "notion");
      sources.notion = Boolean(notion?.connected || notion?.databaseId);
    } catch { /* no config, no source */ }
  }
  // A GitHub workspace is "owner/repo", and the session that made it carries
  // a token for it. A personal or email workspace has neither.
  sources.github = Boolean(session.github_access_token && /^[^/\s:]+\/[^/\s]+$/.test(String(orgId || "")));
  return sources;
}

function notionTitle(page) {
  const props = page?.properties || {};
  const entry = Object.values(props).find((p) => p?.type === "title");
  const fromProps = (entry?.title || []).map((t) => t.plain_text || "").join("").trim();
  if (fromProps) return fromProps;
  const fromTitle = (page?.title || []).map?.((t) => t.plain_text || "").join("").trim();
  return fromTitle || "Untitled";
}

function notionSnippet(page) {
  const props = page?.properties || {};
  const entry = Object.values(props).find((p) => p?.type === "rich_text" && p.rich_text?.length);
  return (entry?.rich_text || []).map((t) => t.plain_text || "").join("").trim().slice(0, 300);
}

/// Pages in the person's Notion that match, through their own connection.
export async function searchNotion(env, githubId, query) {
  const q = String(query || "").trim().slice(0, 200);
  if (!q || !env.COMPOSIO_API_KEY) return [];
  const payload = await withTimeout(
    executeTool(env.COMPOSIO_API_KEY, "NOTION_SEARCH_NOTION_PAGE", String(githubId), { query: q, page_size: MAX_HITS }),
    TIMEOUT_MS,
  );
  const wrapped = payload?.results?.[0]?.response?.data?.results;
  const plain = payload?.data?.results ?? payload?.results;
  const rows = Array.isArray(wrapped) ? wrapped : Array.isArray(plain) ? plain : [];
  return rows.slice(0, MAX_HITS).map((page) => ({
    app: "Notion",
    title: notionTitle(page).slice(0, 200),
    url: typeof page?.url === "string" ? page.url : null,
    snippet: notionSnippet(page),
    when: page?.last_edited_time || null,
  }));
}

/// Issues and pull requests in the workspace's repository that match, as
/// the person — their token, their visibility.
export async function searchGithubIssues(session, orgId, query) {
  const q = String(query || "").trim().slice(0, 200);
  const repo = String(orgId || "");
  if (!q || !session?.github_access_token || !/^[^/\s:]+\/[^/\s]+$/.test(repo)) return [];
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", `repo:${repo} ${q}`);
  url.searchParams.set("per_page", String(MAX_HITS));
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${session.github_access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "tiktokforwork",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub search ${res.status}`);
  const data = await res.json();
  return (data?.items || []).slice(0, MAX_HITS).map((it) => ({
    app: "GitHub",
    title: `#${it.number} ${String(it.title || "").slice(0, 160)}`,
    url: typeof it.html_url === "string" ? it.html_url : null,
    snippet: `${it.pull_request ? "pull request" : "issue"} · ${it.state}${it.user?.login ? ` · ${it.user.login}` : ""}`,
    when: it.updated_at || null,
  }));
}

/// The searches this person can run, as the router's lookups. Each swallows
/// its own failure into an empty list.
export function lookupsFor(env, session, orgId, sources) {
  const lookups = {};
  if (sources?.notion) {
    lookups.searchNotion = async (query) => {
      try { return await searchNotion(env, session.github_id, query); } catch (err) { console.error("notion search failed", err?.message || err); return []; }
    };
  }
  if (sources?.github) {
    lookups.searchGithub = async (query) => {
      try { return await searchGithubIssues(session, orgId, query); } catch (err) { console.error("github search failed", err?.message || err); return []; }
    };
  }
  return lookups;
}

/// One line per hit, for a model that reads them.
export function formatSourcesForModel(rows) {
  if (!rows?.length) return "Nothing matches in the connected tools.";
  return rows.map((r) => `- [${r.app}] ${r.title}${r.when ? ` (${String(r.when).slice(0, 10)})` : ""}${r.snippet ? ` — ${r.snippet}` : ""}${r.url ? ` <${r.url}>` : ""}`).join("\n");
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}
