import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { buildRecord, recordToMarkdown } from "../src/record.js";
import { joined, message, until } from "./helpers.js";

// The minimum documentation: what was decided, per business, written by
// nobody. A view over the cards, so it is never stale.

const ORG = "acme/holdings";
let ownerToken;
let memberToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7301", login: "owner", name: "Owner", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "7302", login: "member", name: "Member", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "7303", login: "stranger", name: "S", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "7301", "admin");
  await upsertMembership(env.DB, ORG, "7302", "member");
  ownerToken = await createSession(env.DB, "7301", "gho_owner");
  memberToken = await createSession(env.DB, "7302", "gho_member");
  globalThis.__stranger = await createSession(env.DB, "7303", "gho_stranger");
});

async function seed() {
  const { saveCard, upsertBusiness } = await import("../src/db.js");
  await upsertBusiness(env.DB, ORG, { name: "Hotel 本丸" });
  await upsertBusiness(env.DB, ORG, { name: "Cafe Sakura" });
  await saveCard(env.DB, ORG, {
    id: "r1", recipientUserID: "member", senderUserID: "owner", type: "approval", status: "approved", priority: "high",
    title: "Approve the lease", createdAt: "2026-09-01T00:00:00Z", business: "hotel-本丸",
    localized: { ja: { title: "賃貸契約の承認" } },
    decision: { action: "approve", actorUserID: "member", decidedAt: "2026-09-02T10:00:00Z", note: "Two floors only" },
  });
  await saveCard(env.DB, ORG, {
    id: "r2", recipientUserID: "owner", senderUserID: "member", type: "task", status: "pending", priority: "medium",
    title: "Fix the booking form", createdAt: "2026-09-03T00:00:00Z", business: "hotel-本丸",
  });
  await saveCard(env.DB, ORG, {
    id: "r3", recipientUserID: "owner", senderUserID: "owner", type: "notification", status: "completed", priority: "low",
    title: "Invoice #42", createdAt: "2026-09-04T00:00:00Z",
    decision: { action: "acknowledge", actorUserID: "owner", decidedAt: "2026-09-05T10:00:00Z" },
  });
}

test("the record groups decisions and open items by business, in the reader's language", async () => {
  await seed();
  const record = await buildRecord(env.DB, ORG, { locale: "ja" });
  expect(record.businesses.map((b) => b.slug)).toEqual(["hotel-本丸", "cafe-sakura", ""]);
  const hotel = record.businesses[0];
  expect(hotel.name).toBe("Hotel 本丸");
  expect(hotel.decided).toHaveLength(1);
  expect(hotel.decided[0]).toMatchObject({ title: "賃貸契約の承認", actionLabel: "承認", actor: "member", note: "Two floors only" });
  expect(hotel.open.map((c) => c.title)).toEqual(["Fix the booking form"]);
  // A business with nothing yet still appears: it exists.
  expect(record.businesses[1]).toMatchObject({ name: "Cafe Sakura", decided: [], open: [] });
  // The unfiled card is last, under no name.
  expect(record.businesses[2]).toMatchObject({ slug: "", name: null });
  expect(record.businesses[2].decided[0].title).toBe("Invoice #42");

  const md = recordToMarkdown(record, "ja");
  expect(md).toContain("# 決定の記録 · acme/holdings");
  expect(md).toContain("## Hotel 本丸");
  expect(md).toContain("- **2026-09-02** 賃貸契約の承認 — 承認 決定者 member — “Two floors only”");
  expect(md).toContain("- [ ] Fix the booking form — 待ち owner · 2026-09-03");
  expect(md).toContain("## 未分類");
});

test("GET /record is for members, in JSON or Markdown", async () => {
  await seed();
  const denied = await SELF.fetch(`https://example.com/record?orgId=${encodeURIComponent(ORG)}`, { headers: { "x-session-token": globalThis.__stranger } });
  expect(denied.status).toBe(403);

  const res = await SELF.fetch(`https://example.com/record?orgId=${encodeURIComponent(ORG)}`, { headers: { "x-session-token": memberToken } });
  expect(res.status).toBe(200);
  const body = await res.json();
  // member reads English: the original title, not the Japanese version.
  expect(body.businesses[0].decided[0].title).toBe("Approve the lease");

  const md = await SELF.fetch(`https://example.com/record?orgId=${encodeURIComponent(ORG)}&format=md`, { headers: { "x-session-token": ownerToken } });
  expect(md.headers.get("content-type")).toContain("text/markdown");
  expect(await md.text()).toContain("# 決定の記録");
});

test("a client that republishes a card cannot erase what the relay added to it", async () => {
  const { saveCard, getCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, {
    id: "keep-1", recipientUserID: "member", senderUserID: "owner", type: "approval", status: "pending", priority: "medium",
    title: "Approve the thing", createdAt: "2026-09-06T00:00:00Z",
    business: "hotel-本丸", localized: { en: { title: "Approve the thing (en)" } },
  });
  const member = await joined(ORG, memberToken);
  // What the iOS client sends on a decision: its whole local copy, which
  // never knew about `localized`.
  member.ws.send(JSON.stringify({
    type: "card_updated",
    payload: { card: {
      id: "keep-1", recipientUserID: "member", senderUserID: "owner", type: "approval", status: "approved", priority: "medium",
      title: "Approve the thing", createdAt: "2026-09-06T00:00:00Z",
      decision: { action: "approve", actorUserID: "member", decidedAt: "2026-09-06T01:00:00Z" },
    } },
  }));
  expect(await until(async () => (await getCard(env.DB, ORG, "keep-1"))?.status === "approved")).toBeTruthy();
  const stored = await getCard(env.DB, ORG, "keep-1");
  expect(stored.localized).toEqual({ en: { title: "Approve the thing (en)" } });
  expect(stored.business).toBe("hotel-本丸");
});

test("the card carries who asked and what the AI advised, and a republish keeps both", async () => {
  // Both are rendered on the card itself, so both have to survive the iOS
  // client republishing its whole local copy when a decision is made — the
  // same rule the translation and the business already follow.
  const alice = await joined(ORG, ownerToken);
  const bob = await joined(ORG, memberToken);

  alice.ws.send(JSON.stringify({
    type: "card_created",
    payload: { card: {
      id: "card-who", type: "approval", status: "pending", recipientUserID: "member",
      title: "Approve the reshoot", summary: "The onboarding video needs recutting.",
      priority: "high", createdAt: new Date().toISOString(),
      sourceInstruction: "We need to reshoot the onboarding video.",
      recommendation: { action: "approve", reason: "It is under the quarter's budget." },
      // A client may not name someone else as the requester.
      requestedBy: { name: "Someone Else", role: "ceo" },
    } },
  }));
  expect(await message(bob.messages, (m) => JSON.stringify(m).includes("card-who"))).toBeTruthy();

  const { getCard } = await import("../src/db.js");
  const stored = await until(async () => {
    const c = await getCard(env.DB, ORG, "card-who");
    return c?.requestedBy ? c : null;
  });
  // Stamped from the membership table, not from what the client claimed.
  expect(stored.requestedBy).toMatchObject({ login: "owner", name: "Owner", role: "admin" });
  expect(stored.recommendation).toEqual({ action: "approve", reason: "It is under the quarter's budget." });

  // Bob decides by republishing the whole card, as the iOS client does, with
  // no idea either field exists.
  bob.ws.send(JSON.stringify({
    type: "card_updated",
    payload: { card: {
      id: "card-who", type: "approval", status: "approved", recipientUserID: "member",
      title: "Approve the reshoot", summary: "The onboarding video needs recutting.",
      priority: "high", createdAt: stored.createdAt,
      decision: { action: "approve", actorUserID: "member", decidedAt: new Date().toISOString() },
    } },
  }));
  const after = await until(async () => {
    const c = await getCard(env.DB, ORG, "card-who");
    return c?.decision?.action ? c : null;
  });
  expect(after.requestedBy).toMatchObject({ login: "owner", name: "Owner" });
  expect(after.recommendation).toMatchObject({ action: "approve" });
});
