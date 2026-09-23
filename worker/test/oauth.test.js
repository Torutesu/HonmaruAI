import {SELF, env} from "cloudflare:test";
import worker from "../src/index.js";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

beforeEach(async () => {
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

// The web comes back through a page on its own origin. That callback is a
// second address on the same OAuth app, offered only where it has been
// registered, and the only other address a code may be exchanged through.
test("/oauth/github/config?client=web is 503 until a web callback is set, and the callback after", async () => {
  const withSecrets = { ...env, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
  let res = await worker.fetch(new Request("https://example.com/oauth/github/config?client=web"), withSecrets);
  expect(res.status).toBe(503);
  res = await worker.fetch(new Request("https://example.com/oauth/github/config?client=web"), { ...withSecrets, GITHUB_WEB_REDIRECT_URI: "https://honmaru.pages.dev/" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ clientId: "id", redirectUri: "https://honmaru.pages.dev/" });
  // The app's answer is unchanged.
  res = await worker.fetch(new Request("https://example.com/oauth/github/config"), { ...withSecrets, GITHUB_WEB_REDIRECT_URI: "https://honmaru.pages.dev/" });
  expect((await res.json()).redirectUri).toBe("tiktokforwork://oauth/callback");
  const health = await (await worker.fetch(new Request("https://example.com/health"), { ...withSecrets, GITHUB_WEB_REDIRECT_URI: "https://honmaru.pages.dev/" })).json();
  expect(health.githubOAuthWeb).toBe(true);
});

test("a code is exchanged through the web callback when it is the registered one, and refused through any other", async () => {
  const webEnv = { ...env, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", GITHUB_WEB_REDIRECT_URI: "https://honmaru.pages.dev/" };
  let exchanged;
  fetchMock.get("https://github.com").intercept({ path: "/login/oauth/access_token", method: "POST" })
    .reply(200, (opts) => { exchanged = JSON.parse(opts.body); return { access_token: "gho_web", token_type: "bearer" }; });
  fetchMock.get("https://api.github.com").intercept({ path: "/user" })
    .reply(200, { id: 43, login: "webcat" });
  const { state } = await (await worker.fetch(new Request("https://example.com/oauth/github/state"), webEnv)).json();
  let res = await worker.fetch(new Request("https://example.com/oauth/github/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "abc", state, redirectUri: "https://honmaru.pages.dev/" }),
  }), webEnv);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.login).toBe("webcat");
  expect(body.orgs).toEqual([]);
  expect(exchanged.redirect_uri).toBe("https://honmaru.pages.dev/");

  // An address nobody registered: refused before the nonce is even spent.
  const { state: state2 } = await (await worker.fetch(new Request("https://example.com/oauth/github/state"), webEnv)).json();
  res = await worker.fetch(new Request("https://example.com/oauth/github/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "abc", state: state2, redirectUri: "https://evil.example/" }),
  }), webEnv);
  expect(res.status).toBe(400);
});
