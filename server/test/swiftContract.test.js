import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DECISION_ACTIONS, applyDecision } from "../decisions.js";
import { buildEscalationCard } from "../escalation.js";
import { cardsFromWebhook } from "../githubWebhook.js";
import { buildSources } from "../provenance.js";
import { createChannelStore } from "../channels.js";
import { DEFAULT_ORG } from "../org.js";

// The iOS client can't be compiled here (no Xcode, and SwiftUI doesn't exist
// off Apple platforms), so this stands in for the part a compiler would have
// caught anyway: the relay and the Swift models must agree about the wire.
//
// A field the relay emits that Swift doesn't declare is silently dropped; a
// non-optional Swift field the relay omits fails decoding and the card never
// appears. Both are runtime-only bugs on a device — exactly what a contract
// test is for.

const here = dirname(fileURLToPath(import.meta.url));
const iosPath = (...parts) => join(here, "..", "..", "TikTokForWork", ...parts);

/** Pull `var name: Type` / `let name: Type` out of one Swift struct. */
function swiftProperties(source, structName) {
  const start = source.indexOf(`struct ${structName}`);
  assert.notEqual(start, -1, `struct ${structName} not found`);

  // Walk braces so nested types don't end the struct early.
  let depth = 0;
  let index = source.indexOf("{", start);
  const bodyStart = index + 1;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(bodyStart, index);

  const properties = new Map();
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(?:var|let)\s+(\w+)\s*:\s*([^\n={]+)/);
    if (!match) continue;
    // Computed properties carry a body — they are not part of the wire.
    if (/[{=]/.test(line.slice(match[0].length))) continue;
    const type = match[2].trim();
    if (!properties.has(match[1])) {
      properties.set(match[1], { type, optional: type.endsWith("?") });
    }
  }
  return properties;
}

/** Raw values of a `enum X: String` declaration. */
function swiftEnumCases(source, enumName) {
  const start = source.indexOf(`enum ${enumName}`);
  assert.notEqual(start, -1, `enum ${enumName} not found`);
  const body = source.slice(start, source.indexOf("\n}", start));

  const cases = new Set();
  for (const match of body.matchAll(/case\s+(\w+)(?:\s*=\s*"([^"]+)")?/g)) {
    cases.add(match[2] || match[1]);
  }
  return cases;
}

const cardModel = readFileSync(iosPath("Models", "DecisionCard.swift"), "utf8");
const relayClient = readFileSync(iosPath("Services", "RelayDecisionClient.swift"), "utf8");

/** Every card shape the relay can put on the wire, unioned. */
function relayCardKeys() {
  const keys = new Set();
  const collect = (card) => Object.keys(card || {}).forEach((key) => keys.add(key));

  const base = {
    id: "card-1",
    recipientUserID: "user-bob",
    senderUserID: "user-alice",
    type: "approval",
    title: "Approve the vendor contract",
    summary: "Legal signed off",
    context: "deadline: Friday",
    status: "pending",
    priority: "high",
    createdAt: new Date().toISOString(),
    channelID: "channel-general",
    sourceInstruction: "Bob needs to approve the vendor contract",
    agentRoute: "Alice's AI → Bob's AI",
    routingReason: "Named in your instruction",
    labels: ["contract"],
    sourceMessageID: "message-1",
    githubRepository: "acme/app",
    // Written by memory.js at delivery time.
    recommendation: { action: "approve", reason: "You approved the last 3" },
    // Written by the escalation and autopilot sweeps.
    escalatedAt: new Date().toISOString(),
    autopilotAt: new Date().toISOString(),
    decidedByAI: true,
    // Stamped by applyDecision; the ledger's lead time depends on it.
    decidedAt: new Date().toISOString(),
    decidedByUserID: "user-bob",
  };
  collect(base);

  // A decision and the cards it produces (response card, delegation copy).
  const { card: decided, followUps } = applyDecision({
    card: structuredClone(base),
    action: "revise",
    note: "split this in two",
    actorUserID: "user-bob",
  });
  collect(decided);
  followUps.forEach(collect);

  const delegated = applyDecision({
    card: structuredClone(base),
    action: "delegate",
    actorUserID: "user-bob",
    delegateToUserID: "user-carol",
  });
  collect(delegated.card);
  delegated.followUps.forEach(collect);

  // An escalation copy and a webhook-born card.
  collect(
    buildEscalationCard({
      card: structuredClone(base),
      recipient: { id: "user-bob", name: "Bob" },
      manager: { id: "user-dana", name: "Dana" },
      ageMinutes: 540,
    })
  );
  const webhookCards = cardsFromWebhook({
    event: "pull_request",
    payload: {
      action: "review_requested",
      requested_reviewer: { login: "bob" },
      sender: { login: "alice" },
      pull_request: {
        number: 12,
        title: "Onboarding",
        html_url: "https://github.com/a/b/pull/12",
      },
      repository: { full_name: "acme/app" },
    },
    orgStore: {
      findByGitHub: (login) =>
        DEFAULT_ORG.users.find((user) => user.githubUsername === login) || null,
    },
  });
  assert.ok(webhookCards.length > 0, "the webhook fixture should produce a card");
  webhookCards.forEach(collect);

  keys.add("sources"); // attached by the delivery path, asserted separately
  return keys;
}

test("every field the relay emits on a card exists in the Swift model", () => {
  const swift = swiftProperties(cardModel, "DecisionCard");

  const missing = [...relayCardKeys()].filter((key) => !swift.has(key));
  assert.deepEqual(
    missing,
    [],
    `Swift DecisionCard is missing: ${missing.join(", ")} — those fields decode to nothing on iOS`
  );
});

test("every non-optional Swift field is present on every card the relay sends", () => {
  const swift = swiftProperties(cardModel, "DecisionCard");
  const required = [...swift.entries()]
    .filter(([, meta]) => !meta.optional)
    .map(([name]) => name);

  const { card, followUps } = applyDecision({
    card: {
      id: "card-1",
      recipientUserID: "user-bob",
      senderUserID: "user-alice",
      type: "approval",
      title: "Approve",
      summary: "…",
      context: "",
      status: "pending",
      priority: "high",
      createdAt: new Date().toISOString(),
    },
    action: "approve",
    actorUserID: "user-bob",
  });

  for (const produced of [card, ...followUps]) {
    for (const field of required) {
      assert.ok(
        produced[field] !== undefined,
        `${field} is non-optional in Swift but missing from a relay card — decoding fails and the card never appears`
      );
    }
  }
});

test("the source chips the relay builds decode into Swift's CardSource", () => {
  const swift = swiftProperties(cardModel, "CardSource");
  const channelStore = createChannelStore();
  const channel = channelStore.createChannel({ name: "general", purpose: "" });

  const sources = buildSources({
    card: {
      channelID: channel.id,
      sourceMessageID: "message-1",
      sourceInstruction: "spec: https://www.notion.so/team/Onboarding-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
      summary: "",
      context: "",
    },
    channelStore,
  });

  // Plus the shape notion.js upgrades a link into.
  const shapes = [
    ...sources,
    { kind: "doc", label: "Onboarding spec", url: "https://notion.so/x", notionPageID: "abc" },
  ];

  for (const source of shapes) {
    for (const key of Object.keys(source)) {
      assert.ok(swift.has(key), `CardSource is missing ${key}`);
    }
  }
});

test("every decision the relay accepts has a Swift case to send it", () => {
  const swiftActions = swiftEnumCases(relayClient, "DecisionAction");
  const missing = DECISION_ACTIONS.filter((action) => !swiftActions.has(action));
  assert.deepEqual(missing, [], `iOS can't send: ${missing.join(", ")}`);
});

test("every status the relay can set has a Swift case to decode it", () => {
  const swiftStatuses = swiftEnumCases(cardModel, "CardStatus");
  // Set by decisions.js, escalation.js and the GitHub sync.
  for (const status of [
    "pending",
    "approved",
    "rejected",
    "revised",
    "delegated",
    "completed",
    "acknowledged",
    "resent",
  ]) {
    assert.ok(swiftStatuses.has(status), `CardStatus is missing "${status}"`);
  }
});

test("every card type the relay can send has a Swift case to decode it", () => {
  const swiftTypes = swiftEnumCases(cardModel, "CardType");
  for (const type of ["approval", "delegation", "notification", "task", "revision"]) {
    assert.ok(swiftTypes.has(type), `CardType is missing "${type}"`);
  }
});
