import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message } from "./helpers.js";
import { searchDecisions, recentDecisions, exportGolden } from "../src/insights.js";
import { accessFor } from "../src/access.js";

// A private channel's cards are its members' and the two people on each. The
// HTTP routes held to that; the live feed did not — every socket in the
// workspace was handed them at join and heard each one made and decided —
// and neither did the decision lookups an AI answer, an agent or an export
// reads from.

const ORG = "team:privatecards";
let owner, insider, outsider;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM cards; DELETE FROM businesses; DELETE FROM conversation_members;");
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  for (const [id, login] of [["9601", "owner"], ["9602", "insider"], ["9603", "outsider"]]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, id === "9601" ? "owner" : "member");
  }
  owner = await createSession(env.DB, "9601", "x");
  insider = await createSession(env.DB, "9602", "x");
  outsider = await createSession(env.DB, "9603", "x");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO businesses (org_id, slug, name, private, created_at) VALUES (?1, 'board', 'Board', 1, ?2)").bind(ORG, now).run();
  for (const login of ["owner", "insider"]) {
    await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_at) VALUES (?1, 'b:board', ?2, ?3)").bind(ORG, login, now).run();
  }
  const decided = { action: "approved", decidedAt: now };
  await saveCard(env.DB, ORG, { id: "secret", type: "approval", title: "Budget layoffs", sourceInstruction: "Budget layoffs plan", status: "approved", priority: "high", createdAt: now,
    recipientUserID: "owner", senderUserID: "owner", business: "board", decision: decided });
  await saveCard(env.DB, ORG, { id: "open", type: "approval", title: "Budget offsite", sourceInstruction: "Budget offsite plan", status: "approved", priority: "high", createdAt: now,
    recipientUserID: "owner", senderUserID: "owner", decision: decided });
  await env.DB.prepare("UPDATE cards SET decided_at = ?2 WHERE org_id = ?1").bind(ORG, now).run();
});

const cardIds = (snapshot) => JSON.stringify(snapshot);

test("a socket outside a private channel is not handed its cards when it joins", async () => {
  const { messages: out } = await joined(ORG, outsider);
  const { messages: inside } = await joined(ORG, insider);
  const snapshot = (messages) => cardIds(messages.find((m) => m.type === "STATE_SNAPSHOT"));
  expect(snapshot(out)).toContain("Budget offsite");
  expect(snapshot(out)).not.toContain("Budget layoffs");
  expect(snapshot(inside)).toContain("Budget layoffs");
});

test("a card made in a private channel is heard by its members, not the whole workspace", async () => {
  const { ws } = await joined(ORG, owner);
  const { messages: inside } = await joined(ORG, insider);
  const { messages: out } = await joined(ORG, outsider);
  const send = (card) => ws.send(JSON.stringify({ type: "card_created", payload: { card: {
    type: "approval", status: "pending", priority: "high", createdAt: new Date().toISOString(), senderUserID: "owner", ...card,
  } } }));

  send({ id: "c-board", recipientUserID: "owner", title: "Close the Osaka office", business: "board" });
  expect(await message(inside, (m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("Close the Osaka office"))).toBeTruthy();

  // A public card after it: once the outsider has heard that one, they would
  // have heard the first.
  send({ id: "c-open", recipientUserID: "owner", title: "Order team lunch" });
  expect(await message(out, (m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("Order team lunch"))).toBeTruthy();
  expect(JSON.stringify(out)).not.toContain("Close the Osaka office");
});

test("a decision lookup that cannot say who it is for leaves a private channel out", async () => {
  const titles = (hits) => hits.map((h) => h.title);
  expect(titles(await searchDecisions(env.DB, ORG, "Budget"))).toEqual(["Budget offsite"]);
  expect(titles(await recentDecisions(env.DB, ORG))).toEqual(["Budget offsite"]);
  const golden = JSON.stringify(await exportGolden(env.DB, ORG));
  expect(golden).toContain("Budget offsite");
  expect(golden).not.toContain("Budget layoffs");
});

test("a decision lookup for one person finds the private channels they are in, and only those", async () => {
  const titles = async (fn, login) => (await fn(await accessFor(env.DB, ORG, login))).map((h) => h.title).sort();
  const search = (access) => searchDecisions(env.DB, ORG, "Budget", { access, viewer: access.login });
  const recent = (access) => recentDecisions(env.DB, ORG, { access });
  expect(await titles(search, "insider")).toEqual(["Budget layoffs", "Budget offsite"]);
  expect(await titles(search, "outsider")).toEqual(["Budget offsite"]);
  expect(await titles(recent, "insider")).toEqual(["Budget layoffs", "Budget offsite"]);
  expect(await titles(recent, "outsider")).toEqual(["Budget offsite"]);
});
