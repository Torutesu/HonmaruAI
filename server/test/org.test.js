import test from "node:test";
import assert from "node:assert/strict";
import { createOrgStore, roleBucket, DEFAULT_ORG } from "../org.js";
import { routeInstructionLocally, setActiveOrg, userNameFor } from "../agentTools.js";

test("seeds the demo roster by default", () => {
  const store = createOrgStore(null);
  assert.equal(store.users().length, 4);
  assert.equal(store.userName("user-alice"), "Alice");
});

test("restores from serialized state", () => {
  const first = createOrgStore(null);
  first.addMember({ name: "Erin", role: "Designer", team: "Design Team" });
  const restored = createOrgStore(first.serialize());
  assert.equal(restored.users().length, 5);
  assert.equal(restored.userName("user-erin"), "Erin");
});

test("addMember creates person + agent nodes, team edges, and github mapping", () => {
  const store = createOrgStore(null);
  const user = store.addMember({
    name: "Erin Fox",
    role: "Backend Engineer",
    team: "Engineering",
    githubUsername: "erinfox",
  });

  assert.equal(user.id, "user-erin-fox");
  const { nodes, edges } = store.snapshot();
  assert.ok(nodes.some((node) => node.id === "user-erin-fox" && node.kind === "person"));
  assert.ok(nodes.some((node) => node.id === "agent-erin-fox" && node.kind === "agent"));
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromID === "user-erin-fox" &&
        edge.toID === "team-engineering" &&
        edge.kind === "memberOf"
    )
  );
  assert.equal(store.findByGitHub("ErinFox")?.id, "user-erin-fox");
});

test("addMember creates unknown teams and rejects blank input", () => {
  const store = createOrgStore(null);
  const user = store.addMember({ name: "Kai", role: "Data Scientist", team: "Data" });
  assert.ok(store.teams().some((team) => team.label === "Data"));
  assert.equal(user.teamID, "team-data");
  assert.equal(store.addMember({ name: "  ", role: "x" }), null);
});

test("roleBucket categorizes role strings", () => {
  assert.equal(roleBucket("Senior Product Designer"), "design");
  assert.equal(roleBucket("Backend Engineer"), "engineering");
  assert.equal(roleBucket("Engineering Lead"), "engineering-lead");
  assert.equal(roleBucket("Product Manager"), "product");
  assert.equal(roleBucket("Accountant"), "general");
});

test("routing picks up members added at runtime", () => {
  const store = createOrgStore(null);
  store.addMember({ name: "Erin", role: "Designer", team: "Design Team" });
  setActiveOrg(store);
  try {
    const routing = routeInstructionLocally({
      text: "Ask Erin to polish the onboarding mockup",
      sender: { id: "user-alice", name: "Alice", role: "Product Manager" },
      organization: null,
    });
    assert.equal(routing.recipientUserID, "user-erin");
    assert.equal(userNameFor("user-erin"), "Erin");
  } finally {
    setActiveOrg(createOrgStore(structuredClone(DEFAULT_ORG)));
  }
});
