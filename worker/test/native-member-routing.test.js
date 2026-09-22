import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import worker from "../src/index.js";
import { createSession, upsertUser, upsertMembership, getCard } from "../src/db.js";
import { EMAIL_AUTH_TOKEN } from "../src/auth.js";
import { memberRef } from "../src/team.js";
import { joined, message, until } from "./helpers.js";

const ORG = "personal:native-routing";
const OTHER = "personal:other-routing";
let token, ref;
beforeEach(async () => {
  for (const [id, login, name, org] of [
    ["email:alice@example.com", "u:alice@example.com", "Alice", ORG],
    ["email:bob@example.com", "u:bob@example.com", "Bob", ORG],
    ["email:eve@example.com", "u:eve@example.com", "Eve", OTHER],
  ]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, org, id, "admin");
  }
  token = await createSession(env.DB, "email:alice@example.com", EMAIL_AUTH_TOKEN);
  ref = await memberRef(ORG, "email:bob@example.com");
});

const request = (body, auth = token) => worker.fetch(new Request("https://example.com/ai/route", {
  method: "POST", headers: { "content-type": "application/json", ...(auth ? { "x-session-token": auth } : {}) },
  body: JSON.stringify({ text: "Ask Alice to approve the launch", sender: { id: "u:alice@example.com", name: "Alice" },
    orgId: ORG, organization: { nodes: [], edges: [] }, memberReferences: true, ...body }),
}), env);

test("directory remains private while an explicitly selected ref wins over text mentioning another member", async () => {
  const directory = await worker.fetch(new Request(`https://example.com/members?orgId=${ORG}`, {
    headers: { "x-session-token": token },
  }), env);
  const body = await directory.json();
  expect(JSON.stringify(body)).not.toContain("@example.com");
  expect(body.members.find(m => m.name === "Bob").ref).toBe(ref);
  const response = await request({ recipientUserID: `member:${ref}` });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.recipientUserID).toBe(`member:${ref}`);
  expect(result.routingReason).toBe("Selected by you");
});

test("opaque references are scoped to the current workspace", async () => {
  const foreignRef = await memberRef(OTHER, "email:eve@example.com");
  expect((await request({ recipientUserID: `member:${foreignRef}` })).status).toBe(400);
  expect((await request({ orgId: OTHER, recipientUserID: `member:${foreignRef}` })).status).toBe(403);
  expect((await request({ recipientUserID: `member:${ref}` }, null)).status).toBe(401);
});

test("a legacy route still returns the legacy login", async () => {
  const response = await request({ recipientUserID: "u:bob@example.com", memberReferences: false });
  expect(response.status).toBe(200);
  expect((await response.json()).recipientUserID).toBe("u:bob@example.com");
});

test("an automatic modern route returns a current member reference or the caller's own identity", async () => {
  const response = await request({ text: "Ask Bob to review the launch" });
  expect(response.status).toBe(200);
  expect((await response.json()).recipientUserID).toBe(`member:${ref}`);
});

const card = recipient => ({ id: crypto.randomUUID(), recipientUserID: recipient, senderUserID: "forged-sender",
  type: "approval", status: "pending", priority: "medium", title: "Launch review", summary: "Please review", context: "",
  createdAt: new Date().toISOString() });

test("relay resolves a reference, stamps the sender, and echoes evidence the native client can match", async () => {
  const { ws, messages } = await joined(ORG, token);
  const outgoing = card(`member:${ref}`);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: outgoing } }));
  const stored = await until(() => getCard(env.DB, ORG, outgoing.id));
  expect(stored.recipientUserID).toBe("u:bob@example.com");
  expect(stored.recipientMemberRef).toBe(ref);
  expect(stored.recipientName).toBe("Bob");
  expect(stored.senderUserID).toBe("u:alice@example.com");
  expect(await message(messages, m => JSON.stringify(m).includes(ref))).toBeTruthy();
});

test("relay rejects foreign references and never stores or notifies the request", async () => {
  const { ws, messages } = await joined(ORG, token);
  const foreignRef = await memberRef(OTHER, "email:eve@example.com");
  const outgoing = card(`member:${foreignRef}`);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: outgoing } }));
  expect(await message(messages, m => m.type === "RUN_ERROR")).toBeTruthy();
  expect(await getCard(env.DB, ORG, outgoing.id)).toBeNull();
});

test("legacy callers cannot forge reference acknowledgement fields", async () => {
  const { ws } = await joined(ORG, token);
  const outgoing = { ...card("u:alice@example.com"), recipientMemberRef: ref, recipientName: "Bob" };
  ws.send(JSON.stringify({ type: "card_created", payload: { card: outgoing } }));
  const stored = await until(() => getCard(env.DB, ORG, outgoing.id));
  expect(stored.recipientMemberRef).toBeUndefined();
  expect(stored.recipientName).toBeUndefined();
});
