import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertUser, upsertMembership } from "../src/db.js";
import { githubIdFromAddress, inboundAddressFor, verifyMailgunWebhook } from "../src/connectors/email.js";

const SIGNING_KEY = "mailgun-test-key";
const CONFIGURED = {
  ...env,
  ORG_RELAY: undefined, // the harness cannot follow a hand-made env into a Durable Object
  OPENAI_API_KEY: "sk-test",
  MAILGUN_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
  INBOUND_EMAIL_DOMAIN: "in.honmaru.ai",
};
const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), CONFIGURED) };

async function sign(timestamp, token) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}${token}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let nonce = 0;
async function post(overrides = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = `tok-${nonce++}`;
  const body = {
    timestamp, token, signature: await sign(timestamp, token),
    recipient: "u-4242@in.honmaru.ai",
    sender: "billing@acme.com",
    subject: "Invoice #42 needs approval",
    "stripped-text": "Please approve the attached invoice by Friday.",
    "Message-Id": `<m-${nonce}@acme.com>`,
    ...overrides,
  };
  return SELF.fetch("https://example.com/webhooks/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const triageReply = (content) =>
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }));

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "4242", login: "octocat", name: "Octo", avatarUrl: "", locale: "en" });
  await upsertMembership(env.DB, "acme/web", "4242", "Engineer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a signed message that needs a decision becomes a card for the addressee", async () => {
  triageReply({
    needsDecision: true, cardType: "approval", title: "Approve invoice 42",
    summary: "Billing is waiting.", context: "amount: 42", priority: "high",
  });

  const res = await post();
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("card created");

  const row = await env.DB
    .prepare("SELECT recipient_user_id, data FROM cards WHERE org_id='acme/web' ORDER BY created_at DESC LIMIT 1")
    .first();
  expect(row.recipient_user_id).toBe("octocat");
  expect(JSON.parse(row.data).sourceApp).toBe("Email");
});

test("mail that needs nothing is recorded and creates no card", async () => {
  triageReply({ needsDecision: false });
  const res = await post({ subject: "Your receipt", "Message-Id": "<receipt@acme.com>" });
  expect((await res.json()).status).toBe("no decision needed");
});

// The reference relay allowed a request carrying no signature fields, which
// meant anyone who knew the URL could put an approval card in someone's feed.
test("an unsigned request is refused", async () => {
  const res = await SELF.fetch("https://example.com/webhooks/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: "u-4242@in.honmaru.ai", sender: "a@b.com", subject: "hi" }),
  });
  expect(res.status).toBe(401);
});

test("a forged signature is refused", async () => {
  const res = await post({ signature: "deadbeef" });
  expect(res.status).toBe(401);
});

// The signature covers timestamp and token, never the body — so without this a
// captured request could be replayed with different mail attached.
test("a replayed token is refused even though its signature is genuine", async () => {
  triageReply({ needsDecision: false });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = "tok-replay";
  const signature = await sign(timestamp, token);
  const send = () => SELF.fetch("https://example.com/webhooks/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timestamp, token, signature, recipient: "u-4242@in.honmaru.ai",
      sender: "a@b.com", subject: "Replay me", "stripped-text": "hi",
      "Message-Id": "<replay@acme.com>",
    }),
  });

  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(401);
});

test("a stale timestamp is refused", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000) - 60 * 60);
  const token = "tok-stale";
  const res = await post({ timestamp, token, signature: await sign(timestamp, token) });
  expect(res.status).toBe(401);
});

// The reference relay sent every email to "the first user in the org's store" —
// insertion order, so the same message could reach different people depending
// on what the process happened to have seen.
test("an address that names nobody is accepted and dropped, not routed at random", async () => {
  const res = await post({ recipient: "hello@in.honmaru.ai", "Message-Id": "<nobody@acme.com>" });
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("unroutable");
});

test("the same message delivered twice makes one card", async () => {
  triageReply({ needsDecision: false });
  const id = "<twice@acme.com>";
  expect((await post({ "Message-Id": id })).status).toBe(200);
  const second = await post({ "Message-Id": id });
  expect((await second.json()).status).toBe("duplicate");
});

test("the inbound address names its owner", () => {
  expect(inboundAddressFor({ INBOUND_EMAIL_DOMAIN: "in.honmaru.ai" }, "4242")).toBe("u-4242@in.honmaru.ai");
  expect(githubIdFromAddress("u-4242@in.honmaru.ai")).toBe("4242");
  expect(githubIdFromAddress("support@in.honmaru.ai")).toBeNull();
});

// The escape hatch exists so the handler can be exercised locally. The one way
// it could do real harm is by being left on somewhere that receives real mail —
// where, by definition, the signing key is set.
test("unsigned traffic is refused outright by a deployment that has a signing key", async () => {
  const optedIn = { ...CONFIGURED, ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" };
  expect(await verifyMailgunWebhook(optedIn, {})).toBe(false);
});

test("and is allowed on a deployment that has none, when asked for", async () => {
  const local = { ...CONFIGURED, MAILGUN_WEBHOOK_SIGNING_KEY: undefined };
  expect(await verifyMailgunWebhook(local, {})).toBe(false);
  expect(await verifyMailgunWebhook({ ...local, ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" }, {})).toBe(true);
});

test("GET /connectors/email/address tells a signed-in user where to send mail", async () => {
  const token = await createSession(env.DB, "4242", "gho_email");
  const res = await SELF.fetch("https://example.com/connectors/email/address", {
    headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).address).toBe("u-4242@in.honmaru.ai");
});


// A stranger with an address is not a colleague with a session. The inbound
// address is guessable — `u-<github id>` at a known domain, and the id is
// public — so until this happened, anyone could put an approval card at the
// front of someone's feed, with a title and a priority of their choosing, and a
// push notification to match.
test("an unvouched-for sender gets an update to read, never an approval", async () => {
  triageReply({
    needsDecision: true, cardType: "approval", title: "Wire the payment today",
    summary: "Urgent.", context: "", priority: "urgent",
  });

  await post({ sender: "stranger@example.net", "Message-Id": "<stranger-1@x>" });

  const card = JSON.parse(
    (await env.DB
      .prepare("SELECT data FROM cards WHERE org_id='acme/web' ORDER BY created_at DESC LIMIT 1")
      .first()).data
  );
  expect(card.type).toBe("notification");
  expect(card.priority).toBe("low");
  expect(card.sourceDetail).toContain("Unverified sender");
});

test("and once they are vouched for, their mail can ask for a decision", async () => {
  await env.DB
    .prepare(
      `INSERT INTO email_senders (user_github_id, address, trusted, first_seen_at, last_seen_at)
       VALUES ('4242', 'billing@acme.com', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
       ON CONFLICT(user_github_id, address) DO UPDATE SET trusted = 1`
    )
    .run();
  triageReply({
    needsDecision: true, cardType: "approval", title: "Approve invoice 43",
    summary: "Billing is waiting.", context: "", priority: "high",
  });

  await post({ "Message-Id": "<trusted-1@acme.com>" });

  const card = JSON.parse(
    (await env.DB
      .prepare("SELECT data FROM cards WHERE org_id='acme/web' ORDER BY created_at DESC LIMIT 1")
      .first()).data
  );
  expect(card.type).toBe("approval");
  expect(card.priority).toBe("high");
  expect(card.sourceDetail).not.toContain("Unverified");
});

// Without a ceiling the address is a way to fill someone's feed and spend
// their AI allowance doing it.
test("one person's inbound address has a daily ceiling", async () => {
  const { MAX_EMAILS_PER_DAY } = await import("../src/connectors/email.js");
  const today = new Date().toISOString();
  const rows = [];
  for (let i = 0; i < MAX_EMAILS_PER_DAY; i += 1) {
    rows.push(
      env.DB
        .prepare(
          `INSERT INTO ingested_items (connector, external_id, user_github_id, org_id, card_id, created_at)
           VALUES ('email', ?1, '4242', 'acme/web', NULL, ?2)`
        )
        .bind(`flood-${i}`, today)
    );
  }
  await env.DB.batch(rows);

  // No interceptor: the model must never be called for a message over the line.
  const res = await post({ "Message-Id": "<over-the-line@x>" });
  expect((await res.json()).status).toBe("daily limit reached");
});
