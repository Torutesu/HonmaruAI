import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// The redirect target is a custom URL scheme, and iOS gives a custom scheme to
// whichever app claims it. Without a nonce, another app can intercept the
// callback, hand us a code minted against its own account, and walk away with a
// session bound to the victim's device. The nonce is the only thing that makes
// the code ours.

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function mintState() {
  const res = await SELF.fetch("https://example.com/oauth/github/state");
  expect(res.status).toBe(200);
  return (await res.json()).state;
}

function stubGitHub() {
  fetchMock.get("https://github.com").intercept({ path: "/login/oauth/access_token", method: "POST" })
    .reply(200, { access_token: "gho_test", token_type: "bearer" });
  fetchMock.get("https://api.github.com").intercept({ path: "/user" })
    .reply(200, { id: 77, login: "statedev" });
}

function exchange(body) {
  return SELF.fetch("https://example.com/oauth/github/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("an exchange without a state is refused", async () => {
  const res = await exchange({ code: "abc" });
  expect(res.status).toBe(400);
});

test("an exchange with a state we never issued is refused", async () => {
  const res = await exchange({ code: "abc", state: "made-up" });
  expect(res.status).toBe(400);
});

test("a state is spent exactly once", async () => {
  const state = await mintState();
  stubGitHub();

  const first = await exchange({ code: "abc", state });
  expect(first.status).toBe(200);
  expect((await first.json()).sessionToken).toBeTruthy();

  // Replaying the same callback must not mint a second session.
  const replay = await exchange({ code: "abc", state });
  expect(replay.status).toBe(400);
});

test("an expired state is refused", async () => {
  const state = await mintState();
  await env.DB
    .prepare("UPDATE oauth_states SET expires_at = ?1 WHERE state = ?2")
    .bind("2020-01-01T00:00:00.000Z", state)
    .run();

  const res = await exchange({ code: "abc", state });
  expect(res.status).toBe(400);
  // Refused or not, a spent nonce is gone — an expired one cannot be retried
  // into existence.
  const row = await env.DB.prepare("SELECT state FROM oauth_states WHERE state = ?1").bind(state).first();
  expect(row).toBeNull();
});
