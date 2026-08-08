import { expect, test } from "vitest";
import { buildOrgGraph, roleName, isApprover } from "../src/org.js";

const COLLABS = [
  { login: "octocat", id: 1, avatar_url: "http://a", permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } },
  { login: "hubot",   id: 2, avatar_url: "http://b", permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } },
];

test("roleName maps permissions to a human role", () => {
  expect(roleName(COLLABS[0].permissions)).toBe("Admin");
  expect(roleName(COLLABS[1].permissions)).toBe("Engineer");
  expect(roleName({ pull: true })).toBe("Member");
});

test("isApprover is true for admin/maintain only", () => {
  expect(isApprover(COLLABS[0].permissions)).toBe(true);
  expect(isApprover(COLLABS[1].permissions)).toBe(false);
});

test("buildOrgGraph emits iOS-shaped users/nodes/edges", () => {
  const g = buildOrgGraph(COLLABS, { owner: "acme", repo: "web" });
  const team = g.nodes.find((n) => n.kind === "team");
  expect(team).toEqual({ id: "team-web", kind: "team", label: "acme/web" });
  const octo = g.nodes.find((n) => n.id === "octocat");
  expect(octo).toEqual({ id: "octocat", kind: "person", label: "octocat · Admin" });
  expect(g.nodes.find((n) => n.id === "agent-octocat")).toEqual({ id: "agent-octocat", kind: "agent", label: "octocat's AI" });
  expect(g.edges.find((e) => e.kind === "memberOf" && e.fromID === "octocat")).toMatchObject({ toID: "team-web" });
  expect(g.edges.some((e) => e.kind === "canApprove" && e.fromID === "octocat")).toBe(true);
  expect(g.edges.some((e) => e.kind === "canApprove" && e.fromID === "hubot")).toBe(false);
  expect(g.users.find((u) => u.id === "octocat")).toEqual({
    id: "octocat", name: "octocat", role: "Admin", teamID: "team-web", githubUsername: "octocat", language: "en",
  });
});
