import { expect, test, describe } from "vitest";
import { routeInstructionLocally } from "../src/routing.js";

// A golden set for the router.
//
// Routing is the product's one irreversible judgement: a card sent to the wrong
// person is a decision the right person never sees. Every other test here
// checks one rule in isolation; this checks the behaviour a person would
// describe — "ask Yui to approve the release" reaches Yui, as an approval.
//
// It runs against the keyword router rather than the model, deliberately. The
// keyword router is what every user without an API key gets, what everyone gets
// when the model is down or the daily allowance is spent, and what the
// validator falls back to when the model names somebody who is not there. It is
// the floor, and a floor is worth a golden set.

const ORG = {
  nodes: [
    { id: "yui", kind: "person", label: "Yui · Design", detail: "brand, the marketing site, design reviews" },
    { id: "toru", kind: "person", label: "Toru · Engineering", detail: "the app, releases, infrastructure" },
    { id: "grace", kind: "person", label: "Grace · Finance", detail: "budgets, invoices, vendor contracts" },
    { id: "kenji", kind: "person", label: "Kenji · Sales", detail: "customers, renewals, pricing" },
    { id: "team-app", kind: "team", label: "acme/app" },
  ],
  edges: [
    { id: "e1", fromID: "grace", toID: "toru", kind: "manages" },
    { id: "e2", fromID: "grace", toID: "team-app", kind: "canApprove" },
  ],
};

const SENDER = { id: "toru", name: "Toru" };

function route(text, over = {}) {
  return routeInstructionLocally({
    text, sender: SENDER, organization: ORG, readerLanguage: "en", ...over,
  });
}

/// Each case: what somebody typed, and the two things that must not be wrong.
/// `type: null` means the case is about the recipient only.
const CASES = [
  // --- named directly, English ---
  ["Ask Yui to approve the new landing page", "yui", "approval"],
  ["Yui, can you sign off on the brand colours?", "yui", "approval"],
  ["Tell Grace the invoice from the vendor needs paying", "grace", null],
  ["@kenji please confirm the renewal price with the customer", "kenji", null],
  ["Let Yui know the release shipped", "yui", "notification"],

  // --- named directly, Japanese. No spaces between words, so a matcher built
  // on word boundaries finds nothing at all here. ---
  ["Yui にランディングページの承認をお願いして", "yui", "approval"],
  ["Grace に請求書の支払いを確認してもらって", "grace", null],
  ["Kenji に更新価格を顧客と確認するよう伝えて", "kenji", null],
  ["Yui にリリースが出たことを共有して", "yui", null],

  // --- the type, from what is being asked rather than who ---
  ["Ask Grace to approve the Q4 budget", "grace", "approval"],
  ["Grace, please review and approve the vendor contract", "grace", "approval"],
  ["Hand the pricing page copy over to Yui", "yui", "delegation"],
  ["Yui にコピーの作成を任せたい", "yui", "delegation"],
  ["Kenji, this needs another pass before it goes out", "kenji", "revision"],

  // --- nobody named: it must still land on somebody real, and never on the
  // sender, who would be asking themselves for a decision ---
  ["Someone needs to look at the failing build", null, null],
  ["請求書の件、誰か見てほしい", null, null],
];

describe("the keyword router, on instructions people actually write", () => {
  for (const [text, recipient, type] of CASES) {
    test(text, () => {
      const card = route(text);

      // Always a real member, never the person asking.
      expect(ORG.nodes.some((n) => n.kind === "person" && n.id === card.recipientUserID)).toBe(true);
      expect(card.recipientUserID).not.toBe(SENDER.id);

      if (recipient) expect(card.recipientUserID).toBe(recipient);
      if (type) expect(card.cardType).toBe(type);

      // A card with no title is a card nobody can act on from the feed.
      expect(card.title.length).toBeGreaterThan(0);
      expect(["low", "medium", "high", "urgent"]).toContain(card.priority);
    });
  }
});

describe("urgency, which decides what interrupts somebody", () => {
  const URGENT = [
    "Yui, the site is down — need a decision now",
    "Grace に至急、支払いの承認をお願い",
  ];
  for (const text of URGENT) {
    test(text, () => expect(["high", "urgent"]).toContain(route(text).priority));
  }

  test("an ordinary request is not urgent", () => {
    expect(route("Ask Yui to look at the brand colours when she has a moment").priority)
      .not.toBe("urgent");
  });

  test("what the sender chose beats what the words imply", () => {
    // The person typing knows more about how urgent this is than a word list.
    expect(route("Ask Yui to look at the colours", { priorityOverride: "urgent" }).priority)
      .toBe("urgent");
  });
});

describe("what the recipient is handed", () => {
  test("the card explains itself without the original instruction", () => {
    const card = route("Ask Grace to approve the Q4 budget, we are over on contractors");
    // Not the raw instruction echoed back: the title is addressed to Grace, and
    // "Ask Grace to" is the sender talking to their own AI.
    expect(card.title.toLowerCase().startsWith("ask grace")).toBe(false);
    expect(card.agentRoute).toContain("Toru");
    expect(card.routingReason.length).toBeGreaterThan(0);
  });

  test("a Japanese reader gets a Japanese card", () => {
    const card = routeInstructionLocally({
      text: "Ask Yui to approve the landing page",
      sender: SENDER, organization: ORG, readerLanguage: "ja",
    });
    // Any kana or kanji at all: the fallback copy is per-language, and an
    // English-only card was what a Japanese reader used to get from it.
    expect(/[ぁ-んァ-ン一-龯]/.test(`${card.title}${card.summary}`)).toBe(true);
  });
});
