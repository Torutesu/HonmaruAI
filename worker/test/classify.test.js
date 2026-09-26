import {env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { classifyBusiness, fileCardUnderBusiness } from "../src/classify.js";
import { routeInstruction } from "../src/routing.js";

// Nobody files a card by hand. The model reads it and picks the channel it
// is about — one of the team's own. It never makes a channel up.

const ORG = "acme/holdings";
const provider = { providerName: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "sk-test", model: "m" };

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const answer = (business, isNew = false) => ({ choices: [{ message: { content: JSON.stringify({ business, isNew }) } }] });
const intercept = (reply, sink) => fetchMock.get("https://api.openai.com")
  .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { if (sink) sink.push(JSON.parse(b)); return true; } })
  .reply(200, reply);

test("an existing business comes back as its slug, by slug or by name", async () => {
  const businesses = [{ slug: "hotel-本丸", name: "Hotel 本丸" }, { slug: "cafe-sakura", name: "Cafe Sakura" }];
  intercept(answer("cafe-sakura"));
  expect(await classifyBusiness({ title: "Approve the spring menu" }, { provider, businesses })).toEqual({ called: true, name: "cafe-sakura" });
  intercept(answer("Hotel 本丸"));
  expect(await classifyBusiness({ title: "予約システムの修正" }, { provider, businesses })).toEqual({ called: true, name: "hotel-本丸" });
});

test("a card is filed in the public channel it is about; a name the model makes up files nothing", async () => {
  const { upsertBusiness, listBusinesses } = await import("../src/db.js");
  await upsertBusiness(env.DB, ORG, { name: "Hiring", createdBy: "6101" });
  await upsertBusiness(env.DB, ORG, { name: "Research", createdBy: "6101" });
  await env.DB.prepare("INSERT INTO businesses (org_id, slug, name, created_at, private) VALUES (?1, 'secret', 'Secret', ?2, 1)").bind(ORG, new Date().toISOString()).run();
  const prompts = [];
  intercept({ choices: [{ message: { content: JSON.stringify({ channel: "research" }) } }] }, prompts);
  let consumed = 0;
  const slug = await fileCardUnderBusiness(env, {
    orgId: ORG, provider, githubId: "6101",
    card: { title: "YCS26の調査を実施", summary: "Look into YCS26." },
    allowance: { allowed: true, metered: true, consume: async () => { consumed += 1; } },
  });
  expect(slug).toBe("research");
  expect(consumed).toBe(1);
  // The private channel is not offered.
  expect(prompts[0].messages[1].content).toContain("- research: Research");
  expect(prompts[0].messages[1].content).not.toContain("secret");
  intercept(answer("Bakery Kita", true));
  expect(await fileCardUnderBusiness(env, { orgId: ORG, provider, card: { title: "Sign the bakery lease" } })).toBeNull();
  expect((await listBusinesses(env.DB, ORG)).map((b) => b.slug).sort()).toEqual(["hiring", "research"]);
});

test("no model, no allowance, a card already filed, or a useless answer leaves the card alone", async () => {
  const card = { title: "Anything" };
  expect(await fileCardUnderBusiness(env, { orgId: ORG, card, provider: undefined })).toBeNull();
  expect(await fileCardUnderBusiness(env, { orgId: ORG, card, provider, allowance: { allowed: false } })).toBeNull();
  expect(await fileCardUnderBusiness(env, { orgId: ORG, card: { ...card, business: "kept" }, provider })).toBe("kept");

  // No channel yet: nothing to file under, and no model asked.
  expect(await fileCardUnderBusiness(env, { orgId: ORG, card, provider })).toBeNull();
  const { upsertBusiness } = await import("../src/db.js");
  await upsertBusiness(env.DB, ORG, { name: "General", createdBy: "6101" });
  intercept({ choices: [{ message: { content: "I cannot say" } }] });
  let consumed = 0;
  expect(await fileCardUnderBusiness(env, {
    orgId: ORG, card, provider, allowance: { allowed: true, metered: true, consume: async () => { consumed += 1; } },
  })).toBeNull();
  // Answered, so paid for; nothing created.
  expect(consumed).toBe(1);
  const { listBusinesses } = await import("../src/db.js");
  expect((await listBusinesses(env.DB, ORG)).map((b) => b.slug)).toEqual(["general"]);
});

test("the router never names a channel that does not exist", async () => {
  const org = {
    nodes: [{ id: "owner", kind: "person", label: "owner · Admin" }, { id: "member", kind: "person", label: "member · Engineer" }],
    edges: [],
    businesses: [{ slug: "hotel-本丸", name: "Hotel 本丸" }],
  };
  intercept({ choices: [{ message: { tool_calls: [{
    id: "t1", type: "function",
    function: { name: "create_decision_card", arguments: JSON.stringify({
      recipientUserID: "member", cardType: "task", title: "Set up the food truck permit", summary: "The truck needs a permit.",
      context: "scope: permit", priority: "medium", routingReason: "Engineer.", newBusiness: "Food Truck",
    }) },
  }] } }] });
  const routed = await routeInstruction({
    text: "ask member to sort out the food truck permit", sender: { id: "owner", name: "owner", role: "admin" },
    organization: org, openRouter: provider,
  });
  expect(routed.business).toBeNull();
});
