// Secrets kept in D1 columns — a workspace's AI keys, its GitHub token, a
// person's GitHub token on their session, a webhook's signing secret — sealed
// with AES-GCM under DATA_KEY (docs/architecture/discord-model-platform-plan.md §8.2).
//
// A sealed value reads `enc:v1:<iv>:<ciphertext>`. The associated data names
// the column and the row's owner, so a value copied into another workspace's
// row, or another column, does not open. Anything without the prefix is a value
// written before sealing existed and is returned as it is; `sealLegacySecrets`
// moves those over. With no DATA_KEY set (a fresh deployment, the tests)
// values are stored as they come, the way they were before.
//
// DATA_KEY is made once by the deploy workflow and never replaced: replacing
// it would make every sealed value unreadable. A later key gets a new version
// prefix, and both are kept until everything is sealed again.

const PREFIX = "enc:v1:";
/// Sealed under the workspace's own key: `enc:v2:<workspace>:<iv>:<ct>`.
/// Each workspace's key is random, kept wrapped under DATA_KEY
/// (workspace_keys), and deleted with the workspace — which leaves whatever
/// was sealed under it unreadable anywhere it was copied (a backup, an
/// export). Values sealed before, under DATA_KEY itself, still open.
const PREFIX_V2 = "enc:v2:";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(String(text)), (c) => c.charCodeAt(0));

let raw = null;
let keyPromise = null;
let db = null;
const workspaceKeys = new Map(); // orgId -> Promise<CryptoKey | null>

/// The key for this isolate, from the Worker's secrets. Called at the top of
/// every entry point; the same deployment always hands the same value.
export function useSecretKey(env) {
  db = env?.DB || db;
  const next = env?.DATA_KEY || null;
  if (next === raw) return;
  raw = next;
  workspaceKeys.clear();
  keyPromise = next
    ? crypto.subtle.importKey("raw", unb64(next), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
    : null;
}

export const isSealed = (value) => typeof value === "string" && (value.startsWith(PREFIX) || value.startsWith(PREFIX_V2));

const b64url = (text) => b64(enc.encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (text) => dec.decode(unb64(String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text).length + 3) % 4)));

/// A workspace's own key, made the first time one is needed when `create`.
async function workspaceKey(orgId, { create = false } = {}) {
  if (!keyPromise || !db || !orgId) return null;
  const hit = workspaceKeys.get(orgId);
  if (hit) {
    const key = await hit;
    if (key || !create) return key;
  }
  const load = (async () => {
    const master = await keyPromise;
    const context = enc.encode(`workspace_keys:${orgId}`);
    let row = await db.prepare("SELECT wrapped FROM workspace_keys WHERE org_id = ?1").bind(orgId).first();
    if (!row && create) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const fresh = crypto.getRandomValues(new Uint8Array(32));
      const wrapped = `${b64(iv)}:${b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context }, master, fresh))}`;
      // Two first uses at once: one wins, and both read the winner.
      await db.prepare("INSERT OR IGNORE INTO workspace_keys (org_id, wrapped, created_at) VALUES (?1, ?2, ?3)").bind(orgId, wrapped, new Date().toISOString()).run();
      row = await db.prepare("SELECT wrapped FROM workspace_keys WHERE org_id = ?1").bind(orgId).first();
    }
    if (!row) return null;
    const [iv, ct] = String(row.wrapped).split(":");
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: context }, master, unb64(ct));
    return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })().catch(() => null);
  workspaceKeys.set(orgId, load);
  return load;
}

/// Forget the workspace keys this isolate holds (a deleted workspace).
export function forgetWorkspaceKey(orgId) { workspaceKeys.delete(orgId); }

/// `plain` sealed for `context` (e.g. `org_github.token:<orgId>`), under the
/// workspace's own key when `orgId` names one. Empty values and the no-key
/// case pass through.
export async function sealField(plain, context, orgId = null) {
  if (plain === null || plain === undefined || plain === "" || !keyPromise || isSealed(plain)) return plain;
  const own = orgId ? await workspaceKey(orgId, { create: true }) : null;
  const key = own || await keyPromise;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(context) }, key, enc.encode(String(plain))
  );
  return own ? `${PREFIX_V2}${b64url(orgId)}:${b64(iv)}:${b64(ct)}` : `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

/// The plain value back. A value that will not open (another row's, a
/// deleted workspace's, or a key that is not this deployment's) reads as
/// missing rather than as garbage.
export async function openField(stored, context) {
  if (!isSealed(stored)) return stored ?? null;
  if (!keyPromise) return null;
  try {
    let key; let iv; let ct;
    if (stored.startsWith(PREFIX_V2)) {
      const [org, i, c] = stored.slice(PREFIX_V2.length).split(":");
      key = await workspaceKey(unb64url(org));
      iv = i; ct = c;
    } else {
      [iv, ct] = stored.slice(PREFIX.length).split(":");
      key = await keyPromise;
    }
    if (!key) return null;
    return dec.decode(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(context) }, key, unb64(ct)
    ));
  } catch {
    return null;
  }
}

// The associated data for each sealed column.
export const aad = {
  aiKey: (orgId, column) => `org_ai_settings.${column}:${orgId}`,
  githubWorkspace: (orgId) => `org_github.token:${orgId}`,
  sessionGithub: (token) => `sessions.github_access_token:${token}`,
  webhook: (id) => `org_webhooks.secret:${id}`,
  teammate: (orgId, provider, column) => `ai_teammates.${column}:${orgId}:${provider}`,
  appleRefresh: (subject) => `apple_identities.refresh_token:${subject}`,
  remoteMcpHeaders: (orgId, id) => `hx_remote_mcp_servers.auth_headers:${orgId}:${id}`,
  remoteMcpOAuthClient: (orgId, id) => `hx_remote_mcp_servers.oauth_client:${orgId}:${id}`,
  remoteMcpOAuthVerifier: (orgId, stateHash) => `hx_remote_mcp_oauth_states.code_verifier:${orgId}:${stateHash}`,
  remoteMcpOAuthCredential: (orgId, serverId, userId, membershipSince) => `hx_remote_mcp_oauth_credentials.credential:${orgId}:${serverId}:${userId}:${membershipSince}`,
};

// Values that mark a session without a GitHub token; not secrets.
const NOT_SECRET = new Set(["email-auth"]);

/// Rows written before sealing, sealed — a batch per table per run, until
/// none are left. Nothing happens without a key.
export async function sealLegacySecrets(env, { limit = 200, now = Date.now() } = {}) {
  useSecretKey(env);
  if (!keyPromise) return { sealed: 0 };
  const db = env.DB;
  // Once a run finds nothing left, once a day is enough: every value is
  // sealed as it is written, so only rows from before the key can be plain,
  // and the "NOT LIKE 'enc:%'" below reads five tables end to end.
  const clean = await db.prepare("SELECT value FROM kv WHERE key = 'secrets:all-sealed'").first().catch(() => null);
  if (clean && now - Date.parse(clean.value) < 86_400_000) return { sealed: 0, skipped: true };
  let sealed = 0;
  const plain = (column) => `${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT LIKE 'enc:%'`;

  const { results: ai = [] } = await db.prepare(
    `SELECT org_id, openai_key, typesafe_key, gemini_key FROM org_ai_settings
      WHERE (${plain("openai_key")}) OR (${plain("typesafe_key")}) OR (${plain("gemini_key")}) LIMIT ?1`
  ).bind(limit).all();
  for (const r of ai) {
    await db.prepare("UPDATE org_ai_settings SET openai_key = ?2, typesafe_key = ?3, gemini_key = ?4 WHERE org_id = ?1").bind(
      r.org_id,
      await sealField(r.openai_key, aad.aiKey(r.org_id, "openai_key"), r.org_id),
      await sealField(r.typesafe_key, aad.aiKey(r.org_id, "typesafe_key"), r.org_id),
      await sealField(r.gemini_key, aad.aiKey(r.org_id, "gemini_key"), r.org_id),
    ).run();
    sealed += 1;
  }

  const { results: gh = [] } = await db.prepare(`SELECT org_id, token FROM org_github WHERE ${plain("token")} LIMIT ?1`).bind(limit).all();
  for (const r of gh) {
    await db.prepare("UPDATE org_github SET token = ?2 WHERE org_id = ?1 AND token = ?3")
      .bind(r.org_id, await sealField(r.token, aad.githubWorkspace(r.org_id), r.org_id), r.token).run();
    sealed += 1;
  }

  const { results: sessions = [] } = await db.prepare(
    `SELECT token, github_access_token FROM sessions WHERE ${plain("github_access_token")} AND github_access_token NOT IN ('email-auth') LIMIT ?1`
  ).bind(limit).all();
  for (const r of sessions) {
    if (NOT_SECRET.has(r.github_access_token)) continue;
    await db.prepare("UPDATE sessions SET github_access_token = ?2 WHERE token = ?1 AND github_access_token = ?3")
      .bind(r.token, await sealField(r.github_access_token, aad.sessionGithub(r.token)), r.github_access_token).run();
    sealed += 1;
  }

  const { results: mates = [] } = await db.prepare(
    `SELECT org_id, provider, api_key, github_token FROM ai_teammates WHERE (${plain("api_key")}) OR (${plain("github_token")}) LIMIT ?1`
  ).bind(limit).all().catch(() => ({ results: [] }));
  for (const r of mates) {
    await db.prepare("UPDATE ai_teammates SET api_key = ?3, github_token = ?4 WHERE org_id = ?1 AND provider = ?2").bind(
      r.org_id, r.provider,
      await sealField(r.api_key, aad.teammate(r.org_id, r.provider, "api_key"), r.org_id),
      await sealField(r.github_token, aad.teammate(r.org_id, r.provider, "github_token"), r.org_id),
    ).run();
    sealed += 1;
  }

  const { results: hooks = [] } = await db.prepare(`SELECT id, secret FROM org_webhooks WHERE ${plain("secret")} LIMIT ?1`).bind(limit).all();
  for (const r of hooks) {
    await db.prepare("UPDATE org_webhooks SET secret = ?2 WHERE id = ?1 AND secret = ?3")
      .bind(r.id, await sealField(r.secret, aad.webhook(r.id)), r.secret).run();
    sealed += 1;
  }
  if (!sealed) {
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('secrets:all-sealed', ?1, ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(new Date(now).toISOString()).run().catch(() => {});
  }
  return { sealed };
}

/// A session's GitHub token, however it was stored.
export async function openSessionToken(row) {
  if (!row || !row.github_access_token || NOT_SECRET.has(row.github_access_token)) return row;
  return { ...row, github_access_token: await openField(row.github_access_token, aad.sessionGithub(row.token)) };
}

/// A session's GitHub token as it should be stored.
export async function sealSessionToken(token, accessToken) {
  if (!accessToken || NOT_SECRET.has(accessToken)) return accessToken;
  return sealField(accessToken, aad.sessionGithub(token));
}
