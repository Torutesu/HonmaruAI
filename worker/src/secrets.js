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
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(String(text)), (c) => c.charCodeAt(0));

let raw = null;
let keyPromise = null;

/// The key for this isolate, from the Worker's secrets. Called at the top of
/// every entry point; the same deployment always hands the same value.
export function useSecretKey(env) {
  const next = env?.DATA_KEY || null;
  if (next === raw) return;
  raw = next;
  keyPromise = next
    ? crypto.subtle.importKey("raw", unb64(next), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
    : null;
}

export const isSealed = (value) => typeof value === "string" && value.startsWith(PREFIX);

/// `plain` sealed for `context` (e.g. `org_github.token:<orgId>`). Empty
/// values and the no-key case pass through.
export async function sealField(plain, context) {
  if (plain === null || plain === undefined || plain === "" || !keyPromise || isSealed(plain)) return plain;
  const key = await keyPromise;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(context) }, key, enc.encode(String(plain))
  );
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

/// The plain value back. A value that will not open (another row's, or a key
/// that is not this deployment's) reads as missing rather than as garbage.
export async function openField(stored, context) {
  if (!isSealed(stored)) return stored ?? null;
  if (!keyPromise) return null;
  const [iv, ct] = stored.slice(PREFIX.length).split(":");
  try {
    const key = await keyPromise;
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
      await sealField(r.openai_key, aad.aiKey(r.org_id, "openai_key")),
      await sealField(r.typesafe_key, aad.aiKey(r.org_id, "typesafe_key")),
      await sealField(r.gemini_key, aad.aiKey(r.org_id, "gemini_key")),
    ).run();
    sealed += 1;
  }

  const { results: gh = [] } = await db.prepare(`SELECT org_id, token FROM org_github WHERE ${plain("token")} LIMIT ?1`).bind(limit).all();
  for (const r of gh) {
    await db.prepare("UPDATE org_github SET token = ?2 WHERE org_id = ?1 AND token = ?3")
      .bind(r.org_id, await sealField(r.token, aad.githubWorkspace(r.org_id)), r.token).run();
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
      await sealField(r.api_key, aad.teammate(r.org_id, r.provider, "api_key")),
      await sealField(r.github_token, aad.teammate(r.org_id, r.provider, "github_token")),
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
