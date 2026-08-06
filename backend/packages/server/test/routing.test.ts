import type { Member, OrgEdge, Team } from "@honmaru/protocol";
import { describe, expect, it } from "vitest";
import { routeLocally } from "../src/routing.js";

const members: Member[] = [
  { userId: "u1", name: "Alice Kato", title: "Product Manager", isAdmin: true, teamId: "t-prod" },
  { userId: "u2", name: "Bob Chen", title: "Engineer", isAdmin: false, teamId: "t-eng" },
  { userId: "u3", name: "Carol Ito", title: "Designer", isAdmin: false, teamId: "t-design" },
];

const teams: Team[] = [
  { id: "t-prod", orgId: "o1", name: "Product" },
  { id: "t-eng", orgId: "o1", name: "Engineering" },
  { id: "t-design", orgId: "o1", name: "Design" },
];

const edges: OrgEdge[] = [
  { id: "e1", orgId: "o1", kind: "manages", fromId: "u1", toId: "u2" },
];

const base = { sender: members[1]!, members, teams, edges };

describe("routeLocally", () => {
  it("routes to a member named in the instruction", () => {
    const result = routeLocally({ ...base, text: "tell Carol the mockups are ready" });
    expect(result.recipientUserId).toBe("u3");
    expect(result.routingReason).toBe("Named in your instruction");
  });

  it("routes by team name", () => {
    const result = routeLocally({
      ...base,
      sender: members[2]!,
      text: "the engineering team should review the memory leak",
    });
    expect(result.recipientUserId).toBe("u2");
  });

  it("routes by job-title keyword", () => {
    const result = routeLocally({
      ...base,
      text: "we need a designer pass on the empty state",
    });
    expect(result.recipientUserId).toBe("u3");
  });

  it("escalates to the sender's manager when nothing matches", () => {
    const result = routeLocally({ ...base, text: "something ambiguous happened" });
    expect(result.recipientUserId).toBe("u1");
  });

  it("never routes back to the sender and rewrites the summary", () => {
    const result = routeLocally({
      ...base,
      text: "tell Alice to approve the launch plan urgently",
    });
    expect(result.recipientUserId).toBe("u1");
    expect(result.cardType).toBe("approval");
    expect(result.priority).toBe("urgent");
    expect(result.summary.toLowerCase()).not.toContain("tell alice");
  });

  it("honors the priority override", () => {
    const result = routeLocally({
      ...base,
      text: "tell Carol about the new logo",
      priorityOverride: "low",
    });
    expect(result.priority).toBe("low");
  });
});
