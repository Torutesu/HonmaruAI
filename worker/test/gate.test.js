import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { countAIUse, usedToday, readEntitlement, writeEntitlement } from "../src/db.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("usage counts per user per day", async () => {
  expect(await usedToday(env.DB, "1", "2026-08-10")).toBe(0);
  await countAIUse(env.DB, "1", "2026-08-10");
  await countAIUse(env.DB, "1", "2026-08-10");
  expect(await usedToday(env.DB, "1", "2026-08-10")).toBe(2);
  // A different day starts over, and a different user is unaffected.
  expect(await usedToday(env.DB, "1", "2026-08-11")).toBe(0);
  expect(await usedToday(env.DB, "2", "2026-08-10")).toBe(0);
});

test("the entitlement cache round-trips with its timestamp", async () => {
  expect(await readEntitlement(env.DB, "9")).toBeNull();
  await writeEntitlement(env.DB, "9", true);
  const row = await readEntitlement(env.DB, "9");
  expect(row.is_pro).toBe(1);
  expect(typeof row.checked_at).toBe("string");
});
