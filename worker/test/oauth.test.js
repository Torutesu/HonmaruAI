import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("/oauth/github/config is 503 without secrets", async () => {
  const res = await SELF.fetch("https://example.com/oauth/github/config");
  expect(res.status).toBe(503);
});

test("/oauth/github/token exchanges a code and mints a session", async () => {
  fetchMock.get("https://github.com").intercept({ path: "/login/oauth/access_token", method: "POST" })
    .reply(200, { access_token: "gho_test", token_type: "bearer" });
  fetchMock.get("https://api.github.com").intercept({ path: "/user" })
    .reply(200, { id: 42, login: "octocat" });
  // The exchange is only willing to spend a nonce it issued (oauth-state.test.js).
  const stateRes = await SELF.fetch("https://example.com/oauth/github/state");
  const { state } = await stateRes.json();
  const res = await SELF.fetch("https://example.com/oauth/github/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "abc", state }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  // The GitHub token is not handed back. It carries `repo` scope — every
  // repository this person can reach, code included — and the app's six calls
  // all go through /github now. A session cannot be replayed against
  // api.github.com; an access token can.
  expect(body.accessToken).toBeUndefined();
  expect(typeof body.sessionToken).toBe("string");
  expect(body.login).toBe("octocat");
});
