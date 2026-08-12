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

/* ---------------- unit: signature validation ---------------- */

test("validateMailgunSignature rejects a forged signature", () => {
  process.env.MAILGUN_WEBHOOK_SIGNING_KEY = "test-signing-key";
  assert.equal(validateMailgunSignature("123", "tok", "forged"), false);
});

test("validateMailgunSignature accepts a genuine signature", () => {
  process.env.MAILGUN_WEBHOOK_SIGNING_KEY = "test-signing-key";
  const signature = crypto
    .createHmac("sha256", "test-signing-key")
    .update("123tok")
    .digest("hex");
  assert.equal(validateMailgunSignature("123", "tok", signature), true);
});

test("validateMailgunSignature allows a request with no signature fields (local/manual test traffic)", () => {
  assert.equal(validateMailgunSignature(undefined, undefined, undefined), true);
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
  const relay = await startRelay();
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
  const relay = await startRelay();
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
        timestamp: "123",
        token: "tok",
        signature: "forged",
      }),
    });
    assert.equal(res.status, 401);
  } finally {
    relay.kill();
  }
});
