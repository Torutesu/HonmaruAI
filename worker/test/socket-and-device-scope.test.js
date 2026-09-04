import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, upsertUser, registerDevice } from "../src/db.js";

// Two small things a signed-in stranger could do to you.

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "8001", login: "ada", name: "Ada", avatarUrl: "", locale: "en" });
  await upsertUser(env.DB, { githubId: "8002", login: "mallory", name: "Mallory", avatarUrl: "", locale: "en" });
});

test("you cannot unregister somebody else's phone", async () => {
  await registerDevice(env.DB, { deviceToken: "ada-phone", githubId: "8001", login: "ada" });
  const mallory = await createSession(env.DB, "8002", "gho_m");

  // The device token is not a secret: it travels through APNs and sits in the
  // client's own logs. Unscoped, knowing one was enough to switch off the
  // notifications of whoever it belonged to, silently.
  const res = await SELF.fetch("https://example.com/devices", {
    method: "DELETE",
    headers: { "x-session-token": mallory, "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: "ada-phone" }),
  });
  expect(res.status).toBe(200);
  await res.json();

  const still = await env.DB
    .prepare("SELECT login FROM device_tokens WHERE device_token = 'ada-phone'")
    .first();
  expect(still?.login).toBe("ada");
});

test("and you can still unregister your own", async () => {
  await registerDevice(env.DB, { deviceToken: "mallory-phone", githubId: "8002", login: "mallory" });
  const mallory = await createSession(env.DB, "8002", "gho_m");

  const res = await SELF.fetch("https://example.com/devices", {
    method: "DELETE",
    headers: { "x-session-token": mallory, "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: "mallory-phone" }),
  });
  expect(res.status).toBe(200);
  await res.json();

  expect(
    await env.DB.prepare("SELECT login FROM device_tokens WHERE device_token = 'mallory-phone'").first()
  ).toBeNull();
});
