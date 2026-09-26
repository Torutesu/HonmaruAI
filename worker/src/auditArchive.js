// The audit log, sealed hour by hour where nobody can quietly rewrite it.
//
// docs/audit-log-phase2.md §3. Each hour's rows are written to R2 as they
// are stored (people still encrypted), and a digest of them — the hash chain's
// first and last links, the archive's own hash, the digest before it — is
// signed with an Ed25519 key only this Worker holds. The bucket is locked for
// the retention period, and the public key is published, so anyone holding
// the files can check nothing was removed or changed, without asking us.

import { sha256Hex } from "./auth.js";
import { audit } from "./audit.js";
import { safe } from "./log.js";

const enc = new TextEncoder();
const HOUR = 3_600_000;
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(String(text)), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (text) => unb64(String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text).length + 3) % 4));

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/// Whether this deployment seals: a bucket and a signing key.
export function archiveReady(env) {
  return Boolean(env?.AUDIT_ARCHIVE && env?.AUDIT_SIGNING_KEY);
}

let signing = null; // { secret, privateKey, publicJwk, kid }
async function signingKey(env) {
  if (signing && signing.secret === env.AUDIT_SIGNING_KEY) return signing;
  const privateKey = await crypto.subtle.importKey("pkcs8", unb64(env.AUDIT_SIGNING_KEY), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  const kid = `ed25519-${(await sha256Hex(jwk.x)).slice(0, 16)}`;
  signing = { secret: env.AUDIT_SIGNING_KEY, privateKey, publicJwk: { ...publicJwk, kid, alg: "EdDSA", use: "sig" }, kid };
  return signing;
}

/// The public keys digests are signed with: this one, and any earlier ones
/// an operator lists in AUDIT_PAST_PUBLIC_KEYS (a JSON array of JWKs).
export async function publicKeys(env) {
  const keys = [];
  if (env?.AUDIT_SIGNING_KEY) keys.push((await signingKey(env)).publicJwk);
  try { for (const k of JSON.parse(env?.AUDIT_PAST_PUBLIC_KEYS || "[]")) keys.push(k); } catch { /* none */ }
  return keys;
}

/// Check a digest's signature against the published keys.
export async function verifyDigest(digest, keys) {
  const { sig, ...signed } = digest || {};
  const jwk = (keys || []).find((k) => k.kid === signed.key_id);
  if (!jwk || !sig) return false;
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, unb64url(sig), enc.encode(canonical(signed)));
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Bytes = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));

/// Where an hour of a workspace's log lives in the bucket.
export function archivePath(orgId, hourStart) {
  const d = new Date(hourStart);
  const p = (n) => String(n).padStart(2, "0");
  return `audit/${encodeURIComponent(orgId)}/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCHours())}`;
}

/// Seal one hour of one workspace: archive, digest, signature, and the row
/// that says it was done. Hours are sealed in order; an hour with no rows
/// is skipped (the digests' own chain covers the gap).
export async function sealHour(env, orgId, hourStart) {
  const from = Math.floor(hourStart / 1000);
  const to = Math.floor((hourStart + HOUR) / 1000);
  const { results } = await env.DB.prepare(
    "SELECT seq, id, created_at, body, prev_hash, hash FROM audit_events WHERE org_id = ?1 AND created_at >= ?2 AND created_at < ?3 ORDER BY seq"
  ).bind(orgId, from, to).all();
  const rows = results || [];
  if (!rows.length) return null;
  const path = archivePath(orgId, hourStart);
  const jsonl = rows.map((r) => JSON.stringify({ seq: r.seq, id: r.id, created_at: r.created_at, prev_hash: r.prev_hash, hash: r.hash, body: JSON.parse(r.body) })).join("\n") + "\n";
  const archive = await gzip(jsonl);
  const archiveSha = await sha256Bytes(archive);
  const last = await env.DB.prepare("SELECT digest_sha256 FROM audit_seals WHERE org_id = ?1 ORDER BY hour DESC LIMIT 1").bind(orgId).first();
  const key = await signingKey(env);
  const digest = {
    v: 1,
    org: orgId,
    hour: new Date(hourStart).toISOString(),
    from_seq: rows[0].seq,
    to_seq: rows[rows.length - 1].seq,
    count: rows.length,
    first_hash: rows[0].hash,
    last_hash: rows[rows.length - 1].hash,
    first_prev_hash: rows[0].prev_hash || null,
    prev_digest: last?.digest_sha256 || null,
    archive_sha256: archiveSha,
    sealed_at: new Date().toISOString(),
    key_id: key.kid,
  };
  digest.sig = b64url(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, enc.encode(canonical(digest))));
  const digestText = JSON.stringify(digest);
  // Never over an object already there: a sealed hour stays as sealed.
  if (!(await env.AUDIT_ARCHIVE.head(`${path}.jsonl.gz`))) {
    await env.AUDIT_ARCHIVE.put(`${path}.jsonl.gz`, archive, { httpMetadata: { contentType: "application/gzip" } });
  }
  if (!(await env.AUDIT_ARCHIVE.head(`${path}.digest.json`))) {
    await env.AUDIT_ARCHIVE.put(`${path}.digest.json`, digestText, { httpMetadata: { contentType: "application/json" } });
  }
  const digestSha = await sha256Hex(digestText);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO audit_seals (org_id, hour, from_seq, to_seq, digest_sha256, sealed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(orgId, digest.hour, digest.from_seq, digest.to_seq, digestSha, digest.sealed_at).run();
  return digest;
}

/// The hours of a workspace still to seal: complete hours after the last
/// sealed one that hold rows, oldest first.
async function hoursToSeal(env, orgId, before) {
  const last = await env.DB.prepare("SELECT hour, to_seq FROM audit_seals WHERE org_id = ?1 ORDER BY hour DESC LIMIT 1").bind(orgId).first();
  const after = last ? Math.floor((Date.parse(last.hour) + HOUR) / 1000) : 0;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT (created_at / 3600) * 3600 AS h FROM audit_events WHERE org_id = ?1 AND created_at >= ?2 AND created_at < ?3 ORDER BY h LIMIT 24`
  ).bind(orgId, after, Math.floor(before / 1000)).all();
  return (results || []).map((r) => Number(r.h) * 1000);
}

/// From the 15-minute cron, once an hour: seal what the last hours left,
/// a few workspaces at a time. After three hours of failing for one
/// workspace, that is recorded as critical and the operators are told.
export async function sealPending(env, { now = Date.now(), orgLimit = 20 } = {}) {
  if (!archiveReady(env)) return [];
  const currentHour = Math.floor(now / HOUR) * HOUR;
  const { results } = await env.DB.prepare(
    `SELECT e.org_id FROM audit_events e
      WHERE e.created_at < ?1 AND e.seq > COALESCE((SELECT MAX(s.to_seq) FROM audit_seals s WHERE s.org_id = e.org_id), 0)
      GROUP BY e.org_id LIMIT ?2`
  ).bind(Math.floor(currentHour / 1000), orgLimit).all();
  const sealed = [];
  for (const r of results || []) {
    try {
      for (const hour of await hoursToSeal(env, r.org_id, currentHour)) {
        const d = await sealHour(env, r.org_id, hour);
        if (d) sealed.push({ orgId: r.org_id, hour: d.hour, count: d.count });
      }
      await env.DB.prepare("DELETE FROM audit_seal_failures WHERE org_id = ?1").bind(r.org_id).run().catch(() => {});
    } catch (err) {
      console.error("audit seal failed", r.org_id, safe(err?.message));
      const row = await env.DB.prepare(
        `INSERT INTO audit_seal_failures (org_id, first_failed_at, last_error) VALUES (?1, ?2, ?3)
         ON CONFLICT(org_id) DO UPDATE SET last_error = excluded.last_error RETURNING first_failed_at, alerted`
      ).bind(r.org_id, new Date(now).toISOString(), safe(err?.message).slice(0, 300)).first().catch(() => null);
      if (row && !row.alerted && now - Date.parse(row.first_failed_at) >= 3 * HOUR) {
        await audit(env, null, { orgId: r.org_id, action: "audit.seal_failed", actor: { type: "system" }, details: { error: safe(err?.message).slice(0, 200) } });
        const { alert } = await import("./alert.js");
        alert({ waitUntil: () => {} }, env, "audit-seal", `sealing the audit log of ${r.org_id} has failed for three hours: ${safe(err?.message)}`);
        await env.DB.prepare("UPDATE audit_seal_failures SET alerted = 1 WHERE org_id = ?1").bind(r.org_id).run().catch(() => {});
      }
    }
  }
  return sealed;
}

/// Check the sealed hours of a range against D1 and against each other:
/// every digest signed by our key, every archive the file its digest names,
/// every digest pointing at the one before, and D1's rows at the ends of
/// each hour the ones the digest recorded.
export async function verifyArchive(env, orgId, { fromHour = 0, toHour = Date.now() } = {}) {
  if (!archiveReady(env)) return { ok: true, checked_hours: 0, skipped: "no archive" };
  const keys = await publicKeys(env);
  const { results } = await env.DB.prepare(
    "SELECT hour, from_seq, to_seq, digest_sha256 FROM audit_seals WHERE org_id = ?1 AND hour >= ?2 AND hour <= ?3 ORDER BY hour"
  ).bind(orgId, new Date(fromHour).toISOString(), new Date(toHour).toISOString()).all();
  let prevDigest = null;
  let first = true;
  for (const s of results || []) {
    const path = archivePath(orgId, Date.parse(s.hour));
    const digestObj = await env.AUDIT_ARCHIVE.get(`${path}.digest.json`);
    if (!digestObj) return { ok: false, checked_hours: 0, first_problem: { kind: "missing", hour: s.hour } };
    const digestText = await digestObj.text();
    const digest = JSON.parse(digestText);
    if ((await sha256Hex(digestText)) !== s.digest_sha256) return { ok: false, first_problem: { kind: "digest", hour: s.hour } };
    if (!(await verifyDigest(digest, keys))) return { ok: false, first_problem: { kind: "digest_sig", hour: s.hour } };
    if (!first && digest.prev_digest !== prevDigest) return { ok: false, first_problem: { kind: "gap", hour: s.hour } };
    const archiveObj = await env.AUDIT_ARCHIVE.get(`${path}.jsonl.gz`);
    if (!archiveObj) return { ok: false, first_problem: { kind: "missing", hour: s.hour } };
    const archive = new Uint8Array(await archiveObj.arrayBuffer());
    if ((await sha256Bytes(archive)) !== digest.archive_sha256) return { ok: false, first_problem: { kind: "archive", hour: s.hour } };
    // D1's rows, where they are still kept, match what was sealed.
    const ends = await env.DB.prepare("SELECT seq, hash FROM audit_events WHERE org_id = ?1 AND seq IN (?2, ?3)").bind(orgId, digest.from_seq, digest.to_seq).all();
    for (const r of ends.results || []) {
      const want = r.seq === digest.from_seq ? digest.first_hash : digest.last_hash;
      if (r.hash !== want) return { ok: false, first_problem: { kind: "hash", seq: r.seq, hour: s.hour } };
    }
    prevDigest = s.digest_sha256;
    first = false;
  }
  return { ok: true, checked_hours: (results || []).length };
}

/// Every workspace's last eight days, weekly. A failure is critical, and
/// every owner is told.
export async function weeklyVerify(env, { now = Date.now(), orgLimit = 50 } = {}) {
  if (!archiveReady(env)) return [];
  const { results } = await env.DB.prepare("SELECT DISTINCT org_id FROM audit_seals LIMIT ?1").bind(orgLimit).all();
  const problems = [];
  for (const r of results || []) {
    const out = await verifyArchive(env, r.org_id, { fromHour: now - 8 * 24 * HOUR, toHour: now }).catch((err) => ({ ok: false, first_problem: { kind: "error", message: safe(err?.message) } }));
    if (out.ok) continue;
    problems.push({ orgId: r.org_id, ...out.first_problem });
    await audit(env, null, { orgId: r.org_id, action: "security.anomaly", actor: { type: "system" }, details: { check: "audit_archive", problem: out.first_problem } });
    const { mailOwners } = await import("./owners.js");
    await mailOwners(env, r.org_id, {
      subject: "The audit log did not verify",
      text: `This week's check of your workspace's audit log found a problem (${out.first_problem?.kind || "unknown"}). We are looking into it. Nothing needs doing on your side.`,
    });
  }
  return problems;
}
