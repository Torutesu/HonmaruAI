// The people in the audit log, each under a key of their own.
//
// docs/audit-log-phase2.md §2. Whatever names a person — their login, their
// name, the address and browser they acted from — is encrypted with a key
// that belongs to that person in that workspace. When they delete their
// account the key is thrown away: the rows stay, the chain of hashes over
// them still verifies, and nobody, the operator included, can read who they
// were again. What stays is a pseudonym, `p_…`, the same for every row about
// the same person in the same workspace, so a trail can still be followed.
//
// Two Worker secrets: AUDIT_MASTER_KEY wraps each person's key (AES-KW),
// AUDIT_PSEUDONYM_KEY makes the pseudonyms (HMAC). Both are 32 random bytes,
// base64. Without them the log is written as phase 1 wrote it, in the clear.

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEY_TTL_MS = 60_000;
const cache = new Map(); // `${orgId}|${principal}` -> { key, at } | { shredded, at }
const imported = new Map(); // secret -> CryptoKey

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(String(text)), (c) => c.charCodeAt(0));
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/// Whether this deployment encrypts its audit log.
export function auditCryptoReady(env) {
  return Boolean(env?.AUDIT_MASTER_KEY && env?.AUDIT_PSEUDONYM_KEY);
}

async function importOnce(secret, algorithm, usages) {
  const id = `${algorithm.name}:${secret}`;
  if (!imported.has(id)) {
    imported.set(id, crypto.subtle.importKey("raw", unb64(secret), algorithm, false, usages));
  }
  return imported.get(id);
}

const masterKey = (env) => importOnce(env.AUDIT_MASTER_KEY, { name: "AES-KW" }, ["wrapKey", "unwrapKey"]);
const pseudonymKey = (env) => importOnce(env.AUDIT_PSEUDONYM_KEY, { name: "HMAC", hash: "SHA-256" }, ["sign"]);

async function hmacHex(env, text) {
  return hex(await crypto.subtle.sign("HMAC", await pseudonymKey(env), enc.encode(text)));
}

/// A person's pseudonym in one workspace.
export async function principalOf(env, orgId, login) {
  return `p_${(await hmacHex(env, `${orgId}\u0000${login}`)).slice(0, 16)}`;
}

/// The same person across every workspace: how their keys are found to be
/// thrown away together. Never shown; it only joins rows.
export async function subjectOf(env, login) {
  return (await hmacHex(env, `subject\u0000${login}`)).slice(0, 32);
}

/// A person's key in a workspace, made when `create` and they have none.
/// Null when it has been thrown away, or does not exist and was not asked for.
export async function keyFor(env, orgId, principal, { login = null, create = false } = {}) {
  const id = `${orgId}|${principal}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.shredded ? null : hit.key;
  let row = await env.DB.prepare("SELECT wrapped_key, shredded_at FROM audit_principal_keys WHERE org_id = ?1 AND principal = ?2")
    .bind(orgId, principal).first();
  if (!row && create) {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const wrapped = await crypto.subtle.wrapKey("raw", key, await masterKey(env), { name: "AES-KW" });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO audit_principal_keys (org_id, principal, subject, wrapped_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(orgId, principal, login ? await subjectOf(env, login) : null, `v1:${b64(wrapped)}`, new Date().toISOString()).run();
    // Read back: another request may have made it first, and theirs won.
    row = await env.DB.prepare("SELECT wrapped_key, shredded_at FROM audit_principal_keys WHERE org_id = ?1 AND principal = ?2")
      .bind(orgId, principal).first();
  }
  if (!row) return null;
  if (!row.wrapped_key) {
    cache.set(id, { shredded: true, at: Date.now() });
    return null;
  }
  const [, material] = String(row.wrapped_key).split(":");
  const key = await crypto.subtle.unwrapKey("raw", unb64(material), await masterKey(env), { name: "AES-KW" },
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  cache.set(id, { key, at: Date.now() });
  return key;
}

/// Whether a principal's key has been thrown away.
export async function isShredded(env, orgId, principal) {
  const row = await env.DB.prepare("SELECT wrapped_key FROM audit_principal_keys WHERE org_id = ?1 AND principal = ?2")
    .bind(orgId, principal).first();
  return Boolean(row) && !row.wrapped_key;
}

export async function seal(key, principal, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return { k: principal, iv: b64(iv), ct: b64(ct) };
}

export async function unseal(key, sealed) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
  return JSON.parse(dec.decode(plain));
}

const isPerson = (p) => p && (p.type === "user" || p.type === "agent") && p.id;

/// A person as the log stores them: their pseudonym, and who they are under
/// their own key. A person whose key is already gone is stored by pseudonym
/// alone — there is nothing left to encrypt them to.
async function hide(env, orgId, p) {
  if (!isPerson(p)) return { stored: p, principal: null, key: null };
  const principal = await principalOf(env, orgId, p.id);
  const key = await keyFor(env, orgId, principal, { login: p.id, create: true });
  const { id, name, ...rest } = p;
  const stored = { ...rest, principal, pii: key ? await seal(key, principal, { id, name: name ?? null }) : null };
  return { stored, principal, key };
}

/// An event body with every person in it encrypted. Returns the body and the
/// pseudonyms the row is indexed by.
export async function encryptBody(env, orgId, body) {
  const actor = await hide(env, orgId, body.actor);
  const entity = await hide(env, orgId, body.entity);
  const context = { ...(body.context || {}) };
  const personal = { ip_address: context.ip_address ?? null, ua: context.ua ?? null };
  delete context.ip_address;
  delete context.ua;
  // Where someone acted from is theirs: it goes under the actor's key. An
  // action nobody took (the system) has nobody to hide it for.
  if (actor.key) context.pii = await seal(actor.key, actor.principal, personal);
  else if (!actor.principal) Object.assign(context, personal);
  return {
    body: { ...body, v: 2, actor: actor.stored, entity: entity.stored, context },
    actorId: actor.principal || body.actor?.id || null,
    entityId: entity.principal || body.entity?.id || null,
  };
}

async function reveal(env, orgId, p, keys) {
  if (!p || !p.principal) return p;
  const { principal, pii, ...rest } = p;
  let key = keys.get(principal);
  if (key === undefined) {
    key = await keyFor(env, orgId, principal).catch(() => null);
    keys.set(principal, key);
  }
  if (!key || !pii) return { ...rest, id: null, name: null, deleted: true, principal };
  try {
    return { ...rest, ...(await unseal(key, pii)), principal };
  } catch {
    return { ...rest, id: null, name: null, deleted: true, principal };
  }
}

/// An event body as phase 1 wrote it, whichever way it was stored: people
/// back by login and name, or marked deleted where their key is gone.
export async function decryptBody(env, orgId, body, keys = new Map()) {
  if (body?.v !== 2) return body;
  const actor = await reveal(env, orgId, body.actor, keys);
  const entity = await reveal(env, orgId, body.entity, keys);
  const { pii, ...context } = body.context || {};
  if (pii) {
    const key = keys.has(pii.k) ? keys.get(pii.k) : await keyFor(env, orgId, pii.k).catch(() => null);
    keys.set(pii.k, key);
    if (key) {
      try { Object.assign(context, await unseal(key, pii)); } catch { /* unreadable: left out */ }
    }
  }
  const { v, ...rest } = body;
  return { ...rest, actor, entity, context };
}

/// Throw away every key this person has, in every workspace. Returns the
/// workspaces and pseudonyms whose keys went, so each can record it.
export async function shredPerson(env, login) {
  if (!auditCryptoReady(env) || !login) return [];
  const subject = await subjectOf(env, login);
  // A key under a legal hold stays until the hold is lifted, and then goes.
  await env.DB.prepare("UPDATE audit_principal_keys SET shred_pending = 1 WHERE subject = ?1 AND wrapped_key IS NOT NULL AND COALESCE(hold, 0) = 1")
    .bind(subject).run().catch(() => {});
  const { results } = await env.DB.prepare(
    "SELECT org_id, principal FROM audit_principal_keys WHERE subject = ?1 AND wrapped_key IS NOT NULL AND COALESCE(hold, 0) = 0"
  ).bind(subject).all();
  const now = new Date().toISOString();
  for (const r of results || []) {
    await env.DB.prepare("UPDATE audit_principal_keys SET wrapped_key = NULL, shredded_at = ?3 WHERE org_id = ?1 AND principal = ?2")
      .bind(r.org_id, r.principal, now).run();
    cache.delete(`${r.org_id}|${r.principal}`);
  }
  return (results || []).map((r) => ({ orgId: r.org_id, principal: r.principal }));
}

/// Throw away one pseudonym's key in one workspace, making it first if there
/// was none (a person deleted before their rows were encrypted).
export async function shredPrincipal(env, orgId, principal) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO audit_principal_keys (org_id, principal, subject, wrapped_key, created_at, shredded_at)
     VALUES (?1, ?2, NULL, NULL, ?3, ?3)
     ON CONFLICT(org_id, principal) DO UPDATE SET wrapped_key = NULL, shredded_at = excluded.shredded_at
       WHERE COALESCE(audit_principal_keys.hold, 0) = 0`
  ).bind(orgId, principal, now).run();
  cache.delete(`${orgId}|${principal}`);
}

/// Forget cached keys: for tests, and after a key is thrown away elsewhere.
export function forgetCachedKeys() {
  cache.clear();
}
