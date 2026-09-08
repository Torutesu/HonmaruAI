import { expect, test } from "vitest";
import { resolveRecipientTarget } from "../src/routing.js";

// Role routing reaches whoever holds a role, so a loose match sends work to the
// wrong person silently. These pin the cases substring matching got wrong.

const ORG = {
  orgId: "acme/app",
  nodes: [
    { id: "alice", kind: "person", role: "admin", label: "Alice · admin" },
    { id: "bob", kind: "person", role: "engineer", label: "Bob · engineer" },
    { id: "carol", kind: "person", role: "member", label: "Carol · member" },
  ],
  edges: [{ fromID: "alice", toID: "carol", kind: "manages" }],
};

const asCarol = (text) => resolveRecipientTarget(text, "carol", ORG);

test("a role word routes to whoever holds that role", () => {
  expect(asCarol("ask the engineer to fix the build").recipientUserID).toBe("bob");
});

test("a role word inside a longer word does not match", () => {
  // "dev" in "deviation", "device"; "lead" in "leading".
  expect(asCarol("please review this deviation from the plan").recipientUserID).not.toBe("bob");
  expect(asCarol("ship the new device onboarding").recipientUserID).not.toBe("bob");
  // alice is carol's manager, so she is a legitimate fallback here — what must
  // not happen is reaching her *because* "lead" appeared inside "leading".
  expect(asCarol("check the leading indicators").routingReason).not.toBe("Routed to the admin");
});

test("escalation reaches the sender's actual manager, not the admin", () => {
  // alice happens to be both carol's manager and the admin here; the point is
  // the manages edge decides it, so the reason must come from that rule.
  const routed = asCarol("escalate to my manager");
  expect(routed.recipientUserID).toBe("alice");
  expect(routed.routingReason).not.toBe("Routed to the admin");
});

test("role comes from the node, not from splitting the display label", () => {
  const orgWithSeparatorInName = {
    orgId: "acme/app",
    nodes: [
      { id: "dana", kind: "person", role: "designer", label: "Dana · Smith · designer" },
      { id: "carol", kind: "person", role: "member", label: "Carol · member" },
    ],
    edges: [],
  };
  const routed = resolveRecipientTarget("ask the designer to review", "carol", orgWithSeparatorInName);
  expect(routed.recipientUserID).toBe("dana");
});

// \b is ASCII-only. The whole-word change that fixed dev/deviation silently
// killed every Japanese role word, and nothing here covered them.
const JP_ORG = {
  orgId: "acme/app",
  nodes: [
    { id: "yui", kind: "person", role: "designer", label: "結衣 · designer" },
    { id: "kenji", kind: "person", role: "engineer", label: "健二 · engineer" },
    { id: "carol", kind: "person", role: "member", label: "Carol · member" },
  ],
  edges: [],
};

test("Japanese role words still route", () => {
  expect(resolveRecipientTarget("デザイナーに確認をお願いして", "carol", JP_ORG).recipientUserID).toBe("yui");
  expect(resolveRecipientTarget("エンジニアに実装を頼んで", "carol", JP_ORG).recipientUserID).toBe("kenji");
});

test("ASCII terms keep their word boundaries", () => {
  // The regression fix must not undo the fix it regressed.
  const routed = resolveRecipientTarget("review this deviation from the plan", "carol", JP_ORG);
  expect(routed.recipientUserID).not.toBe("kenji");
});

// A card is read by a person, so it may not carry an internal id. Both
// prefixes had to be stripped, not one: the relay's login is "u:…" and only
// "email:…" was handled, so the fallback titled cards "Update for
// u:someone@example.com" — and the colon in that then split the context into
// a fact chip labelled "From u".
test("no card wears a raw account id", async () => {
  const { routeInstruction } = await import("../src/routing.js");
  const organization = {
    nodes: [
      { id: "u:mai@honmaru.jp", kind: "person", role: "founder", label: "Mai · founder" },
      { id: "u:ken@honmaru.jp", kind: "person", role: "engineer", label: "Ken · engineer" },
    ],
  };
  const routed = await routeInstruction({
    text: "ask the engineer to fix the booking form",
    sender: { id: "u:mai@honmaru.jp", name: "Mai", role: "founder" },
    organization,
  });
  const shown = `${routed.title} ${routed.summary} ${routed.context}`;
  expect(shown).not.toContain("u:");
  expect(shown).not.toContain("email:");
  expect(shown).not.toContain("@honmaru.jp");
});

// The clients send `sender.name` from what they have at compose time, which is
// the login. Trusting it put "From u:someone@example.com" on the card even
// though the recipient's name was already being cleaned up.
test("a sender name that is really an id is cleaned up too", async () => {
  const { routeInstruction } = await import("../src/routing.js");
  const organization = {
    nodes: [
      { id: "u:mai@honmaru.jp", kind: "person", role: "founder", label: "Mai · founder" },
      { id: "u:ken@honmaru.jp", kind: "person", role: "engineer", label: "Ken · engineer" },
    ],
  };
  const routed = await routeInstruction({
    text: "ask the engineer to fix the booking form",
    // The name is the login, exactly as the web client used to send it.
    sender: { id: "u:mai@honmaru.jp", name: "u:mai@honmaru.jp", role: "founder" },
    organization,
  });
  const shown = `${routed.title} ${routed.summary} ${routed.context} ${routed.agentRoute || ""}`;
  expect(shown).not.toContain("u:");
  expect(shown).not.toContain("@honmaru.jp");
  expect(routed.context).toContain("Mai");
});

// A workspace of one is the first thing anybody sees, and the card in it was
// captioned "Update for Alice · From Alice · decision routed to Alice".
test("a card you routed to yourself does not introduce you to yourself", async () => {
  const { routeInstruction } = await import("../src/routing.js");
  const routed = await routeInstruction({
    text: "remember to send the invoice on Friday",
    sender: { id: "u:mai@honmaru.jp", name: "u:mai@honmaru.jp", role: "founder" },
    organization: {
      nodes: [{ id: "u:mai@honmaru.jp", kind: "person", role: "founder", label: "Mai · founder" }],
    },
  });
  expect(routed.recipientUserID).toBe("u:mai@honmaru.jp");
  expect(routed.context).not.toMatch(/routed to/);
  expect(routed.title).not.toContain("Mai");
  expect(routed.summary).toContain("invoice");
});

// "Ask the engineer to fix the" — six words flat, ending on a preposition,
// which reads as a truncation bug rather than a title.
test("a task title stops on a word that can end one", async () => {
  const { routeInstruction } = await import("../src/routing.js");
  const organization = {
    nodes: [
      { id: "u:mai@honmaru.jp", kind: "person", role: "founder", label: "Mai · founder" },
      { id: "u:ken@honmaru.jp", kind: "person", role: "engineer", label: "Ken · engineer" },
    ],
  };
  const routed = await routeInstruction({
    text: "ask the engineer to fix the booking form before Friday because the cafe reopens",
    sender: { id: "u:mai@honmaru.jp", name: "Mai", role: "founder" },
    organization,
  });
  expect(routed.title).not.toMatch(/\b(the|to|a|an|of|for|before|and)…?$/i);
  expect(routed.title.length).toBeLessThanOrEqual(56);
});

// The membership row holds the name this person goes by. Deriving one from the
// account id put "E2e-1788841995270" on a card the server could have named.
test("the sender's real name beats anything the client sent", async () => {
  const { routeInstruction } = await import("../src/routing.js");
  const routed = await routeInstruction({
    text: "ask the engineer to fix the booking form",
    sender: { id: "u:e2e-1788841995270@example.com", name: "u:e2e-1788841995270@example.com", role: "founder" },
    organization: {
      nodes: [
        { id: "u:e2e-1788841995270@example.com", kind: "person", role: "founder", label: "E2E Person · founder" },
        { id: "u:ken@honmaru.jp", kind: "person", role: "engineer", label: "Ken · engineer" },
      ],
    },
  });
  expect(`${routed.context} ${routed.agentRoute}`).toContain("E2E Person");
  expect(`${routed.context} ${routed.agentRoute}`).not.toContain("1788841995270");
});

// A card's summary is the person's own sentence. Its title and routing line
// are the Worker's own words, and with no AI key configured they went to a
// Japanese reader in English — the half of "the language switch does nothing"
// that lives on the server.
test("the words nobody wrote are written in the reader's language", async () => {
  const { routeInstruction } = await import("../src/routing.js");
  const organization = {
    nodes: [
      { id: "u:mai@honmaru.jp", kind: "person", role: "founder", label: "Mai · founder" },
      { id: "u:ken@honmaru.jp", kind: "person", role: "engineer", label: "Ken · engineer" },
    ],
  };
  const ja = await routeInstruction({
    text: "ask the engineer to approve the new supplier price",
    sender: { id: "u:mai@honmaru.jp", name: "Mai", role: "founder" },
    organization,
    readerLanguage: "ja",
  });
  expect(ja.title).toBe("承認が必要です");
  expect(ja.context).toContain("に振り分け");
  // The instruction itself is untouched — it is not ours to translate.
  expect(ja.summary).toContain("supplier price");

  // And English is still English, including a tag like "en-GB".
  const en = await routeInstruction({
    text: "ask the engineer to approve the new supplier price",
    sender: { id: "u:mai@honmaru.jp", name: "Mai", role: "founder" },
    organization,
    readerLanguage: "en-GB",
  });
  expect(en.title).toBe("Approval needed");
});
