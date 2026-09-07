import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message } from "./helpers.js";
import { businessSlug } from "../src/db.js";
import { routeInstruction, buildAgentTools, matchBusiness } from "../src/routing.js";
import worker from "../src/index.js";

// Ten people running ten businesses: every card belongs to one, and the
// taxonomy is discovered by tagging rather than designed up front.

const ORG = "acme/holdings";
let ownerToken;
let memberToken;
let outsiderToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "6101", login: "owner", name: "Owner", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "6102", login: "member", name: "Member", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "6103", login: "outsider", name: "Outsider", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "6101", "admin");
  await upsertMembership(env.DB, ORG, "6102", "member");
  ownerToken = await createSession(env.DB, "6101", "gho_owner");
  memberToken = await createSession(env.DB, "6102", "gho_member");
  outsiderToken = await createSession(env.DB, "6103", "gho_outsider");
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });

test("a slug is the name, folded, in any script", () => {
  expect(businessSlug("Hotel 本丸")).toBe("hotel-本丸");
  expect(businessSlug("  HOTEL   本丸 ")).toBe("hotel-本丸");
  expect(businessSlug("SaaS / Billing")).toBe("saas-billing");
  expect(businessSlug("   ")).toBeNull();
  expect(businessSlug(42)).toBeNull();
});

test("a member names a business; the list is the org's; an outsider sees nothing", async () => {
  let res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(ownerToken), body: JSON.stringify({ orgId: ORG, name: "Hotel 本丸" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).business).toEqual({ slug: "hotel-本丸", name: "Hotel 本丸" });

  // The same name again is the same business, and the first spelling sticks.
  res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(memberToken), body: JSON.stringify({ orgId: ORG, name: "hotel 本丸" }),
  });
  expect((await res.json()).businesses).toEqual([{ slug: "hotel-本丸", name: "Hotel 本丸", createdBy: "6101", createdAt: expect.any(String) }]);

  res = await SELF.fetch(`https://example.com/businesses?orgId=${encodeURIComponent(ORG)}`, { headers: headers(outsiderToken) });
  expect(res.status).toBe(403);
  res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(outsiderToken), body: JSON.stringify({ orgId: ORG, name: "Mine now" }),
  });
  expect(res.status).toBe(403);

  res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(ownerToken), body: JSON.stringify({ orgId: ORG, name: "   " }),
  });
  expect(res.status).toBe(400);
});

test("tagging a card with a new name creates the business, and either party may re-file it", async () => {
  const owner = await joined(ORG, ownerToken);
  const member = await joined(ORG, memberToken);

  owner.ws.send(JSON.stringify({
    type: "card_created",
    payload: { card: {
      id: "card-biz-1", type: "approval", status: "pending", recipientUserID: "member",
      title: "Approve the new menu", summary: "Spring menu for the cafe.", priority: "medium",
      createdAt: new Date().toISOString(), business: "Cafe Sakura",
    } },
  }));
  const seen = await message(member.messages, (m) => JSON.stringify(m).includes("card-biz-1"));
  expect(JSON.stringify(seen)).toContain('"business":"cafe-sakura"');

  const { listBusinesses, getCard } = await import("../src/db.js");
  expect((await listBusinesses(env.DB, ORG)).map((b) => b.slug)).toContain("cafe-sakura");

  // The recipient re-files it under the hotel.
  const before = owner.messages.length;
  member.ws.send(JSON.stringify({ type: "set_business", payload: { cardId: "card-biz-1", business: "Hotel 本丸" } }));
  const refiled = await message(owner.messages, (m, i) => i >= before && JSON.stringify(m).includes("hotel-本丸"));
  expect(refiled).toBeTruthy();
  expect((await getCard(env.DB, ORG, "card-biz-1")).business).toBe("hotel-本丸");

  // And can clear it.
  member.ws.send(JSON.stringify({ type: "set_business", payload: { cardId: "card-biz-1", business: null } }));
  const { until } = await import("./helpers.js");
  expect(await until(async () => (await getCard(env.DB, ORG, "card-biz-1")).business === undefined)).toBeTruthy();

  // Someone who is neither sender nor recipient may not.
  const { upsertMembership, createSession } = await import("../src/db.js");
  await upsertMembership(env.DB, ORG, "6103", "member");
  const third = await joined(ORG, await createSession(env.DB, "6103", "gho_outsider2"));
  third.ws.send(JSON.stringify({ type: "set_business", payload: { cardId: "card-biz-1", business: "Cafe Sakura" } }));
  const refused = await message(third.messages, (m) => m.type === "RUN_ERROR");
  expect(refused.message).toContain("Only the sender or the recipient");
});

test("the router files a card under one of the org's businesses, never one it invented", async () => {
  const org = {
    nodes: [
      { id: "owner", kind: "person", label: "owner · Admin" },
      { id: "member", kind: "person", label: "member · Engineer" },
    ],
    edges: [],
    businesses: [{ slug: "hotel-本丸", name: "Hotel 本丸" }, { slug: "cafe-sakura", name: "Cafe Sakura" }],
  };
  const tool = buildAgentTools(org).find((t) => t.function.name === "create_decision_card");
  expect(tool.function.parameters.properties.business.enum).toEqual(["hotel-本丸", "cafe-sakura"]);
  // No businesses, no field: the model is not invited to guess.
  expect(buildAgentTools({ nodes: org.nodes }).find((t) => t.function.name === "create_decision_card")
    .function.parameters.properties.business).toBeUndefined();

  expect(matchBusiness("ask member to fix the Cafe Sakura menu", org)).toBe("cafe-sakura");
  expect(matchBusiness("本丸の予約システムを直して", org)).toBe("hotel-本丸");
  expect(matchBusiness("nothing in particular", org)).toBeNull();

  const reply = (business) => ({
    choices: [{ message: { tool_calls: [{
      id: "t1", type: "function",
      function: { name: "create_decision_card", arguments: JSON.stringify({
        recipientUserID: "member", cardType: "task", title: "Fix the menu", summary: "The cafe menu is wrong.",
        context: "scope: menu", priority: "medium", routingReason: "Engineer.", business,
      }) },
    }] } }],
  });
  const provider = { providerName: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "sk-test", model: "m" };
  const sender = { id: "owner", name: "owner", role: "admin" };

  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, reply("cafe-sakura"));
  let routed = await routeInstruction({ text: "ask member to fix the menu", sender, organization: org, openRouter: provider });
  expect(routed.business).toBe("cafe-sakura");

  // An invented slug is dropped, and the instruction's own words decide.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, reply("bakery"));
  routed = await routeInstruction({ text: "ask member to fix the Hotel 本丸 menu", sender, organization: org, openRouter: provider });
  expect(routed.business).toBe("hotel-本丸");

  // The keyword router files by name too.
  routed = await routeInstruction({ text: "ask member to fix the cafe sakura menu", sender, organization: org });
  expect(routed.business).toBe("cafe-sakura");
});

test("/ai/route hands the router the org's businesses from the table", async () => {
  // Storage is isolated per test, so the business is named here.
  await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(ownerToken), body: JSON.stringify({ orgId: ORG, name: "Hotel 本丸" }),
  });
  let captured;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { captured = JSON.parse(b); return true; } })
    .reply(200, { choices: [{ message: { tool_calls: [{
      id: "t1", type: "function",
      function: { name: "create_decision_card", arguments: JSON.stringify({
        recipientUserID: "member", cardType: "task", title: "Fix the booking form", summary: "The form is broken.",
        context: "scope: booking", priority: "high", routingReason: "Engineer.", business: "hotel-本丸",
      }) },
    }] } }] });
  const res = await worker.fetch(new Request("https://example.com/ai/route", {
    method: "POST", headers: headers(ownerToken),
    body: JSON.stringify({ text: "ask member to fix the hotel booking form", orgId: ORG, sender: { id: "owner", name: "owner", role: "admin" } }),
  }), { ...env, OPENAI_API_KEY: "sk-test" });
  expect(res.status).toBe(200);
  const body = await res.json();
  const tool = captured.tools.find((t) => t.function.name === "create_decision_card");
  expect(tool.function.parameters.properties.business.enum).toContain("hotel-本丸");
  expect(captured.messages[1].content).toContain("Hotel 本丸");
  expect(body.business).toBe("hotel-本丸");
});
