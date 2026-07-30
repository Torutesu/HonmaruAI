import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature, cardsFromWebhook } from "../githubWebhook.js";
import { createOrgStore } from "../org.js";
import { translateCard } from "../translate.js";
import { interpretReplyLocally } from "../agentTools.js";

const org = createOrgStore(null);

test("signature: valid HMAC passes, wrong one fails, no secret is dev-open", () => {
  const secret = "hook-secret";
  const payload = '{"a":1}';
  const good = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(verifyWebhookSignature({ payload, signature: good, secret }), true);
  assert.equal(
    verifyWebhookSignature({ payload, signature: "sha256=" + "0".repeat(64), secret }),
    false
  );
  assert.equal(verifyWebhookSignature({ payload, signature: undefined, secret }), false);
  assert.equal(verifyWebhookSignature({ payload, signature: undefined, secret: "" }), true);
});

test("review_requested becomes a high-priority approval card for the reviewer", () => {
  const cards = cardsFromWebhook({
    event: "pull_request",
    payload: {
      action: "review_requested",
      repository: { full_name: "torutesu/honmaruai" },
      sender: { login: "alice" },
      requested_reviewer: { login: "bob" },
      pull_request: { number: 12, title: "Relay deploy config", html_url: "https://github.com/x/pull/12", head: { ref: "deploy" } },
    },
    orgStore: org,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].recipientUserID, "user-bob");
  assert.equal(cards[0].senderUserID, "user-alice");
  assert.equal(cards[0].priority, "high");
  assert.ok(cards[0].title.includes("PR #12"));
});

test("issue assigned becomes a task card; unknown login is dropped", () => {
  const assigned = cardsFromWebhook({
    event: "issues",
    payload: {
      action: "assigned",
      repository: { full_name: "torutesu/honmaruai" },
      sender: { login: "dana" },
      assignee: { login: "carol" },
      issue: { number: 44, title: "Polish empty states", html_url: "u", labels: [{ name: "design" }] },
    },
    orgStore: org,
  });
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].recipientUserID, "user-carol");
  assert.ok(assigned[0].context.includes("design"));

  const unknown = cardsFromWebhook({
    event: "issues",
    payload: {
      action: "assigned",
      repository: { full_name: "x/y" },
      assignee: { login: "stranger" },
      issue: { number: 1, title: "t", html_url: "u" },
    },
    orgStore: org,
  });
  assert.equal(unknown.length, 0);
});

test("failed workflow_run becomes a CI card for the actor", () => {
  const cards = cardsFromWebhook({
    event: "workflow_run",
    payload: {
      action: "completed",
      repository: { full_name: "torutesu/honmaruai" },
      sender: { login: "bob" },
      workflow_run: { conclusion: "failure", name: "tests", head_branch: "main", html_url: "u", actor: { login: "bob" } },
    },
    orgStore: org,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].recipientUserID, "user-bob");
  assert.equal(cards[0].priority, "high");
  assert.ok(cards[0].title.startsWith("CI failed"));

  const success = cardsFromWebhook({
    event: "workflow_run",
    payload: {
      action: "completed",
      repository: { full_name: "x/y" },
      workflow_run: { conclusion: "success", actor: { login: "bob" } },
    },
    orgStore: org,
  });
  assert.equal(success.length, 0);
});

test("translation passes cards through untouched without an AI key", async () => {
  const card = { title: "T", summary: "S", context: "c", recipientUserID: "user-bob" };
  const same = await translateCard({ card, targetLanguage: "日本語", openRouter: null });
  assert.deepEqual(same, card);
  const noTarget = await translateCard({ card, targetLanguage: null, openRouter: { apiKey: "x" } });
  assert.deepEqual(noTarget, card);
});

test("org language: defaults, set, addMember", () => {
  const store = createOrgStore(null);
  assert.equal(store.findUser("user-alice").language, "en");
  assert.equal(store.setLanguage("user-alice", "日本語"), true);
  assert.equal(store.findUser("user-alice").language, "日本語");
  assert.equal(store.setLanguage("user-nobody", "ja"), false);
  assert.equal(store.setLanguage("user-alice", "  "), false);

  const user = store.addMember({ name: "Yuki", role: "CEO", language: "ja" });
  assert.equal(user.language, "ja");
});

test("Japanese replies interpret offline", () => {
  assert.equal(interpretReplyLocally({ reply: "承認。ただしリリースは金曜以降で" }).action, "approve");
  assert.ok(interpretReplyLocally({ reply: "承認。ただしリリースは金曜以降で" }).note.includes("リリース"));
  assert.equal(interpretReplyLocally({ reply: "却下。予算がない" }).action, "reject");
  assert.equal(interpretReplyLocally({ reply: "認証チームの確認は済んでる？" }).action, "question");
  assert.equal(interpretReplyLocally({ reply: "二つに分割して再送して" }).action, "revise");
});
