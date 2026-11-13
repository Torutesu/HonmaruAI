import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import schemaSql from "../schema.sql?raw";

// The spend brake pauses the costly background work it names in
// spendGuard.js, and only that. The sweeps that end revoked access and the
// retention, expiry and deletion jobs run whether it is on or not: it used
// to return before them, so a day the limit was hit an identity provider's
// revocation went unnoticed until midnight UTC.

const calls = vi.hoisted(() => []);
const job = (name) => async () => { calls.push(name); };
vi.mock("../src/sso.js", async (orig) => ({ ...(await orig()), checkSsoGrants: job("sso") }));
vi.mock("../src/mcpOAuth.js", async (orig) => ({ ...(await orig()), sweepMcpOAuth: job("mcpOAuth") }));
vi.mock("../src/smitheryApps.js", async (orig) => ({ ...(await orig()), sweepAppConnections: job("apps") }));
vi.mock("../src/governance.js", async (orig) => ({ ...(await orig()), pruneMessages: job("retention"), expireExports: job("exports") }));
vi.mock("../src/threadShares.js", async (orig) => ({ ...(await orig()), expireThreadShares: job("threadShares") }));
vi.mock("../src/workspaceDeletion.js", async (orig) => ({ ...(await orig()), purgeDueWorkspaces: job("purge") }));
vi.mock("../src/scheduled.js", async (orig) => ({ ...(await orig()), runScheduledSync: job("sync"), runAutomations: job("routines") }));
vi.mock("../src/store/mirror.js", async (orig) => ({ ...(await orig()), reconcileAll: job("reconcile") }));
vi.mock("../src/auditArchive.js", async (orig) => ({ ...(await orig()), sealPending: job("sealing") }));
vi.mock("../src/audit.js", async (orig) => ({ ...(await orig()), migrateLegacyAudit: job("auditMigration") }));
vi.mock("../src/secrets.js", async (orig) => ({ ...(await orig()), sealLegacySecrets: job("secretSealing") }));

// The Worker's own entry is loaded before this file's mocks; loaded afresh,
// it imports the mocked jobs.
vi.resetModules();
const { default: worker } = await import("../src/index.js");
const { forgetBrake } = await import("../src/spendGuard.js");

const ALWAYS = ["sso", "mcpOAuth", "apps", "retention", "exports", "threadShares", "purge"];
const COSTLY = ["sync", "routines", "reconcile", "sealing", "auditMigration", "secretSealing"];

/// The quarter-hour ticks at which each job runs: midnight (reconcile), 05:00
/// (retention and expiry) and 06:00 (workspace purge), on today's date so
/// the brake, which is kept by the day, applies.
async function runDay() {
  calls.length = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const hour of ["00", "05", "06"]) {
    const pending = [];
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.parse(`${day}T${hour}:05:00Z`) }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.allSettled(pending);
  }
  return new Set(calls);
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM kv;");
  forgetBrake();
});

test("with the brake on, access and retention sweeps still run and only the costly work waits", async () => {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, '1', ?2)").bind(`spend-brake:${day}`, new Date().toISOString()).run();
  const ran = await runDay();
  for (const name of ALWAYS) expect(ran, name).toContain(name);
  for (const name of COSTLY) expect(ran, name).not.toContain(name);
});

test("with the brake off, every job runs", async () => {
  const ran = await runDay();
  for (const name of [...ALWAYS, ...COSTLY]) expect(ran, name).toContain(name);
});
