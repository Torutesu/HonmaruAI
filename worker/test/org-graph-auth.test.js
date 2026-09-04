import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// A repo-backed org's membership comes from GitHub, so an account with no
// GitHub identity cannot read it. That is a real limitation; the failure it
// produced was a 502 carrying GitHub's words for a problem that is ours.

const ORG = "acme/app";
let emailToken;
let githubToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  const { EMAIL_AUTH_TOKEN } = await import("../src/auth.js");

  await upsertUser(env.DB, { githubId: "email:dana@example.com", login: "u:dana@example.com", name: "Dana", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "email:dana@example.com", "designer");
  emailToken = await createSession(env.DB, "email:dana@example.com", EMAIL_AUTH_TOKEN);

  await upsertUser(env.DB, { githubId: "4242", login: "octocat", name: "Octo", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "4242", "admin");
  githubToken = await createSession(env.DB, "4242", "gho_real_token");
});

const graphReq = (token) =>
  new Request(`https://example.com/orgs/acme/app/graph`, {
    headers: { "x-session-token": token },
  });

test("an email account is told why it cannot read a repo-backed org", async () => {
  const res = await worker.fetch(graphReq(emailToken), env);
  expect(res.status).toBe(400);
  const body = await res.json();
  // Ours to explain, not GitHub's.
  expect(body.message).toMatch(/GitHub/);
  expect(body.message).not.toMatch(/Bad credentials|401/);
});

test("isGitHubSession only trusts a real token", async () => {
  const { isGitHubSession, EMAIL_AUTH_TOKEN } = await import("../src/auth.js");
  expect(isGitHubSession({ github_access_token: "gho_x" })).toBe(true);
  expect(isGitHubSession({ github_access_token: EMAIL_AUTH_TOKEN })).toBe(false);
  expect(isGitHubSession({})).toBe(false);
  expect(isGitHubSession(null)).toBe(false);
});
