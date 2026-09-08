import { env, fetchMock } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { EMAIL_AUTH_TOKEN, signup } from "../src/auth.js";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";

const ORG = "personal:ux-team";
const OTHER_ORG = "private/other";
const TEST_ENV = { ...env, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined };
let emailToken, githubToken, outsiderToken, returningAccount;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  for (const person of [
    { githubId: "email:owner@example.test", login: "u:owner@example.test", name: "Owner", avatarUrl: null, role: "admin" },
    { githubId: "42", login: "designer", name: "Design · Lead", avatarUrl: "https://example.test/avatar.png", role: "designer" },
    { githubId: "43", login: "engineer", name: "Engineer", avatarUrl: null, role: "engineer" },
  ]) {
    await upsertUser(env.DB, person);
    await upsertMembership(env.DB, ORG, person.githubId, person.role);
  }
  await env.DB.prepare("UPDATE users SET email = 'private-notification@example.test' WHERE github_id = '42'").run();
  emailToken = await createSession(env.DB, "email:owner@example.test", EMAIL_AUTH_TOKEN);
  githubToken = await createSession(env.DB, "42", "gho_member");
  await upsertUser(env.DB, { githubId: "99", login: "outsider", name: "Outsider", avatarUrl: null });
  await upsertMembership(env.DB, OTHER_ORG, "99", "admin");
  outsiderToken = await createSession(env.DB, "99", "gho_outsider");
  returningAccount = await signup(TEST_ENV, { email: "returning@example.test", password: "long-password", name: "Returning" });
});

function request(path, token, body) {
  return worker.fetch(new Request(`https://example.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { "x-session-token": token } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), TEST_ENV);
}

const routeBody = (extra = {}) => ({
  text: "Ask the designer to approve the new design",
  sender: { id: "u:owner@example.test", name: "Owner" },
  organization: { orgId: ORG, nodes: [{ id: "forged", kind: "person", label: "Forged" }] },
  ...extra,
});

test.each(["email", "github"])("%s members can list the current workspace without private profile fields", async (kind) => {
  const response = await request(`/members?orgId=${encodeURIComponent(ORG)}`, kind === "email" ? emailToken : githubToken);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.orgId).toBe(ORG);
  expect(body.members).toEqual([
    { id: "designer", name: "Design · Lead", role: "designer", avatarUrl: "https://example.test/avatar.png" },
    { id: "engineer", name: "Engineer", role: "engineer" },
    { id: "u:owner@example.test", name: "Owner", role: "admin" },
  ]);
  expect(JSON.stringify(body)).not.toContain("private-notification");
  expect(JSON.stringify(body)).not.toContain("gho_");
});

test("member listing requires a workspace and authenticated membership", async () => {
  expect((await request("/members", emailToken)).status).toBe(400);
  expect((await request(`/members?orgId=${ORG}`)).status).toBe(401);
  expect((await request(`/members?orgId=${ORG}`, outsiderToken)).status).toBe(403);
});

test("expired sessions and removed members cannot read the directory", async () => {
  await env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE token = ?1").bind(githubToken).run();
  expect((await request(`/members?orgId=${ORG}`, githubToken)).status).toBe(401);
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(ORG, "email:owner@example.test").run();
  expect((await request(`/members?orgId=${ORG}`, emailToken)).status).toBe(403);
});

test("members no longer in a workspace disappear from the selectable directory", async () => {
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '43'").bind(ORG).run();
  const body = await (await request(`/members?orgId=${ORG}`, emailToken)).json();
  expect(body.members.map((member) => member.id)).not.toContain("engineer");
});

test("the member picker reflects a descriptive title without changing administrative standing", async () => {
  await env.DB.prepare("UPDATE memberships SET title = 'designer' WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(ORG, "email:owner@example.test").run();
  const body = await (await request(`/members?orgId=${ORG}`, emailToken)).json();
  expect(body.members.find((member) => member.id === "u:owner@example.test")?.role).toBe("designer");
  const membership = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(ORG, "email:owner@example.test").first();
  expect(membership.role).toBe("admin");
});

test("explicit recipient survives conflicting role words and forged client organization data", async () => {
  const response = await request("/ai/route", emailToken, routeBody({ recipientUserID: "engineer" }));
  expect(response.status).toBe(200);
  const card = await response.json();
  expect(card.recipientUserID).toBe("engineer");
  expect(card.routingReason).toBe("Selected by you");
  expect(card.agentRoute).toBe("Owner → Engineer");
  expect(card.routedBy).toBe("fallback");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first()).n).toBe(0);
});

test("automatic routing still chooses an actual role holder when no override is supplied", async () => {
  const response = await request("/ai/route", emailToken, routeBody());
  expect(response.status).toBe(200);
  expect((await response.json()).recipientUserID).toBe("designer");
});

test("model drafting receives only the chosen member as a valid recipient", async () => {
  fetchMock.activate();
  let captured;
  fetchMock.get("https://api.openai.com").intercept({
    path: "/v1/chat/completions", method: "POST",
    body: (body) => { captured = JSON.parse(body); return true; },
  }).reply(200, { choices: [{ message: { tool_calls: [{
    id: "selected-recipient", type: "function", function: {
      name: "create_decision_card",
      arguments: JSON.stringify({ recipientUserID: "engineer", cardType: "approval", title: "Approve the design", summary: "Review the proposed design.", context: "Design review", priority: "medium", routingReason: "Model suggestion" }),
    },
  }] } }] });
  const response = await worker.fetch(new Request("https://example.test/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": emailToken, "x-ai-key": "sk-fixture" },
    body: JSON.stringify(routeBody({ recipientUserID: "engineer" })),
  }), TEST_ENV);
  const card = await response.json();
  expect(response.status).toBe(200);
  expect(captured.tools[0].function.parameters.properties.recipientUserID.enum).toEqual(["engineer"]);
  expect(card.recipientUserID).toBe("engineer");
  expect(card.routedBy).toBe("OpenAI");
  expect(card.routingReason).toBe("Selected by you");
  fetchMock.assertNoPendingInterceptors();
});

test.each(["outsider", "forged", "email:owner@example.test", ""])("an invalid selected recipient %j is rejected instead of silently rerouted", async (recipientUserID) => {
  const response = await request("/ai/route", emailToken, routeBody({ recipientUserID }));
  expect(response.status).toBe(400);
});

test("explicit selection requires a session and named workspace", async () => {
  expect((await request("/ai/route", undefined, routeBody({ recipientUserID: "engineer" }))).status).toBe(401);
  expect((await request("/ai/route", emailToken, routeBody({ recipientUserID: "engineer", organization: { nodes: [] } }))).status).toBe(400);
});

test("a valid unrelated session cannot route against another workspace directory", async () => {
  expect((await request("/ai/route", outsiderToken, routeBody())).status).toBe(403);
  expect((await request("/ai/route", outsiderToken, routeBody({ recipientUserID: "engineer" }))).status).toBe(403);
});

test("recipient removal is checked again after the member picker was loaded", async () => {
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '43'").bind(ORG).run();
  expect((await request("/ai/route", emailToken, routeBody({ recipientUserID: "engineer" }))).status).toBe(400);
});

test("returning email sign-in includes the existing workspace expected by the web app", async () => {
  const response = await request("/auth/login", undefined, { email: "returning@example.test", password: "long-password" });
  expect(response.status).toBe(200);
  const signedIn = await response.json();
  expect(signedIn.orgId).toBe(returningAccount.orgId);
  expect(signedIn.login).toBe(returningAccount.login);
  expect(signedIn.userId).toBe(returningAccount.userId);
  expect(typeof signedIn.token).toBe("string");
  expect((await request(`/members?orgId=${signedIn.orgId}`, signedIn.token)).status).toBe(200);
});

test("wrong credentials never expose workspace membership", async () => {
  const response = await request("/auth/login", undefined, { email: "returning@example.test", password: "incorrect-password" });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ message: "Invalid email or password." });
});

test("sign-in chooses an actual current membership, ignoring a caller-supplied workspace", async () => {
  await env.DB.prepare("DELETE FROM memberships WHERE user_github_id = ?1").bind(returningAccount.userId).run();
  await upsertMembership(env.DB, ORG, returningAccount.userId, "member");
  const response = await request("/auth/login", undefined, { email: "returning@example.test", password: "long-password", orgId: OTHER_ORG });
  expect(response.status).toBe(200);
  expect((await response.json()).orgId).toBe(ORG);
});

test("an account with no workspace can still authenticate to accept an invite", async () => {
  await env.DB.prepare("DELETE FROM memberships WHERE user_github_id = ?1").bind(returningAccount.userId).run();
  const response = await request("/auth/login", undefined, { email: "returning@example.test", password: "long-password" });
  expect(response.status).toBe(200);
  const signedIn = await response.json();
  expect(signedIn.orgId).toBeNull();
  expect(typeof signedIn.token).toBe("string");
  expect((await request(`/members?orgId=${returningAccount.orgId}`, signedIn.token)).status).toBe(403);
});
