// Email connector tests: unit (parser/triage/signature) + integration
// (spawn the relay, POST a real webhook, assert it broadcasts a card).
// Run with `npm test` from server/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import WebSocket from "ws";

import { parseEmailMessage, validateMailgunSignature } from "../connectors/email.js";
import { triageEmail } from "../connectors/email-triage.js";
import { createEmailDecisionCard } from "../connectors/email-handler.js";
import { wasAlreadyIngested, markIngested } from "../connectors/email-dedup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 18642;

function rawEmail({ from = "bob@example.com", subject, body, messageId }) {
  return [
    `From: ${from}`,
    `To: honmaru@mailgun.org`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    ``,
    body,
  ].join("\r\n");
}

/* ---------------- unit: parser ---------------- */

test("parseEmailMessage extracts from/subject/body/messageId", async () => {
  const parsed = await parseEmailMessage(
    rawEmail({ subject: "Review design", body: "Can you review this?", messageId: "unit-1@example.com" })
  );
  assert.equal(parsed.from, "bob@example.com");
  assert.equal(parsed.subject, "Review design");
  assert.match(parsed.textBody, /Can you review this\?/);
  assert.equal(parsed.messageId, "<unit-1@example.com>");
});

/* ---------------- unit: triage ---------------- */

test("triageEmail flags a decision request", async () => {
  const result = await triageEmail("Review design proposal", "Can you please review the new design?");
  assert.equal(result.needs_decision, true);
});

test("triageEmail does not flag an FYI even when it contains 'need'", async () => {
  const result = await triageEmail("FYI: budget is final", "Just letting you know, no action needed.");
  assert.equal(result.needs_decision, false);
});

test("triageEmail does not flag 'due to' as a deadline (high priority)", async () => {
  const result = await triageEmail("Status update", "The delay is due to a vendor issue, nothing needed from you.");
  assert.notEqual(result.priority, "high");
});

test("triageEmail flags an explicit deadline phrasing as high priority", async () => {
  const result = await triageEmail("Please review", "Can you review this? It's due by Friday.");
  assert.equal(result.priority, "high");
});

test("triageEmail only classifies the new content, not an FYI phrase buried in a quoted reply", async () => {
  const body = [
    "Can you please approve the attached budget?",
    "",
    "On Mon, Aug 10, 2026 at 9:00 AM Bob wrote:",
    "> just letting you know the previous budget was fyi only, no action needed.",
  ].join("\n");
  const result = await triageEmail("Approve budget", body);
  assert.equal(result.needs_decision, true, "the new content above the quote is a real decision request");
});

test("triageEmail does not flag a decision keyword that only appears in a quoted reply", async () => {
  const body = [
    "Thanks, got it — no need to do anything else on my end.",
    "",
    "-----Original Message-----",
    "Can you please review and approve this today?",
  ].join("\n");
  const result = await triageEmail("Re: budget", body);
  assert.equal(result.needs_decision, false, "the decision keyword only appears in the quoted original, not the reply");
});

/* ---------------- unit: signature validation ---------------- */

// process.env is global mutable state; every test that touches
// MAILGUN_WEBHOOK_SIGNING_KEY or ALLOW_UNSIGNED_EMAIL_WEBHOOK restores it via
// t.after so tests don't depend on run order.
function withEnv(t, vars) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    // Assigning `undefined` via process.env[key] = undefined stringifies to
    // "undefined" rather than unsetting it — must delete instead.
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

function freshTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

function sign(key, timestamp, token) {
  return crypto.createHmac("sha256", key).update(`${timestamp}${token}`).digest("hex");
}

test("validateMailgunSignature rejects a forged signature", (t) => {
  withEnv(t, { MAILGUN_WEBHOOK_SIGNING_KEY: "test-signing-key" });
  assert.equal(validateMailgunSignature(freshTimestamp(), "tok-forged-test", "forged"), false);
});

test("validateMailgunSignature accepts a genuine signature", (t) => {
  withEnv(t, { MAILGUN_WEBHOOK_SIGNING_KEY: "test-signing-key" });
  const timestamp = freshTimestamp();
  const signature = sign("test-signing-key", timestamp, "tok-genuine-test");
  assert.equal(validateMailgunSignature(timestamp, "tok-genuine-test", signature), true);
});

test("validateMailgunSignature rejects a replayed token even with a correct signature", (t) => {
  withEnv(t, { MAILGUN_WEBHOOK_SIGNING_KEY: "test-signing-key" });
  const timestamp = freshTimestamp();
  const signature = sign("test-signing-key", timestamp, "tok-replay-test");
  assert.equal(validateMailgunSignature(timestamp, "tok-replay-test", signature), true, "first use succeeds");
  assert.equal(validateMailgunSignature(timestamp, "tok-replay-test", signature), false, "replay is rejected");
});

test("validateMailgunSignature rejects a stale timestamp even with a correct signature", (t) => {
  withEnv(t, { MAILGUN_WEBHOOK_SIGNING_KEY: "test-signing-key" });
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 60 * 60); // 1h old
  const signature = sign("test-signing-key", staleTimestamp, "tok-stale-test");
  assert.equal(validateMailgunSignature(staleTimestamp, "tok-stale-test", signature), false);
});

test("validateMailgunSignature rejects a signed request when no signing key is configured", (t) => {
  withEnv(t, { MAILGUN_WEBHOOK_SIGNING_KEY: undefined });
  assert.equal(validateMailgunSignature(freshTimestamp(), "tok", "anything"), false);
});

test("validateMailgunSignature rejects a request with no signature fields by default", (t) => {
  withEnv(t, { ALLOW_UNSIGNED_EMAIL_WEBHOOK: undefined });
  assert.equal(validateMailgunSignature(undefined, undefined, undefined), false);
});

test("validateMailgunSignature allows a request with no signature fields when explicitly opted in", (t) => {
  withEnv(t, { ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" });
  assert.equal(validateMailgunSignature(undefined, undefined, undefined), true);
});

test("validateMailgunSignature rejects a partial signature (some fields present, not all)", () => {
  assert.equal(validateMailgunSignature(freshTimestamp(), "tok", undefined), false);
  assert.equal(validateMailgunSignature(undefined, "tok", "sig"), false);
});

/* ---------------- unit: dedup ---------------- */

test("email-dedup: same hash is only reported as ingested after markIngested", () => {
  const hash = `dedup-unit-${Date.now()}`;
  assert.equal(wasAlreadyIngested("core-team", hash), false);
  markIngested("core-team", hash);
  assert.equal(wasAlreadyIngested("core-team", hash), true);
});

test("email-dedup: same hash in a different org is independent", () => {
  const hash = `dedup-unit-cross-org-${Date.now()}`;
  markIngested("org-a", hash);
  assert.equal(wasAlreadyIngested("org-a", hash), true);
  assert.equal(wasAlreadyIngested("org-b", hash), false);
});

/* ---------------- unit: card creation ---------------- */

test("createEmailDecisionCard builds a DecisionCard-shaped card for a decision email", async () => {
  const parsed = await parseEmailMessage(
    rawEmail({ subject: "Approve new feature", body: "Please approve the release.", messageId: "unit-2@example.com" })
  );
  const card = await createEmailDecisionCard(parsed, "core-team", { recipientUserID: "user-alice" });
  assert.ok(card, "card should be created");
  assert.equal(card.recipientUserID, "user-alice");
  assert.equal(card.status, "pending");
  assert.equal(card.sourceApp, "Email");
  assert.equal(card.sourceDetail, "bob@example.com");
});

test("createEmailDecisionCard returns null for a non-decision email", async () => {
  const parsed = await parseEmailMessage(
    rawEmail({ subject: "FYI", body: "No action needed.", messageId: "unit-3@example.com" })
  );
  const card = await createEmailDecisionCard(parsed, "core-team", { recipientUserID: "user-alice" });
  assert.equal(card, null);
});

test("createEmailDecisionCard rejects without a resolved recipient (caller bug, not a triage outcome)", async () => {
  const parsed = await parseEmailMessage(
    rawEmail({ subject: "Approve new feature", body: "Please approve.", messageId: "unit-4@example.com" })
  );
  // No recipientUserID provided — the caller (org lookup) is responsible for
  // resolving one. This must throw, not quietly return null like a normal
  // "not a decision" outcome would — the two are different failure modes.
  await assert.rejects(() => createEmailDecisionCard(parsed, "core-team", {}), /recipientUserID/);
});

/* ---------------- integration: webhook -> relay -> WebSocket ---------------- */

function startRelay(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, "..", "index.js")], {
      env: { ...process.env, PORT: String(PORT), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Relay listening")) resolve(child);
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("relay did not start")), 5000);
  });
}

function connectAndCollect(userId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", payload: { userId, orgId: "core-team" } }));
      setTimeout(() => resolve({ ws, received }), 150);
    });
    ws.on("error", reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("POST /webhooks/email broadcasts a card_created for a decision email", async () => {
  const relay = await startRelay({ ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" });
  try {
    const alice = await connectAndCollect("user-alice");
    alice.received.length = 0;

    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: rawEmail({
          subject: "Please approve the Q3 budget",
          body: "Can you approve the attached Q3 budget by Friday?",
          messageId: `int-${Date.now()}@example.com`,
        }),
      }),
    });
    assert.equal(res.status, 200);

    await wait(300);
    const created = alice.received.find(
      (m) => m.type === "card_created" && m.payload?.card?.title === "Please approve the Q3 budget"
    );
    assert.ok(created, "expected a card_created broadcast");
    assert.equal(created.payload.card.status, "pending");
    assert.equal(created.payload.card.sourceApp, "Email");

    alice.ws.close();
  } finally {
    relay.kill();
  }
});

test("POST /webhooks/email does not broadcast a card for an FYI email", async () => {
  const relay = await startRelay({ ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" });
  try {
    const alice = await connectAndCollect("user-alice");
    alice.received.length = 0;

    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: rawEmail({
          subject: "FYI budget is final",
          body: "Just letting you know the budget is finalized, no action needed.",
          messageId: `int-fyi-${Date.now()}@example.com`,
        }),
      }),
    });
    assert.equal(res.status, 200);

    await wait(300);
    const created = alice.received.find((m) => m.type === "card_created");
    assert.equal(created, undefined, "FYI email should not create a card");

    alice.ws.close();
  } finally {
    relay.kill();
  }
});

test("POST /webhooks/email rejects a forged Mailgun signature", async () => {
  const relay = await startRelay({ MAILGUN_WEBHOOK_SIGNING_KEY: "test-signing-key" });
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: rawEmail({ subject: "hi", body: "body", messageId: `forged-${Date.now()}@example.com` }),
        timestamp: freshTimestamp(),
        token: "tok-forged-integration-test",
        signature: "forged",
      }),
    });
    assert.equal(res.status, 401);
  } finally {
    relay.kill();
  }
});

test("POST /webhooks/email rejects an unsigned request by default (no ALLOW_UNSIGNED_EMAIL_WEBHOOK)", async () => {
  const relay = await startRelay();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: rawEmail({ subject: "hi", body: "body", messageId: `unsigned-${Date.now()}@example.com` }),
      }),
    });
    assert.equal(res.status, 401);
  } finally {
    relay.kill();
  }
});

test("POST /webhooks/email accepts a genuinely signed request", async () => {
  const relay = await startRelay({ MAILGUN_WEBHOOK_SIGNING_KEY: "test-signing-key" });
  try {
    const alice = await connectAndCollect("user-alice");
    alice.received.length = 0;

    const timestamp = freshTimestamp();
    const token = `tok-integration-genuine-${Date.now()}`;
    const signature = sign("test-signing-key", timestamp, token);

    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: rawEmail({
          subject: "Please approve the signed request",
          body: "Can you approve this?",
          messageId: `signed-${Date.now()}@example.com`,
        }),
        timestamp,
        token,
        signature,
      }),
    });
    assert.equal(res.status, 200);

    await wait(300);
    const created = alice.received.find(
      (m) => m.type === "card_created" && m.payload?.card?.title === "Please approve the signed request"
    );
    assert.ok(created, "expected a card_created broadcast for a genuinely signed request");

    alice.ws.close();
  } finally {
    relay.kill();
  }
});

test("POST /webhooks/email ignores a redelivered email (same Message-ID) instead of creating a duplicate card", async () => {
  const relay = await startRelay({ ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" });
  try {
    const alice = await connectAndCollect("user-alice");
    alice.received.length = 0;

    const messageId = `dedup-int-${Date.now()}@example.com`;
    const body = JSON.stringify({
      raw: rawEmail({ subject: "Please approve the redelivered request", body: "Approve this?", messageId }),
    });

    const first = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).status, "received");

    await wait(300);
    const second = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).status, "duplicate");

    await wait(300);
    const createdCount = alice.received.filter(
      (m) => m.type === "card_created" && m.payload?.card?.title === "Please approve the redelivered request"
    ).length;
    assert.equal(createdCount, 1, "expected exactly one card_created, not one per delivery");

    alice.ws.close();
  } finally {
    relay.kill();
  }
});

test("POST /webhooks/email parses a multipart/form-data payload (attachments arrive this way from real Mailgun)", async () => {
  const relay = await startRelay({ ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" });
  try {
    const alice = await connectAndCollect("user-alice");
    alice.received.length = 0;

    const form = new FormData();
    form.append(
      "body-mime",
      rawEmail({
        subject: "Please approve the multipart request",
        body: "Can you approve this?",
        messageId: `multipart-${Date.now()}@example.com`,
      })
    );
    // A real Mailgun multipart payload also includes attachment file parts;
    // this stands in for one to confirm they're drained, not choked on.
    form.append("attachment-1", new Blob(["fake pdf bytes"], { type: "application/pdf" }), "invoice.pdf");

    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, { method: "POST", body: form });
    assert.equal(res.status, 200);

    await wait(300);
    const created = alice.received.find(
      (m) => m.type === "card_created" && m.payload?.card?.title === "Please approve the multipart request"
    );
    assert.ok(created, "expected a card_created broadcast from a multipart request");

    alice.ws.close();
  } finally {
    relay.kill();
  }
});

test("POST /webhooks/email rejects a body larger than the configured cap", async () => {
  const relay = await startRelay({ ALLOW_UNSIGNED_EMAIL_WEBHOOK: "1" });
  try {
    const oversizedBody = JSON.stringify({ raw: "x".repeat(6 * 1024 * 1024) }); // cap is 5 MiB
    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    assert.equal(res.status, 413);
  } finally {
    relay.kill();
  }
});
