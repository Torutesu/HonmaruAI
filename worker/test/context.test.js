import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { routeInstruction } from "../src/routing.js";
import { connectedSources, formatSourcesForModel, searchGithubIssues } from "../src/context.js";

// The team's connected tools as research: the router may look in Notion or
// GitHub before it writes, and "Ask anything" answers from them too. Each
// runs as the person's own connection, bounded, and fails to nothing.

const OPENAI = { apiKey: "sk-test", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", providerName: "OpenAI" };
const TEAM = { orgId: "acme/ops", nodes: [
  { id: "toru", kind: "person", role: "founder", label: "Toru · founder" },
  { id: "kenji", kind: "person", role: "operator", label: "Kenji · operator" },
], edges: [] };
const SENDER = { id: "toru", name: "Toru", role: "founder" };
const ctx = { waitUntil() {} };

const notionPage = (title, url) => ({ id: "p1", url, last_edited_time: "2026-09-01T00:00:00Z", properties: { Name: { type: "title", title: [{ plain_text: title }] }, Notes: { type: "rich_text", rich_text: [{ plain_text: "Lease runs to March; renew by January." }] } } });

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("the router may search Notion and GitHub in one round, and then must write", async () => {
  const bodies = [];
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      bodies.push(JSON.parse(opts.body));
      return { choices: [{ message: { content: null, tool_calls: [
        { id: "n1", type: "function", function: { name: "search_notion", arguments: JSON.stringify({ query: "lease renewal" }) } },
        { id: "g1", type: "function", function: { name: "search_github", arguments: JSON.stringify({ query: "lease" }) } },
      ] } }] };
    }).times(1);
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      bodies.push(JSON.parse(opts.body));
      return { choices: [{ message: { content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "create_decision_card", arguments: JSON.stringify({
          recipientUserID: "kenji", cardType: "approval", title: "Renew the lease", summary: "The Notion page says renew by January.",
          context: "deadline: January", priority: "high", routingReason: "Kenji owns the lease",
        }) } },
      ] } }] };
    }).times(1);

  const seen = [];
  const res = await routeInstruction({
    text: "Kenji, decide on the lease renewal", sender: SENDER, organization: TEAM, openRouter: OPENAI, readerLanguage: "en",
    lookups: {
      searchNotion: async (q) => { seen.push(["notion", q]); return [{ app: "Notion", title: "Lease 2026", url: "https://notion.so/lease", snippet: "renew by January", when: "2026-09-01" }]; },
      searchGithub: async (q) => { seen.push(["github", q]); return []; },
    },
  });
  expect(seen).toEqual([["notion", "lease renewal"], ["github", "lease"]]);
  expect(bodies[0].tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["search_notion", "search_github", "create_decision_card"]));
  expect(bodies[0].tools.map((t) => t.function.name)).not.toContain("search_decisions");
  const toolMessages = bodies[1].messages.filter((m) => m.role === "tool");
  expect(toolMessages.find((m) => m.tool_call_id === "n1").content).toContain("[Notion] Lease 2026 (2026-09-01) — renew by January <https://notion.so/lease>");
  expect(toolMessages.find((m) => m.tool_call_id === "g1").content).toBe("Nothing matches in the connected tools.");
  expect(res.recipientUserID).toBe("kenji");
  expect(res.toolCalls.map((s) => s.name)).toEqual(["search_notion", "search_github", "create_decision_card"]);
  expect(res.toolCalls[0].detail).toBe('"lease renewal" · 1 found');
});

test("which sources a person has: Notion when connected, GitHub only in a repository workspace with a token", async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { setConnectorConfig } = await import("../src/db.js");
  const none = await connectedSources({ ...env, COMPOSIO_API_KEY: "ck" }, { github_id: "9001", github_access_token: null }, "personal:me");
  expect(none).toEqual({ notion: false, github: false });
  await setConnectorConfig(env.DB, "9001", "notion", { connected: true });
  const some = await connectedSources({ ...env, COMPOSIO_API_KEY: "ck" }, { github_id: "9001", github_access_token: "gho_x" }, "acme/ops");
  expect(some).toEqual({ notion: true, github: true });
  // No Composio on this deployment: Notion cannot be searched whatever the row says.
  expect((await connectedSources({ ...env, COMPOSIO_API_KEY: undefined }, { github_id: "9001", github_access_token: "gho_x" }, "acme/ops")).notion).toBe(false);
});

test("GitHub issues are searched as the person, in the workspace's repository", async () => {
  let asked;
  fetchMock.get("https://api.github.com")
    .intercept({ path: /^\/search\/issues/, method: "GET" })
    .reply(200, (opts) => { asked = opts; return { items: [{ number: 12, title: "Lease renewal paperwork", html_url: "https://github.com/acme/ops/issues/12", state: "open", user: { login: "kenji" } }] }; });
  const hits = await searchGithubIssues({ github_access_token: "gho_x" }, "acme/ops", "lease");
  expect(hits).toEqual([{ app: "GitHub", title: "#12 Lease renewal paperwork", url: "https://github.com/acme/ops/issues/12", snippet: "issue · open · kenji", when: null }]);
  expect(decodeURIComponent(asked.path.replace(/\+/g, " "))).toContain("q=repo:acme/ops lease");
  expect(asked.headers.authorization || asked.headers.Authorization).toBe("Bearer gho_x");
  // Not a repository workspace: nothing to search, no call.
  expect(await searchGithubIssues({ github_access_token: "gho_x" }, "personal:me", "lease")).toEqual([]);
  expect(formatSourcesForModel([])).toBe("Nothing matches in the connected tools.");
});

test("Ask anything answers from a connected Notion page, and names it", async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard, setConnectorConfig } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9101", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:ctx", "9101", "admin");
  await setConnectorConfig(env.DB, "9101", "notion", { connected: true });
  const token = await createSession(env.DB, "9101", "gho_toru");
  await saveCard(env.DB, "personal:ctx", { id: "x-1", recipientUserID: "toru", senderUserID: "kenji", type: "approval", title: "Renew the lease", summary: "Renew?", status: "pending", priority: "high", createdAt: "2026-09-10T00:00:00Z" });

  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/NOTION_SEARCH_NOTION_PAGE", method: "POST" })
    .reply(200, (opts) => {
      const body = JSON.parse(opts.body);
      expect(body.user_id).toBe("9101");
      expect(body.arguments.query).toContain("lease");
      return { successful: true, data: { results: [notionPage("Lease 2026", "https://notion.so/lease")] } };
    });
  let prompt;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => { prompt = JSON.parse(opts.body); return { choices: [{ message: { content: "The Notion page Lease 2026 says renew by January." } }] }; });

  const res = await worker.fetch(new Request("https://example.com/ai/ask", {
    method: "POST", headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ orgId: "personal:ctx", cardId: "x-1", question: "When does the lease have to be renewed?", readerLanguage: "en" }),
  }), { ...env, OPENAI_API_KEY: "sk-test", COMPOSIO_API_KEY: "ck_test" }, ctx);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.answer).toContain("Lease 2026");
  expect(body.sources).toEqual([{ app: "Notion", title: "Lease 2026", url: "https://notion.so/lease" }]);
  const user = prompt.messages.find((m) => m.role === "user").content;
  expect(user).toContain("[Notion] Lease 2026 (2026-09-01) — Lease runs to March; renew by January.");
});
