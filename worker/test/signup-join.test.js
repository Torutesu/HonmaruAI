import { env, fetchMock } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { open, collect, message, until } from "./helpers.js";

// The reported exploit was two steps: sign up naming someone else's org, then
// join it and read the snapshot. Asserting the membership row is absent covers
// the first. This covers the pair, because the snapshot is the thing that
// actually leaks and the relay is what hands it over.

const VICTIM_ORG = "victim/private-repo";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9101", login: "victimowner", name: "Victim", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, VICTIM_ORG, "9101", "admin");
});

test("signing up while naming a private org does not get you into it", async () => {
  const { signup } = await import("../src/auth.js");

  const attacker = await signup(env, {
    email: "attacker@evil.com",
    password: "password123",
    name: "attacker",
    orgId: VICTIM_ORG,
  });
  expect(attacker.error).toBeUndefined();

  // The session is real. That was never the question — Mallory's was too.
  // GitHub is the fallback authority and has no write access to offer.
  fetchMock.activate();
  fetchMock.get("https://api.github.com")
    .intercept({ path: `/repos/victim/private-repo`, method: "GET" })
    .reply(404, { message: "Not Found" });

  const ws = await open(VICTIM_ORG);
  const messages = collect(ws);
  ws.send(JSON.stringify({
    type: "join",
    payload: { protocol: "agui/1", sessionToken: attacker.token },
  }));

  const refusal = await message(messages, (m) => m.type === "RUN_ERROR" || m.type === "error");
  const closed = await until(async () => ws.readyState !== WebSocket.OPEN);

  expect(refusal).toBeTruthy();
  // The snapshot is the org's entire decision store.
  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeUndefined();
  expect(closed).toBe(true);
  fetchMock.assertNoPendingInterceptors();
});
