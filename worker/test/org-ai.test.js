import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { providerFor, jevFor } from "../src/orgAI.js";

// What a workspace runs its AI on is set from the Tools screen by its admin:
// a model, a key of its own, System One. A member reads the status; nobody
// reads a key back; another workspace sees none of it.

const ORG = "personal:toru";
let toru, mika, out;
const call = (path, init = {}, over = {}) =>
  worker.fetch(new Request("https://example.com" + path, init), { ...env, ...over }, { waitUntil() {} });
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const get = (path, token, over) => call(path, { headers: { "x-session-token": token } }, over);
const put = (path, token, body, over) => call(path, { method: "PUT", headers: headers(token), body: JSON.stringify(body) }, over);
const post = (path, token, body, over) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) }, over);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:toru@x.jp", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "email:mika@x.jp", login: "u:mika@x.jp", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:out@x.jp", login: "u:out@x.jp", name: "Out", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "email:toru@x.jp", "admin");
  await upsertMembership(env.DB, ORG, "email:mika@x.jp", "member");
  await upsertMembership(env.DB, "personal:out", "email:out@x.jp", "admin");
  toru = await createSession(env.DB, "email:toru@x.jp", "email-auth");
  mika = await createSession(env.DB, "email:mika@x.jp", "email-auth");
  out = await createSession(env.DB, "email:out@x.jp", "email-auth");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("with nothing set, the workspace runs on the deployment's model — and says so", async () => {
  const res = await get(`/orgs/ai?orgId=${encodeURIComponent(ORG)}`, mika, { OPENAI_API_KEY: "sk-deploy-0000" });
  expect(res.status).toBe(200);
  const status = await res.json();
  expect(status).toMatchObject({ model: "gpt-4o-mini", modelSource: "deployment", openai: "deployment", systemOne: false, jev: "none", canEdit: false });
  expect(status.models.map((m) => m.id)).toContain("gpt-4.1-nano");
  expect(JSON.stringify(status)).not.toContain("sk-deploy");
});

test("an admin picks the model and enters the workspace's own keys; a member cannot", async () => {
  let res = await put("/orgs/ai", mika, { orgId: ORG, model: "gpt-4.1-nano" });
  expect(res.status).toBe(403);
  res = await put("/orgs/ai", toru, { orgId: ORG, model: "gpt-4.1-nano", openaiKey: "sk-workspace-abcdefghijkl1234", typesafeKey: "ts_live_abcdefghijklmnop" });
  expect(res.status).toBe(200);
  const status = await res.json();
  expect(status).toMatchObject({ model: "gpt-4.1-nano", modelSource: "workspace", openai: "workspace", openaiHint: "…1234", systemOne: true, jev: "workspace", jevHint: "…mnop", canEdit: true });
  expect(JSON.stringify(status)).not.toContain("sk-workspace-abcdefghijkl1234");
  expect(JSON.stringify(status)).not.toContain("ts_live_abcdefghijklmnop");

  // The provider every call is built from now carries them.
  const provider = await providerFor(env, ORG);
  expect(provider).toMatchObject({ apiKey: "sk-workspace-abcdefghijkl1234", model: "gpt-4.1-nano", byok: true });
  expect((await jevFor(env, ORG)).apiKey).toBe("ts_live_abcdefghijklmnop");
  // A person's own key still wins over the workspace's.
  expect((await providerFor(env, ORG, "sk-mine-abcdefghijklmnop")).apiKey).toBe("sk-mine-abcdefghijklmnop");
});

test("a bad model, a key that is not one, and clearing", async () => {
  expect((await put("/orgs/ai", toru, { orgId: ORG, model: "gpt-9" })).status).toBe(400);
  expect((await put("/orgs/ai", toru, { orgId: ORG, openaiKey: "hello" })).status).toBe(400);
  await put("/orgs/ai", toru, { orgId: ORG, openaiKey: "sk-workspace-abcdefghijkl1234" });
  const cleared = await (await put("/orgs/ai", toru, { orgId: ORG, openaiKey: null, model: "" }, { OPENAI_API_KEY: "sk-deploy-0000" })).json();
  expect(cleared).toMatchObject({ openai: "deployment", modelSource: "deployment", openaiHint: null });
});

test("another workspace neither reads nor writes it", async () => {
  expect((await get(`/orgs/ai?orgId=${encodeURIComponent(ORG)}`, out)).status).toBe(403);
  expect((await put("/orgs/ai", out, { orgId: ORG, model: "gpt-4o" })).status).toBe(403);
});

test("a routed instruction goes to the workspace's model on the workspace's key", async () => {
  await put("/orgs/ai", toru, { orgId: ORG, model: "gpt-4.1-nano", openaiKey: "sk-workspace-abcdefghijkl1234" });
  let captured, auth;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { captured = JSON.parse(b); return true; } })
    .reply(200, (opts) => {
      auth = opts.headers?.authorization || opts.headers?.Authorization;
      return {
        choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: {
          name: "create_decision_card",
          arguments: JSON.stringify({ recipientUserID: "u:mika@x.jp", cardType: "task", title: "Menu",
            summary: "Approve it.", context: "menu", priority: "medium", routingReason: "Mika runs the cafe." }),
        } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    })
    .times(1);
  const res = await post("/ai/route", toru, { text: "Ask Mika to approve the menu", orgId: ORG });
  expect(res.status).toBe(200);
  expect(captured.model).toBe("gpt-4.1-nano");
  expect(auth).toBe("Bearer sk-workspace-abcdefghijkl1234");
  // Their key, their bill: the ledger does not count it as ours.
  const row = await env.DB.prepare("SELECT byok, model FROM ai_calls WHERE org_id = ?1").bind(ORG).first();
  expect(row).toMatchObject({ byok: 1, model: "gpt-4.1-nano" });
});
