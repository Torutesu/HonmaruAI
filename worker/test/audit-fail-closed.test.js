import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// An entry that could not be written was logged to the console and
// forgotten, and the export it recorded went out anyway: the one thing an
// audit log is for — who took the data — could be missing without a trace.

/// The database, but the audit log cannot be written.
const auditDown = () => ({
  ...env,
  DB: new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql) => (/INSERT INTO audit_events/.test(sql)
          ? { bind: () => ({ run: async () => { throw new Error("D1 is down"); } }) }
          : target.prepare(sql));
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
});

let token;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9701", login: "ann", name: "Ann", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "team:fc", "9701", "owner");
  token = await createSession(env.DB, "9701", "x");
});

test("an export whose entry cannot be written is not handed out, and the entry is kept for an operator", async () => {
  const res = await worker.fetch(new Request("https://example.com/account/export", { headers: { "x-session-token": token } }), auditDown(), { waitUntil() {} });
  expect(res.status).toBe(503);
  expect((await res.json()).code).toBe("audit-unavailable");
  const kept = await env.AUDIT_ARCHIVE.list({ prefix: `undelivered/${encodeURIComponent("team:fc")}/` });
  expect(kept.objects).toHaveLength(1);
  const entry = JSON.parse(await (await env.AUDIT_ARCHIVE.get(kept.objects[0].key)).text());
  expect(entry.body.action).toBe("data.account_exported");
  // With the log back, it goes.
  expect((await worker.fetch(new Request("https://example.com/account/export", { headers: { "x-session-token": token } }), env, { waitUntil() {} })).status).toBe(200);
});
