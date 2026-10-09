import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { pruneGrowth } from "../src/retention.js";

// Caches and meters trimmed to the longest anything reads them; the record of
// decisions (card_events) left alone.

const NOW = Date.parse("2026-09-30T00:00:00Z");
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const count = async (table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM ai_calls; DELETE FROM message_translations; DELETE FROM channel_journal; DELETE FROM ai_suggestions; DELETE FROM card_events; DELETE FROM notification_jobs; DELETE FROM notification_deliveries;");
});

test("rows past each window go, rows inside it stay", async () => {
  const call = (at) => env.DB.prepare(
    "INSERT INTO ai_calls (org_id, purpose, provider, model, created_at) VALUES ('o', 'route', 'openai', 'm', ?1)"
  ).bind(at).run();
  await call(ago(401)); await call(ago(399)); await call(ago(1));
  const tr = (id, at) => env.DB.prepare(
    "INSERT INTO message_translations (org_id, message_id, locale, source_hash, body, created_at) VALUES ('o', ?1, 'ja', 'h', 'b', ?2)"
  ).bind(id, at).run();
  await tr("m1", ago(61)); await tr("m2", ago(59));
  const jr = (day, at) => env.DB.prepare(
    "INSERT INTO channel_journal (org_id, channel, day, tz, locale, count, items, updated_at) VALUES ('o', 'b:x', ?1, 'UTC', 'en', 1, '[]', ?2)"
  ).bind(day, at).run();
  await jr("2025-01-01", ago(366)); await jr("2026-09-01", ago(29));
  const sg = (login, at) => env.DB.prepare(
    "INSERT INTO ai_suggestions (org_id, login, locale, items, created_at) VALUES ('o', ?1, 'en', '[]', ?2)"
  ).bind(login, at).run();
  await sg("a", ago(8)); await sg("b", ago(1));
  await env.DB.prepare(
    "INSERT INTO card_events (id, org_id, card_id, type, snapshot, created_at) VALUES ('e1', 'o', 'c', 'created', '{}', ?1)"
  ).bind(ago(3000)).run();

  const out = await pruneGrowth(env.DB, { now: NOW });

  expect(out).toEqual({ ai_calls: 1, message_translations: 1, channel_journal: 1, ai_suggestions: 1, notification_jobs: 0, notification_deliveries: 0 });
  expect(await count("ai_calls")).toBe(2);
  expect(await count("message_translations")).toBe(1);
  expect(await count("channel_journal")).toBe(1);
  expect(await count("ai_suggestions")).toBe(1);
  expect(await count("card_events")).toBe(1);
});

test("a large backlog goes in batches", async () => {
  const stmts = [];
  for (let i = 0; i < 25; i += 1) {
    stmts.push(env.DB.prepare(
      "INSERT INTO ai_suggestions (org_id, login, locale, items, created_at) VALUES ('o', ?1, 'en', '[]', ?2)"
    ).bind(`u${i}`, ago(30)));
  }
  await env.DB.batch(stmts);
  const out = await pruneGrowth(env.DB, { now: NOW, batch: 10 });
  expect(out.ai_suggestions).toBe(25);
  expect(await count("ai_suggestions")).toBe(0);
});

test("finished notification jobs and their deliveries go after a week; a pending job stays", async () => {
  const job = (id, state, at) => env.DB.prepare(
    "INSERT INTO notification_jobs (id, org_id, login, card_id, kind, payload, state, due_at, created_at, updated_at) VALUES (?1, 'o', 'l', 'c', 'created', '{}', ?2, ?3, ?3, ?3)"
  ).bind(id, state, at).run();
  await job("old-sent", "sent", ago(8)); await job("old-pending", "pending", ago(8)); await job("new-sent", "sent", ago(1));
  const delivery = (id, at) => env.DB.prepare(
    "INSERT INTO notification_deliveries (id, job_id, channel, updated_at) VALUES (?1, 'j', 'push', ?2)"
  ).bind(id, at).run();
  await delivery("old", ago(8)); await delivery("new", ago(1));

  const out = await pruneGrowth(env.DB, { now: NOW });

  expect(out.notification_jobs).toBe(1);
  expect(out.notification_deliveries).toBe(1);
  const ids = (await env.DB.prepare("SELECT id FROM notification_jobs ORDER BY id").all()).results.map((r) => r.id);
  expect(ids).toEqual(["new-sent", "old-pending"]);
  expect(await count("notification_deliveries")).toBe(1);
});
