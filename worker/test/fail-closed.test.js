import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { resolveChannel } from "../src/channels.js";
import { hasGuests } from "../src/access.js";

// A read that fails says nothing about who may see a channel, so it must let
// nobody in. resolveChannel treated a failed "is it private?" lookup as
// "public", which handed a private channel — and everything broadcast in it —
// to the whole workspace; hasGuests answered "no guests", which let a guest
// read every public channel.

const ORG = "team:closed";
const kenji = { login: "kenji", github_id: "9903" };

// The real database, except that queries matching `pattern` throw.
const failing = (pattern) => ({
  prepare(sql) {
    if (pattern.test(sql)) {
      const boom = () => { throw new Error("D1_ERROR: network connection lost"); };
      return { bind: () => ({ first: async () => boom(), all: async () => boom(), run: async () => boom() }) };
    }
    return env.DB.prepare(sql);
  },
  batch: (s) => env.DB.batch(s),
});

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM businesses; DELETE FROM memberships; DELETE FROM conversation_members;");
  const { upsertBusiness, upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, ORG, "9901", "owner");
  await upsertMembership(env.DB, ORG, "9903", "member");
  await upsertBusiness(env.DB, ORG, { name: "Payroll", createdBy: "9901" });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'payroll'").bind(ORG).run();
});

test("a private channel stays closed to a non-member when the lookup works", async () => {
  expect(await resolveChannel(env.DB, ORG, kenji, "b:payroll")).toBeNull();
});

test("a failed 'is it private?' lookup lets nobody in", async () => {
  const db = failing(/FROM businesses/);
  expect(await resolveChannel(db, ORG, kenji, "b:payroll")).toBeNull();
});

test("a failed 'any guests?' read is taken as yes", async () => {
  expect(await hasGuests(env.DB, ORG)).toBe(false);
  expect(await hasGuests(failing(/LOWER\(COALESCE\(role, ''\)\) = 'guest'/), ORG)).toBe(true);
});
