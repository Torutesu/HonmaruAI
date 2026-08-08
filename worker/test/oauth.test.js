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
  const res = await SELF.fetch("https://example.com/oauth/github/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "abc" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accessToken).toBe("gho_test");
  expect(typeof body.sessionToken).toBe("string");
});
