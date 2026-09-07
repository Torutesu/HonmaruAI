import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { classifyBusiness, fileCardUnderBusiness } from "../src/classify.js";
import { routeInstruction } from "../src/routing.js";

// Nobody files a card by hand. The model reads it and picks the business it
// is about — one of the organization's own, or a new one when nothing fits.

const ORG = "acme/holdings";
const provider = { providerName: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "sk-test", model: "m" };

beforeAll(async () => {
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

test("a new name is created as a business, and the card gets its slug", async () => {
  const prompts = [];
  intercept(answer("Bakery Kita", true), prompts);
  let consumed = 0;
  const slug = await fileCardUnderBusiness(env, {
    orgId: ORG, provider, githubId: "6101",
    card: { title: "Sign the lease for the bakery", summary: "Kita-ku, two floors." },
    allowance: { allowed: true, metered: true, consume: async () => { consumed += 1; } },
  });
  expect(slug).toBe("bakery-kita");
  expect(consumed).toBe(1);
  expect(prompts[0].messages[1].content).toContain("(none yet)");
  const { listBusinesses } = await import("../src/db.js");
  expect(await listBusinesses(env.DB, ORG)).toMatchObject([{ slug: "bakery-kita", name: "Bakery Kita" }]);
});

test("no model, no allowance, a card already filed, or a useless answer leaves the card alone", async () => {
  const card = { title: "Anything" };
  expect(await fileCardUnderBusiness(env, { orgId: ORG, card, provider: undefined })).toBeNull();
  expect(await fileCardUnderBusiness(env, { orgId: ORG, card, provider, allowance: { allowed: false } })).toBeNull();
  expect(await fileCardUnderBusiness(env, { orgId: ORG, card: { ...card, business: "kept" }, provider })).toBe("kept");

  intercept({ choices: [{ message: { content: "I cannot say" } }] });
  let consumed = 0;
  expect(await fileCardUnderBusiness(env, {
    orgId: ORG, card, provider, allowance: { allowed: true, metered: true, consume: async () => { consumed += 1; } },
  })).toBeNull();
  // Answered, so paid for; nothing created.
  expect(consumed).toBe(1);
  const { listBusinesses } = await import("../src/db.js");
  expect(await listBusinesses(env.DB, ORG)).toEqual([]);
});

test("the router names a new business when none of the org's fit", async () => {
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
  expect(routed.business).toBe("Food Truck");
});
