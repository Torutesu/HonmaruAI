import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Every route, asked by someone from one workspace about another. The
// membership check is written out route by route, so one route that forgets
// it is a way into every other company's data. This walks every path the
// Worker answers, with every method, naming a workspace the caller is not in,
// and checks that nothing of that workspace comes back and nothing in it
// changes.

const VICTIM = "team:victim";
const MARK = "VICTIM7f3c";
const sources = import.meta.glob("../src/**/*.js", { query: "?raw", import: "default", eager: true });

/// The paths the Worker answers, as its code spells them.
function routes() {
  const out = new Set();
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(/(?:url\.pathname|path|pathname) === "(\/[^"]+)"/g)) out.add(m[1]);
  }
  return [...out].sort();
}

/// Everything stored under the victim workspace, but for what a refusal
/// itself writes: the audit trail and the rate limiter.
async function victimRows() {
  const { results: tables } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
  const out = {};
  for (const { name } of tables) {
    if (["audit_events", "audit_principal_keys", "rate_limits", "kv"].includes(name)) continue;
    const { results: cols } = await env.DB.prepare(`PRAGMA table_info(${name})`).all();
    if (!cols.some((c) => c.name === "org_id")) continue;
    const { results } = await env.DB.prepare(`SELECT * FROM ${name} WHERE org_id = ?1`).bind(VICTIM).all();
    out[name] = JSON.stringify(results);
  }
  return out;
}

let mal;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9601", login: "vic", name: "Vic", avatarUrl: null, locale: "en" });
  // A colleague: who works there is the workspace's to tell.
  await upsertUser(env.DB, { githubId: "9603", login: "eve", name: `Eve ${MARK}`, avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, VICTIM, "9603", "member");
  await upsertUser(env.DB, { githubId: "9602", login: "mal", name: "Mal", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, VICTIM, "9601", "owner");
  await upsertMembership(env.DB, "team:attacker", "9602", "owner");
  const now = new Date().toISOString();
  await saveCard(env.DB, VICTIM, { id: "vcard", recipientUserID: "vic", senderUserID: "vic", type: "approval", title: `Acquire ${MARK}`, status: "pending", createdAt: now });
  await env.DB.prepare("INSERT INTO businesses (org_id, slug, name, created_by, created_at) VALUES (?1, 'general', ?2, '9601', ?3)").bind(VICTIM, `General ${MARK}`, now).run();
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES ('vmsg', ?1, 'b:general', 'vic', ?2, 'message', ?3)").bind(VICTIM, `Q3 numbers ${MARK}`, now).run();
  await env.DB.prepare("INSERT INTO memories (id, org_id, text, origin, created_by, created_at, updated_at) VALUES ('vmem', ?1, ?2, 'told', '9601', ?3, ?3)").bind(VICTIM, `Rule ${MARK}`, now).run();
  mal = await createSession(env.DB, "9602", "gho_mal");
  fetchMock.activate();
});
afterEach(() => fetchMock.deactivate?.());

const PARAMS = { orgId: VICTIM, channel: "b:general", id: "vmsg", cardId: "vcard", messageId: "vmsg", parentId: "vmsg", slug: "general", q: "a", query: "a", login: "vic", url: "https://example.com/" };
const BODY = { ...PARAMS, body: "hi", text: "hi", name: "x", title: "x", ids: ["vmsg"], cards: ["vcard"], role: "member", emoji: "👍", action: "approve" };

/// Routes that end the caller's own sign-in or account: asked, they would
/// leave the rest of the walk asking as nobody. Deleting your own account is
/// yours to do from anywhere.
const ENDS_THE_CALLER = new Set(["DELETE /account", "POST /auth/logout", "DELETE /sessions", "POST /sessions"]);

/// Ask every route, every method, as `token`; the ones whose answer carries
/// the victim's data.
async function walk(token, { methods = ["GET", "POST", "PUT", "PATCH", "DELETE"], changes = null } = {}) {
  const leaks = [];
  let rows = changes ? await victimRows() : null;
  for (const path of routes()) {
    for (const method of methods) {
      if (ENDS_THE_CALLER.has(`${method} ${path}`)) continue;
      const url = new URL(`https://example.com${path}`);
      for (const [k, v] of Object.entries(PARAMS)) url.searchParams.set(k, v);
      const init = { method, headers: { "x-session-token": token, "content-type": "application/json", "cf-connecting-ip": "198.51.100.1" } };
      if (method !== "GET") init.body = JSON.stringify(BODY);
      let res;
      try {
        res = await worker.fetch(new Request(url, init), env, { waitUntil() {}, passThroughOnException() {} });
      } catch {
        continue;
      }
      const text = await res.text().catch(() => "");
      const at = text.indexOf(MARK);
      if (at >= 0) leaks.push(`${method} ${path} → ${res.status}: …${text.slice(Math.max(0, at - 120), at + 12)}`);
      if (changes) {
        const now = await victimRows();
        const touched = Object.keys(now).filter((t) => now[t] !== rows[t]);
        if (touched.length) changes.push(`${method} ${path} → ${res.status}: ${touched.join(", ")}`);
        rows = now;
      }
    }
  }
  // Still signed in at the end, or the walk proved nothing.
  const { getSession } = await import("../src/db.js");
  expect(await getSession(env.DB, token)).toBeTruthy();
  return leaks;
}

test("the walk sees the workspace's data when its own member asks", { timeout: 300_000 }, async () => {
  const { createSession } = await import("../src/db.js");
  const vic = await createSession(env.DB, "9601", "gho_vic");
  const seen = await walk(vic, { methods: ["GET"] });
  expect(seen.length).toBeGreaterThan(3);
});

test("nothing of a workspace reaches, or is changed by, someone outside it", { timeout: 300_000 }, async () => {
  const before = await victimRows();
  expect(await walk(mal)).toEqual([]);
  const after = await victimRows();
  const changed = Object.keys(after).filter((t) => after[t] !== before[t]);
  expect(changed).toEqual([]);
});

// The workspace's own rules — here its allowed networks — on every route:
// two routes checked membership and skipped them.
test("a member outside the workspace's allowed networks gets nothing from any route", { timeout: 300_000 }, async () => {
  const { createSession } = await import("../src/db.js");
  const vic = await createSession(env.DB, "9601", "gho_vic");
  await env.DB.prepare("INSERT INTO org_governance (org_id, ip_enforce, ip_allowlist, updated_by, updated_at) VALUES (?1, 1, '[\"203.0.113.0/24\"]', '9601', ?2)")
    .bind(VICTIM, new Date().toISOString()).run();
  (await import("../src/governance.js")).forgetGovernance();
  const changes = [];
  // The switcher still lists the workspaces you are in, by the name each is
  // shown under (a person's, for one nobody named), so it can say why one
  // will not open. Nothing said or decided in it.
  const leaks = (await walk(vic, { changes })).filter((l) => !/^GET \/me → 200: .*"orgs":\[\{"id":"team:victim"[^}]*"founder":"Eve VICTIM7f3c",$/.test(l));
  expect(leaks).toEqual([]);
  expect(changes).toEqual([]);
});
