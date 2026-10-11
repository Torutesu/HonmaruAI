import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { pruneGrowth } from "../src/retention.js";
import { sealLegacySecrets } from "../src/secrets.js";

// Sessions were never deleted once expired, and three jobs every fifteen
// minutes read every one ever made; one of them read five whole tables
// looking for secrets that were all sealed long ago.

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM sessions; DELETE FROM kv; DELETE FROM org_webhooks;");
});

test("a session a day past its expiry is deleted; a live one and one with no expiry are kept", async () => {
  const now = Date.now();
  const add = (token, expires) => env.DB.prepare(
    "INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at) VALUES (?1, 'u1', 'email-auth', ?2, ?3)"
  ).bind(token, iso(now - 40 * DAY), expires).run();
  await add("long-gone", iso(now - 2 * DAY));
  await add("just-gone", iso(now - 3600_000));
  await add("live", iso(now + 10 * DAY));
  await add("forever", null);

  const out = await pruneGrowth(env.DB, { now });

  expect(out.sessions).toBe(1);
  const { results } = await env.DB.prepare("SELECT token FROM sessions ORDER BY token").all();
  expect(results.map((r) => r.token)).toEqual(["forever", "just-gone", "live"]);
});

test("once nothing is left to seal, the tables are read again only a day later", async () => {
  const keyed = { ...env, DATA_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) };
  const now = Date.now();
  expect((await sealLegacySecrets(keyed, { now })).sealed).toBe(0);
  // A plain value from before the key, found the next day, not in between.
  await env.DB.prepare("INSERT INTO org_webhooks (id, org_id, url, secret, events, created_by, created_at) VALUES ('w1', 'team:a', 'https://example.com/h', 'whsec_plain', '[]', 'u1', ?1)")
    .bind(iso(now)).run();
  expect(await sealLegacySecrets(keyed, { now: now + 15 * 60_000 })).toMatchObject({ skipped: true });
  expect((await sealLegacySecrets(keyed, { now: now + DAY + 60_000 })).sealed).toBe(1);
  const row = await env.DB.prepare("SELECT secret FROM org_webhooks WHERE id = 'w1'").first();
  expect(row.secret.startsWith("enc:")).toBe(true);
});
