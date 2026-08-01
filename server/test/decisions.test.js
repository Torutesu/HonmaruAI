import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDecision,
  needsGitHubSync,
  issueTitle,
  issueBody,
  githubStateFor,
  findCard,
  DECISION_ACTIONS,
} from "../decisions.js";

const card = (overrides = {}) => ({
  id: "c1",
  recipientUserID: "user-bob",
  senderUserID: "user-alice",
  type: "task",
  title: "Fix the login bug",
  summary: "Login is broken after the deploy.",
  context: "deadline: Friday",
  status: "pending",
  priority: "high",
  createdAt: new Date().toISOString(),
  channelID: "channel-general",
  ...overrides,
});

test("approve records a condition and notifies the sender", () => {
  const subject = card();
  const { card: decided, followUps } = applyDecision({
    card: subject,
    action: "approve",
    note: "release after Friday",
    actorUserID: "user-bob",
  });

  assert.equal(decided.status, "approved");
  assert.ok(decided.context.includes("Condition: release after Friday"));
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].recipientUserID, "user-alice");
  assert.equal(followUps[0].type, "notification");
  assert.ok(followUps[0].summary.includes("Bob"));
  assert.ok(followUps[0].summary.includes("release after Friday"));
  assert.equal(followUps[0].channelID, "channel-general", "provenance carries over");
});

test("reject records the reason", () => {
  const { card: decided, followUps } = applyDecision({
    card: card(),
    action: "reject",
    note: "no budget this quarter",
    actorUserID: "user-bob",
  });
  assert.equal(decided.status, "rejected");
  assert.ok(decided.context.includes("Reason: no budget"));
  assert.ok(followUps[0].summary.includes("declined"));
});

test("revise sends back an actionable revision card", () => {
  const { card: decided, followUps } = applyDecision({
    card: card(),
    action: "revise",
    note: "split this in two",
    actorUserID: "user-bob",
  });

  assert.equal(decided.status, "revised");
  assert.equal(decided.revisionNote, "split this in two");
  assert.equal(followUps[0].type, "revision");
  assert.equal(followUps[0].revisionNote, "split this in two");
  assert.equal(followUps[0].priority, "high", "keeps urgency so it isn't lost");
  assert.ok(followUps[0].routingReason.includes("revise and resend"));
});

test("acknowledge is silent — no response card", () => {
  const { card: decided, followUps } = applyDecision({
    card: card({ type: "notification" }),
    action: "acknowledge",
    actorUserID: "user-bob",
  });
  assert.equal(decided.status, "acknowledged");
  assert.equal(followUps.length, 0);
});

test("delegate creates a card for the delegate and tells the sender", () => {
  const { card: decided, followUps } = applyDecision({
    card: card(),
    action: "delegate",
    actorUserID: "user-bob",
    delegateToUserID: "user-carol",
  });

  assert.equal(decided.status, "delegated");
  assert.equal(followUps.length, 2);

  const delegated = followUps.find((f) => f.recipientUserID === "user-carol");
  assert.equal(delegated.type, "delegation");
  assert.ok(delegated.context.startsWith("Delegated by Bob"));

  const notice = followUps.find((f) => f.recipientUserID === "user-alice");
  assert.ok(notice.summary.includes("delegated to Carol"));
});

test("priority changes nothing but the priority", () => {
  const subject = card();
  const { followUps } = applyDecision({
    card: subject,
    action: "priority",
    actorUserID: "user-bob",
  });
  assert.equal(subject.status, "pending");
  assert.equal(followUps.length, 0);
});

test("github sync is required for approvals and for cards with an issue", () => {
  assert.equal(needsGitHubSync("approve", card()), true);
  assert.equal(needsGitHubSync("delegate", card()), true);
  assert.equal(needsGitHubSync("reject", card()), false);
  assert.equal(needsGitHubSync("reject", card({ githubIssueNumber: 7 })), true);
});

test("issue rendering carries the decision context", () => {
  const subject = card({ labels: ["bug"], status: "approved" });
  assert.equal(issueTitle(subject), "[task] Fix the login bug");

  const body = issueBody(subject);
  assert.ok(body.includes("| From | Alice |"));
  assert.ok(body.includes("Login is broken"));
  assert.ok(body.includes("deadline: Friday"));
  assert.ok(body.includes("`bug`"));

  assert.equal(githubStateFor("approved"), "open");
  assert.equal(githubStateFor("rejected"), "closed");
  assert.equal(githubStateFor("completed"), "closed");
});

test("findCard scopes lookups to the acting user", () => {
  const store = { "user-bob": [card()], "user-alice": [card({ id: "c2" })] };
  assert.equal(findCard(store, "user-bob", "c1")?.id, "c1");
  assert.equal(findCard(store, "user-alice", "c1"), null, "no cross-user access");
  assert.equal(findCard(store, "user-nobody", "c1"), null);
});

test("the action list is what the endpoint validates against", () => {
  assert.deepEqual(DECISION_ACTIONS.sort(), [
    "acknowledge",
    "approve",
    "delegate",
    "priority",
    "reject",
    "revise",
  ]);
});
