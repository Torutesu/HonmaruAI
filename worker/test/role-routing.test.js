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
