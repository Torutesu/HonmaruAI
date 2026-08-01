import { describe, expect, it } from "vitest";
import { buildOrgView } from "./orgGraph";

// The relay's seed org (server/org.js DEFAULT_ORG), trimmed to what the view
// reads. If the relay's edge kinds change, this test is what notices.
const graph = {
  nodes: [
    { id: "user-alice", kind: "person" as const, label: "Alice · Product" },
    { id: "user-bob", kind: "person" as const, label: "Bob · Engineering" },
    { id: "user-eve", kind: "person" as const, label: "Eve · Contractor" },
    { id: "agent-alice", kind: "agent" as const, label: "Alice's AI" },
    { id: "agent-bob", kind: "agent" as const, label: "Bob's AI" },
    { id: "team-core", kind: "team" as const, label: "Core Team" },
    { id: "team-design", kind: "team" as const, label: "Design Team" },
    { id: "project-onboarding", kind: "project" as const, label: "Onboarding v2" },
  ],
  edges: [
    { id: "e1", fromID: "user-alice", toID: "team-core", kind: "memberOf" as const },
    { id: "e2", fromID: "user-bob", toID: "team-core", kind: "memberOf" as const },
    { id: "e3", fromID: "user-alice", toID: "user-bob", kind: "manages" as const },
    { id: "e4", fromID: "user-alice", toID: "project-onboarding", kind: "canApprove" as const },
    { id: "e5", fromID: "agent-alice", toID: "user-alice", kind: "assignedTo" as const },
    { id: "e6", fromID: "agent-bob", toID: "user-bob", kind: "assignedTo" as const },
  ],
};

describe("buildOrgView", () => {
  const view = buildOrgView(graph);

  it("folds the flat edge list into teams and members", () => {
    expect(view.teams.map((team) => team.label)).toEqual(["Core Team"]);
    expect(view.teams[0]!.members.map((member) => member.label)).toEqual([
      "Alice · Product",
      "Bob · Engineering",
    ]);
  });

  it("drops empty teams instead of rendering graph noise", () => {
    expect(view.teams.some((team) => team.id === "team-design")).toBe(false);
  });

  it("attaches each person's AI, manager and approval rights", () => {
    const [alice, bob] = view.teams[0]!.members;
    expect(alice!.agentLabel).toBe("Alice's AI");
    expect(alice!.approves).toEqual(["Onboarding v2"]);
    expect(alice!.managerLabel).toBeNull();
    // manages runs manager → report, so Bob is the one with a manager.
    expect(bob!.managerLabel).toBe("Alice · Product");
  });

  it("still shows people who belong to no team", () => {
    expect(view.unassigned.map((member) => member.label)).toEqual(["Eve · Contractor"]);
  });

  it("counts what the org is made of", () => {
    expect(view.counts).toEqual({ people: 3, teams: 1, agents: 2 });
  });

  it("survives an empty graph", () => {
    const empty = buildOrgView({ nodes: [], edges: [] });
    expect(empty.teams).toEqual([]);
    expect(empty.counts.people).toBe(0);
  });
});
