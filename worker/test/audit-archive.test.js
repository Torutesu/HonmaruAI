import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { audit } from "../src/audit.js";
import { sealPending, verifyArchive, verifyDigest, archivePath, gunzip } from "../src/auditArchive.js";
import { pruneAudit } from "../src/auditRetention.js";
import { deliverStreams, requestFor } from "../src/auditStreams.js";
import { principalOf, forgetCachedKeys } from "../src/auditCrypto.js";

// Phase 2 of the audit log, the rest (docs/audit-log-phase2.md §3–5): each
// hour sealed into a locked archive under a signed digest; rows past their
// retention leaving D1 only once sealed, never under a hold; and the log
// streamed to a SIEM in order, with backoff.

const ORG = "team:sealed";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 20, 10, 0, 0);
let owner;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const realFetch = globalThis.fetch;
const call = async (path, token, { method = "GET", body, headers = {}, withEnv = env } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), withEnv, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const write = async (n, at) => {
  for (let i = 0; i < n; i += 1) await audit(env, null, { orgId: ORG, action: "emoji.added", actor: { type: "user", id: "u:toru@x.jp", name: "Toru" }, entity: { type: "emoji", id: `e${i}`, name: `:e${i}:` } });
  await env.DB.prepare("UPDATE audit_events SET created_at = ?2 WHERE org_id = ?1 AND created_at > ?2").bind(ORG, Math.floor(at / 1000)).run();
};

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM audit_seals; DELETE FROM audit_seal_failures; DELETE FROM org_audit_settings; DELETE FROM audit_streams; DELETE FROM audit_principal_keys; DELETE FROM sessions; DELETE FROM memberships;");
  const listed = await env.AUDIT_ARCHIVE.list();
  for (const o of listed.objects) await env.AUDIT_ARCHIVE.delete(o.key);
  forgetCachedKeys();
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7901", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "7901", "owner");
  owner = await createSession(env.DB, "7901", "x");
});
afterEach(() => { globalThis.fetch = realFetch; });

test("each hour is sealed once: the archive, a signed digest, and a chain from one digest to the next", async () => {
  await write(3, T0 + 5 * 60_000);
  await write(2, T0 + HOUR + 60_000);
  const sealed = await sealPending(env, { now: T0 + 2 * HOUR + 60_000 });
  expect(sealed.map((s) => s.count)).toEqual([3, 2]);
  // Twice is once.
  expect(await sealPending(env, { now: T0 + 2 * HOUR + 60_000 })).toEqual([]);
  const first = JSON.parse(await (await env.AUDIT_ARCHIVE.get(`${archivePath(ORG, T0)}.digest.json`)).text());
  const second = JSON.parse(await (await env.AUDIT_ARCHIVE.get(`${archivePath(ORG, T0 + HOUR)}.digest.json`)).text());
  const { keys } = await (await call("/audit/public-key")).json();
  expect(await verifyDigest(first, keys)).toBe(true);
  expect(await verifyDigest({ ...first, count: 99 }, keys)).toBe(false);
  const seal = await env.DB.prepare("SELECT digest_sha256 FROM audit_seals WHERE org_id = ?1 ORDER BY hour LIMIT 1").bind(ORG).first();
  expect(second.prev_digest).toBe(seal.digest_sha256);
  // The archive holds the rows as stored: people still encrypted.
  const lines = (await gunzip(new Uint8Array(await (await env.AUDIT_ARCHIVE.get(`${archivePath(ORG, T0)}.jsonl.gz`)).arrayBuffer()))).trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines.join("")).not.toContain("toru@x.jp");
  expect(await verifyArchive(env, ORG)).toMatchObject({ ok: true, checked_hours: 2 });
  const shown = await (await call(`/audit/verify?orgId=${ORG}`, owner)).json();
  expect(shown).toMatchObject({ ok: true, archive: { ok: true, checked_hours: 2 } });
});

/// The database, but a seal cannot be recorded.
const sealsDown = () => ({
  ...env,
  DB: new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql) => (/INSERT OR IGNORE INTO audit_seals/.test(sql)
          ? { bind: () => ({ run: async () => { throw new Error("D1 is down"); } }) }
          : target.prepare(sql));
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
});

// A seal that wrote its archive and digest but not its row was sealed again
// with a new digest — a new sealed_at — whose hash D1 recorded while the
// bucket kept the first one: the chain broke at the next hour.
test("a seal retried after its objects were written records the digest in the bucket, and the next hour chains to it", async () => {
  await write(3, T0 + 5 * 60_000);
  const now = T0 + HOUR + 60_000;
  expect(await sealPending(sealsDown(), { now })).toEqual([]);
  const path = archivePath(ORG, T0);
  const kept = await (await env.AUDIT_ARCHIVE.get(`${path}.digest.json`)).text();
  await new Promise((r) => setTimeout(r, 5));
  expect((await sealPending(env, { now })).map((s) => s.count)).toEqual([3]);
  expect(await (await env.AUDIT_ARCHIVE.get(`${path}.digest.json`)).text()).toBe(kept);
  const seal = await env.DB.prepare("SELECT digest_sha256, sealed_at FROM audit_seals WHERE org_id = ?1").bind(ORG).first();
  const { sha256Hex } = await import("../src/auth.js");
  expect(seal.digest_sha256).toBe(await sha256Hex(kept));
  expect(seal.sealed_at).toBe(JSON.parse(kept).sealed_at);
  // Again: nothing more.
  expect(await sealPending(env, { now })).toEqual([]);
  await write(2, T0 + HOUR + 60_000);
  await sealPending(env, { now: T0 + 2 * HOUR + 60_000 });
  const next = JSON.parse(await (await env.AUDIT_ARCHIVE.get(`${archivePath(ORG, T0 + HOUR)}.digest.json`)).text());
  expect(next.prev_digest).toBe(await sha256Hex(kept));
  expect(await verifyArchive(env, ORG)).toMatchObject({ ok: true, checked_hours: 2 });
});

test("a seal that stopped after the archive alone writes one digest for that archive; a digest that is not this hour's is refused", async () => {
  await write(2, T0 + 5 * 60_000);
  const now = T0 + HOUR + 60_000;
  await sealPending(sealsDown(), { now });
  const path = archivePath(ORG, T0);
  await env.AUDIT_ARCHIVE.delete(`${path}.digest.json`);
  expect((await sealPending(env, { now })).map((s) => s.count)).toEqual([2]);
  expect(await verifyArchive(env, ORG)).toMatchObject({ ok: true, checked_hours: 1 });

  // An hour whose bucket already holds something else: not sealed over it.
  await write(1, T0 + HOUR + 60_000);
  const other = archivePath(ORG, T0 + HOUR);
  await env.AUDIT_ARCHIVE.put(`${other}.digest.json`, JSON.stringify({ v: 1, org: ORG, count: 99 }));
  expect(await sealPending(env, { now: T0 + 2 * HOUR + 60_000 })).toEqual([]);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_seals WHERE org_id = ?1").bind(ORG).first()).n).toBe(1);
  expect((await env.DB.prepare("SELECT last_error FROM audit_seal_failures WHERE org_id = ?1").bind(ORG).first()).last_error).toContain("does not seal");
});

test("verification finds a changed row, a changed archive, and a missing digest", async () => {
  await write(3, T0 + 60_000);
  await sealPending(env, { now: T0 + HOUR + 60_000 });
  await env.DB.prepare("UPDATE audit_events SET hash = 'x' WHERE org_id = ?1 AND seq = 1").bind(ORG).run();
  expect((await verifyArchive(env, ORG)).first_problem.kind).toBe("hash");
  await env.DB.prepare("UPDATE audit_events SET hash = (SELECT hash FROM audit_events WHERE 0) WHERE 0").run();
  const path = archivePath(ORG, T0);
  await env.AUDIT_ARCHIVE.put(`${path}.jsonl.gz`, "tampered");
  expect((await verifyArchive(env, ORG)).first_problem.kind).toBe("archive");
  await env.AUDIT_ARCHIVE.delete(`${path}.digest.json`);
  expect((await verifyArchive(env, ORG)).first_problem.kind).toBe("missing");
});

test("past their retention and sealed, rows leave D1; unsealed ones and a hold keep them; the chain still checks", async () => {
  await write(4, T0 + 60_000);
  await sealPending(env, { now: T0 + HOUR + 60_000 });
  await write(2, T0 + 2 * HOUR + 60_000); // not sealed
  const later = T0 + 200 * 24 * HOUR;
  // A hold first: nothing goes.
  const ops = { ...env, OPS_TOKEN: "ops-secret" };
  expect((await call("/ops/audit/settings", null, { method: "POST", body: { orgId: ORG, legalHold: true, reason: "Case 42" }, withEnv: ops })).status).toBe(404);
  expect((await call("/ops/audit/settings", null, { method: "POST", body: { orgId: ORG, legalHold: true, reason: "Case 42" }, headers: { "x-ops-token": "ops-secret" }, withEnv: ops })).status).toBe(200);
  expect(await pruneAudit(env, { now: later })).toEqual([]);
  await call("/ops/audit/settings", null, { method: "POST", body: { orgId: ORG, legalHold: false, reason: "Case closed" }, headers: { "x-ops-token": "ops-secret" }, withEnv: ops });
  const pruned = await pruneAudit(env, { now: later });
  expect(pruned).toEqual([{ orgId: ORG, count: 4 }]);
  const left = (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all()).results.map((r) => r.action);
  expect(left).toContain("audit.pruned");
  expect(left.filter((a) => a === "emoji.added")).toHaveLength(2);
  const verify = await (await call(`/audit/verify?orgId=${ORG}`, owner)).json();
  expect(verify.ok).toBe(true);
});

test("nothing but pruning deletes from the audit log", async () => {
  const files = import.meta.glob("../src/**/*.js", { query: "?raw", import: "default", eager: true });
  const deleting = Object.entries(files).filter(([, text]) => /DELETE FROM audit_events/.test(text)).map(([p]) => p);
  expect(deleting).toEqual(["../src/auditRetention.js"]);
});

test("a hold keeps one person's key through their account's deletion, and it goes when lifted", async () => {
  const ops = { ...env, OPS_TOKEN: "ops-secret" };
  await write(1, T0);
  const p = await principalOf(env, ORG, "u:toru@x.jp");
  expect((await call("/ops/audit/principal-hold", null, { method: "POST", body: { orgId: ORG, login: "u:toru@x.jp", hold: true, reason: "Case 7" }, headers: { "x-ops-token": "ops-secret" }, withEnv: ops })).status).toBe(200);
  const { shredPerson } = await import("../src/auditCrypto.js");
  await shredPerson(env, "u:toru@x.jp");
  let key = await env.DB.prepare("SELECT wrapped_key, shred_pending FROM audit_principal_keys WHERE org_id = ?1 AND principal = ?2").bind(ORG, p).first();
  expect(key.wrapped_key).toBeTruthy();
  expect(key.shred_pending).toBe(1);
  await call("/ops/audit/principal-hold", null, { method: "POST", body: { orgId: ORG, principal: p, hold: false, reason: "Released" }, headers: { "x-ops-token": "ops-secret" }, withEnv: ops });
  key = await env.DB.prepare("SELECT wrapped_key FROM audit_principal_keys WHERE org_id = ?1 AND principal = ?2").bind(ORG, p).first();
  expect(key.wrapped_key).toBe(null);
});

test("a stream sends what is new, in order and signed; a failure backs off; Splunk and Datadog are shaped as they expect", async () => {
  const made = await call("/audit/streams", owner, { method: "POST", body: { orgId: ORG, kind: "https", endpoint: "https://siem.example.com/in", secret: "whsec" } });
  expect(made.status).toBe(201);
  const sent = [];
  let fail = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://siem.example.com")) {
      sent.push({ url, headers: init.headers, body: init.body });
      return new Response(fail ? "no" : "ok", { status: fail ? 503 : 200 });
    }
    return realFetch(input, init);
  };
  await write(3, Date.now());
  await deliverStreams(env);
  expect(sent).toHaveLength(1);
  expect(sent[0].headers["honmaru-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  const lines = sent[0].body.trim().split("\n").map((l) => JSON.parse(l));
  // Its own creation is the first thing it carries.
  expect(lines.map((e) => e.action)).toEqual(["workspace.audit_stream_changed", "emoji.added", "emoji.added", "emoji.added"]);
  expect(lines.map((e) => e.seq)).toEqual([...lines.map((e) => e.seq)].sort((a, b) => a - b));
  expect(lines[1].actor.name).toBe("Toru");
  // Nothing new: nothing sent.
  await deliverStreams(env);
  expect(sent).toHaveLength(1);
  fail = true;
  await write(1, Date.now());
  await deliverStreams(env);
  const row = await env.DB.prepare("SELECT failures, next_try_at, status FROM audit_streams WHERE org_id = ?1").bind(ORG).first();
  expect(row.failures).toBe(1);
  expect(Date.parse(row.next_try_at)).toBeGreaterThan(Date.now());
  // Splunk and Datadog.
  const events = [{ date_create: 1, severity: "info", action: "x" }];
  const splunk = requestFor({ kind: "splunk_hec", endpoint: "https://splunk.example.com:8088" }, "tok", events);
  expect(splunk.url).toBe("https://splunk.example.com:8088/services/collector/event");
  expect(splunk.headers.authorization).toBe("Splunk tok");
  const dd = requestFor({ kind: "datadog", region: "eu1", org_id: ORG }, "key", events);
  expect(dd.url).toBe("https://http-intake.logs.datadoghq.eu/api/v2/logs");
  expect(JSON.parse(dd.body)[0]).toMatchObject({ ddsource: "honmaru", service: "audit" });
});

// A replay from before the oldest row D1 still kept started at that row and
// moved the stream past the pruned range: the archive was never read.
test("a replay from entries retention has pruned sends them from the archive, then the live ones; a missing archive stops the stream instead", async () => {
  await write(4, T0 + 60_000);
  await sealPending(env, { now: T0 + HOUR + 60_000 });
  await write(2, T0 + 2 * HOUR + 60_000);
  expect(await pruneAudit(env, { now: T0 + 200 * 24 * HOUR })).toEqual([{ orgId: ORG, count: 4 }]);
  expect((await call("/audit/streams", owner, { method: "POST", body: { orgId: ORG, kind: "https", endpoint: "https://siem.example.com/in", secret: "whsec" } })).status).toBe(201);
  const stream = await env.DB.prepare("SELECT id FROM audit_streams WHERE org_id = ?1").bind(ORG).first();
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://siem.example.com")) { sent.push(...init.body.trim().split("\n").map((l) => JSON.parse(l))); return new Response("ok"); }
    return realFetch(input, init);
  };
  // Without the archive there is nothing to send them from: refused, and the earliest that can be.
  const noArchive = await call(`/audit/streams/${stream.id}/replay`, owner, { method: "POST", body: { orgId: ORG, fromSeq: 1 }, withEnv: { ...env, AUDIT_ARCHIVE: undefined } });
  expect(noArchive.status).toBe(409);
  expect(await noArchive.json()).toMatchObject({ code: "replay-unavailable", earliestSeq: 5 });

  expect((await call(`/audit/streams/${stream.id}/replay`, owner, { method: "POST", body: { orgId: ORG, fromSeq: 2 } })).status).toBe(200);
  for (let run = 0; run < 3; run += 1) await deliverStreams(env);
  const newest = (await env.DB.prepare("SELECT MAX(seq) AS s FROM audit_events WHERE org_id = ?1").bind(ORG).first()).s;
  expect(sent.map((e) => e.seq)).toEqual(Array.from({ length: newest - 1 }, (_, i) => i + 2));
  expect(sent.slice(0, 3).map((e) => e.action)).toEqual(["emoji.added", "emoji.added", "emoji.added"]);
  expect(sent[0].actor.name).toBe("Toru");

  // The archive gone: the stream fails where it is and says why.
  await env.AUDIT_ARCHIVE.delete(`${archivePath(ORG, T0)}.jsonl.gz`);
  expect((await call(`/audit/streams/${stream.id}/replay`, owner, { method: "POST", body: { orgId: ORG, fromSeq: 1 } })).status).toBe(200);
  sent.length = 0;
  await deliverStreams(env);
  expect(sent).toEqual([]);
  const row = await env.DB.prepare("SELECT delivered_seq, failures, last_error FROM audit_streams WHERE id = ?1").bind(stream.id).first();
  expect(row).toMatchObject({ delivered_seq: 0, failures: 1 });
  expect(row.last_error).toContain("archive");
});

// Twenty due streams, LIMIT 20, no order and no memory of the last run: the
// same twenty had every run, idle or not, and a twenty-first never sent.
test("streams take turns: twenty idle ones do not keep a twenty-first from sending", async () => {
  for (let i = 0; i < 20; i += 1) {
    await env.DB.prepare(
      "INSERT INTO audit_streams (id, org_id, kind, endpoint, secret, min_severity, delivered_seq, status, failures, created_by, created_at) VALUES (?1, 'team:quiet', 'https', 'https://quiet.example.com/in', 'x', 'info', 0, 'active', 0, '1', ?2)"
    ).bind(`as_${String(i).padStart(2, "0")}`, new Date().toISOString()).run();
  }
  expect((await call("/audit/streams", owner, { method: "POST", body: { orgId: ORG, kind: "https", endpoint: "https://siem.example.com/in", secret: "whsec" } })).status).toBe(201);
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://siem.example.com")) { sent.push(init.body); return new Response("ok"); }
    return realFetch(input, init);
  };
  for (let run = 0; run < 2 && !sent.length; run += 1) await deliverStreams(env, { limit: 20 });
  expect(sent).toHaveLength(1);
  // And round again: the idle ones are visited, the busy one comes back.
  await write(1, Date.now());
  for (let run = 0; run < 2 && sent.length < 2; run += 1) await deliverStreams(env, { limit: 20 });
  expect(sent).toHaveLength(2);
});

test("each workspace is sealed on its own: the ones with a finished hour, not the ones already sealed or still in their hour", async () => {
  const writeTo = async (orgId, at) => {
    await audit(env, null, { orgId, action: "emoji.added", actor: { type: "user", id: "u:toru@x.jp", name: "Toru" }, entity: { type: "emoji", id: "e", name: ":e:" } });
    await env.DB.prepare("UPDATE audit_events SET created_at = ?2 WHERE org_id = ?1 AND created_at > ?2").bind(orgId, Math.floor(at / 1000)).run();
  };
  await writeTo("team:a", T0 + 5 * 60_000);
  await writeTo("team:b", T0 + 5 * 60_000);
  const first = await sealPending(env, { now: T0 + HOUR + 60_000 });
  expect(first.map((s) => s.orgId).sort()).toEqual(["team:a", "team:b"]);

  // New rows in the hour that is still running: nothing to seal yet.
  await writeTo("team:a", T0 + HOUR + 2 * 60_000);
  await writeTo("team:c", T0 + HOUR + 2 * 60_000);
  expect(await sealPending(env, { now: T0 + HOUR + 3 * 60_000 })).toEqual([]);

  // That hour over: the two with new rows, and not the one already sealed.
  const second = await sealPending(env, { now: T0 + 2 * HOUR + 60_000 });
  expect(second.map((s) => s.orgId).sort()).toEqual(["team:a", "team:c"]);
});

// One shared OPS_TOKEN compared with !==: every operator was "ops" in the
// audit log, and none could be cut off alone.
test("each operator has their own token, and the log says which one acted", async () => {
  const { operatorOf } = await import("../src/auditRetention.js");
  const ops = { ...env, OPS_TOKEN: "ops-secret", OPS_TOKENS: JSON.stringify({ aiko: "aiko-secret-1", ren: "ren-secret-22" }) };
  expect(await operatorOf(ops, "aiko-secret-1")).toBe("aiko");
  expect(await operatorOf(ops, "ops-secret")).toBe("ops");
  expect(await operatorOf(ops, "aiko-secret-")).toBeNull();
  expect(await operatorOf(ops, "")).toBeNull();
  expect(await operatorOf({ ...env, OPS_TOKENS: "not json" }, "x")).toBeNull();
  expect((await call("/ops/audit/settings", null, { method: "POST", body: { orgId: ORG, legalHold: true, reason: "Case 9" }, headers: { "x-ops-token": "ren-secret-22" }, withEnv: ops })).status).toBe(200);
  const row = await env.DB.prepare("SELECT * FROM audit_events WHERE org_id = ?1 AND action = 'audit.legal_hold_changed'").bind(ORG).first();
  expect(JSON.stringify(row)).toContain("ren");
});
