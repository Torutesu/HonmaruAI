// Loads the legacy store shape { [recipientUserID]: card[] } for one org,
// so the copied adapter.js functions can operate on it unchanged.
export async function loadStore(db, orgId) {
  const { results } = await db
    .prepare("SELECT data FROM cards WHERE org_id = ?1")
    .bind(orgId)
    .all();
  const store = {};
  for (const row of results) {
    const card = JSON.parse(row.data);
    (store[card.recipientUserID] ||= []).push(card);
  }
  return store;
}

export async function saveCard(db, orgId, card, { createOnly = false } = {}) {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO cards (org_id, card_id, recipient_user_id, sender_user_id, created_at, data,
                          status, priority, decided_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(org_id, card_id) ${createOnly ? "DO NOTHING" : `DO UPDATE SET
         recipient_user_id = excluded.recipient_user_id,
         sender_user_id = excluded.sender_user_id,
         data = excluded.data,
         status = excluded.status,
         priority = excluded.priority,
         decided_at = excluded.decided_at,
         updated_at = excluded.updated_at`}`
    )
    .bind(
      orgId,
      card.id,
      card.recipientUserID,
      card.senderUserID || null,
      card.createdAt || now,
      JSON.stringify(card),
      card.status || null,
      card.priority || null,
      card.decision?.decidedAt || null,
      now
    )
    .run();
  return result.meta.changes > 0;
}

// An update must not recreate a card deleted while the client was offline, or
// replace a newer mutation that landed during an asynchronous handler.
export async function replaceCard(db, orgId, card, expected) {
  const row = await db.prepare(
    `UPDATE cards SET data = ?3, status = ?4, priority = ?5, decided_at = ?6, updated_at = ?7
     WHERE org_id = ?1 AND card_id = ?2 AND data = ?8 RETURNING card_id`
  ).bind(
    orgId, card.id, JSON.stringify(card), card.status || null, card.priority || null,
    card.decision?.decidedAt || null, new Date().toISOString(), JSON.stringify(expected)
  ).first();
  return Boolean(row);
}

// Model work can finish after an approval, edit, filing, or deletion. Merge
// only its enrichment fields in SQL, conditional on the original source text;
// never write the stale full card that was sent to the model.
export async function mergeCardEnrichment(db, orgId, original, enriched) {
  const patch = {};
  if (enriched.localized !== original.localized) patch.localized = enriched.localized;
  if (enriched.business !== original.business) patch.business = enriched.business;
  if (!Object.keys(patch).length) return null;
  const row = await db.prepare(
    `UPDATE cards SET data = json_patch(data, ?3), updated_at = ?4
     WHERE org_id = ?1 AND card_id = ?2
       AND json_extract(data, '$.recipientUserID') IS ?5
       AND json_extract(data, '$.title') IS ?6
       AND json_extract(data, '$.summary') IS ?7
       AND json_extract(data, '$.context') IS ?8
       AND (?9 = 0 OR json_extract(data, '$.business') IS ?10)
     RETURNING data`
  ).bind(
    orgId, original.id, JSON.stringify(patch), new Date().toISOString(),
    original.recipientUserID, original.title ?? null, original.summary ?? null,
    original.context ?? null, Object.hasOwn(patch, "business") ? 1 : 0, original.business ?? null
  ).first();
  return row ? JSON.parse(row.data) : null;
}

// One card, without paying to deserialize the whole org. The relay needs this
// to answer "who does this card belong to?" before it lets anyone change it.
export async function getCard(db, orgId, cardId) {
  const row = await db
    .prepare("SELECT data FROM cards WHERE org_id = ?1 AND card_id = ?2")
    .bind(orgId, cardId)
    .first();
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export async function removeCard(db, orgId, cardId) {
  await db
    .prepare("DELETE FROM cards WHERE org_id = ?1 AND card_id = ?2")
    .bind(orgId, cardId)
    .run();
}

export async function clearCards(db, orgId) {
  await db.prepare("DELETE FROM cards WHERE org_id = ?1").bind(orgId).run();
}

/// Cards that landed on someone since a moment, newest first.
///
/// Used after a connector sync to find what it produced, by both callers: the
/// cron loop that notifies, and the HTTP route that announces. Reading them
/// back beats threading them out through syncAll, which reports counts and
/// would otherwise have to carry a payload only these two need.
export async function cardsCreatedSince(db, orgId, login, since) {
  const { results } = await db
    .prepare(
      `SELECT data FROM cards
       WHERE org_id = ?1 AND recipient_user_id = ?2 AND created_at >= ?3 AND status = 'pending'`
    )
    .bind(orgId, login, since)
    .all();
  return (results || [])
    .map((row) => { try { return JSON.parse(row.data); } catch { return null; } })
    .filter(Boolean);
}

export async function loadContexts(db, orgId) {
  const { results } = await db
    .prepare("SELECT user_id, data FROM contexts WHERE org_id = ?1")
    .bind(orgId)
    .all();
  const contexts = {};
  for (const row of results) contexts[row.user_id] = JSON.parse(row.data);
  return contexts;
}

export async function saveContext(db, orgId, userId, context) {
  await db
    .prepare(
      `INSERT INTO contexts (org_id, user_id, data) VALUES (?1, ?2, ?3)
       ON CONFLICT(org_id, user_id) DO UPDATE SET data = excluded.data`
    )
    .bind(orgId, userId, JSON.stringify(context))
    .run();
}

const SESSION_DAYS = 30;

export async function createSession(db, githubId, accessToken) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(token, githubId, accessToken, now.toISOString(), expires.toISOString())
    .run();
  return token;
}

// Half the window. Past this point an active session is extended; before it,
// nothing is written — the alternative is an UPDATE on every request for a
// deadline that is still weeks away.
const SESSION_SLIDE_AFTER_DAYS = 15;

export async function getSession(db, token) {
  if (!token) return null;
  const row = await db
    .prepare(
      "SELECT token, github_id, github_access_token, expires_at FROM sessions WHERE token = ?1"
    )
    .bind(token)
    .first();
  if (!row) return null;
  const now = new Date();
  // A NULL expiry is a session minted before expiry existed — still valid, so
  // shipping this does not sign out the people currently testing.
  if (row.expires_at && row.expires_at <= now.toISOString()) return null;

  // Use keeps you signed in. A fixed 30 days meant someone who opened the app
  // every morning was still signed out on day 31, with no warning and no way to
  // tell it from a bug. Absence is what should expire a session, not time.
  const remainingMs = row.expires_at ? Date.parse(row.expires_at) - now.getTime() : 0;
  if (!row.expires_at || remainingMs < SESSION_SLIDE_AFTER_DAYS * 24 * 60 * 60 * 1000) {
    const extended = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    try {
      await db
        .prepare("UPDATE sessions SET expires_at = ?1 WHERE token = ?2")
        .bind(extended, token)
        .run();
      row.expires_at = extended;
    } catch (err) {
      // Failing to extend is not failing to authenticate. The session is still
      // valid right now, which is the question that was asked.
      console.error("session slide failed", err?.message || err);
    }
  }
  return row;
}

const OAUTH_STATE_MINUTES = 10;

export async function createOAuthState(db) {
  const state = crypto.randomUUID();
  const now = new Date();
  await db
    .prepare("INSERT INTO oauth_states (state, created_at, expires_at) VALUES (?1, ?2, ?3)")
    .bind(
      state,
      now.toISOString(),
      new Date(now.getTime() + OAUTH_STATE_MINUTES * 60 * 1000).toISOString()
    )
    .run();
  return state;
}

// Delete first, then judge what came back. Checking for the row and deleting it
// afterwards leaves a window where two callbacks can both find it — and the
// whole point of a nonce is that it is spent exactly once.
export async function consumeOAuthState(db, state) {
  if (!state) return false;
  const row = await db
    .prepare("DELETE FROM oauth_states WHERE state = ?1 RETURNING expires_at")
    .bind(state)
    .first();
  if (!row) return false;
  return row.expires_at > new Date().toISOString();
}

/// Create or refresh a person.
///
/// `locale` is the language their notifications are written in. Pass it only
/// when you actually know it — a value here overwrites, an absence keeps what
/// is stored. Every caller used to write a literal "en", so loading the org
/// graph reset every teammate to English on every open, and the setting the
/// person had chosen lasted until the next time anyone looked at the team.
export async function upsertUser(db, { githubId, login, name, avatarUrl, locale }) {
  const known = normalizeLocale(locale);
  await db
    .prepare(
      `INSERT INTO users (github_id, login, name, avatar_url, locale, created_at)
       VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'en'), ?6)
       ON CONFLICT(github_id) DO UPDATE SET
         login = excluded.login, name = excluded.name,
         avatar_url = excluded.avatar_url,
         locale = COALESCE(?5, users.locale)`
    )
    .bind(String(githubId), login, name || null, avatarUrl || null, known, new Date().toISOString())
    .run();
}

/// A BCP 47 tag reduced to the part notifications are written in: "ja-JP" and
/// "ja" are the same language to a lock screen. Anything that does not look
/// like a language is null, which every caller treats as "unknown".
export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

export async function setUserLocale(db, githubId, locale) {
  const known = normalizeLocale(locale);
  if (!known) return false;
  const { meta } = await db
    .prepare("UPDATE users SET locale = ?2 WHERE github_id = ?1")
    .bind(String(githubId), known)
    .run();
  return (meta?.changes ?? 0) > 0;
}

/// The address notifications fall back to. Only for accounts that do not sign
/// in with one: an email account's address is its identity. Empty clears it.
export async function setUserEmail(db, githubId, email) {
  const id = String(githubId);
  if (id.startsWith("email:")) return { error: "This account signs in with its email address." };
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return { error: "Please enter a valid email." };
  if (value) {
    const taken = await db.prepare("SELECT github_id FROM users WHERE email = ?1 AND github_id != ?2").bind(value, id).first();
    if (taken) return { error: "That address belongs to another account." };
  }
  await db.prepare("UPDATE users SET email = ?2 WHERE github_id = ?1").bind(id, value || null).run();
  return { ok: true };
}

export async function setUserNotifyEmail(db, githubId, enabled) {
  await db
    .prepare("UPDATE users SET notify_email = ?2 WHERE github_id = ?1")
    .bind(String(githubId), enabled ? 1 : 0)
    .run();
}

export async function getUserByGithubId(db, githubId) {
  return (
    (await db
      .prepare(
        "SELECT github_id, login, name, avatar_url, locale, email, notify_email FROM users WHERE github_id = ?1"
      )
      .bind(String(githubId))
      .first()) || null
  );
}

export async function upsertMembership(db, orgId, githubId, role) {
  await db
    .prepare(
      `INSERT INTO memberships (org_id, user_github_id, role, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(org_id, user_github_id) DO UPDATE SET role = excluded.role`
    )
    .bind(orgId, String(githubId), role, new Date().toISOString())
    .run();
}

/// Remove everyone from an org except the github ids given.
///
/// Membership was only ever written, never withdrawn, so being removed from a
/// repository did not remove anyone from the organization it backs: the
/// relay's fast path trusts this table, and a session slides forward every
/// time it is used. Someone who left kept reading the team's decisions for as
/// long as they kept the app open.
///
/// `keep` empty is treated as "we learned nothing", not "nobody is a member".
/// GitHub answering with an empty list — or not answering — must not empty an
/// organization.
export async function retainMemberships(db, orgId, keep) {
  const ids = [...new Set((keep || []).map(String))].filter(Boolean);
  if (!ids.length) return { removed: 0 };
  const holes = ids.map((_, i) => `?${i + 2}`).join(", ");
  // GitHub is authoritative only for the members it issued. A collaborator list
  // says nothing about someone who joined by invite, so pruning against it
  // would evict every email member the moment anyone opened the org graph —
  // a removal nobody performed, as a side effect of a read. Those ids are
  // namespaced ("email:..."), so restricting the delete to numeric GitHub ids
  // keeps the authority where it belongs.
  // Entirely digits, not merely starting with one: GLOB '[0-9]*' would also
  // match a future id scheme that happened to begin with a digit, and the
  // whole point here is to delete only what GitHub issued.
  const githubOnly = "AND user_github_id NOT GLOB '*[^0-9]*'";
  const { meta } = await db
    .prepare(`DELETE FROM memberships WHERE org_id = ?1 AND user_github_id NOT IN (${holes}) ${githubOnly}`)
    .bind(orgId, ...ids)
    .run();
  // Agents belong to the person, so they go the same way.
  await db
    .prepare(`DELETE FROM agents WHERE org_id = ?1 AND user_github_id NOT IN (${holes}) ${githubOnly}`)
    .bind(orgId, ...ids)
    .run();
  return { removed: meta?.changes ?? 0 };
}

export async function upsertAgent(db, orgId, githubId, displayName) {
  await db
    .prepare(
      `INSERT INTO agents (id, org_id, user_github_id, display_name)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name`
    )
    .bind(`agent-${orgId}-${githubId}`, orgId, String(githubId), displayName)
    .run();
}

// Membership is checked against the NUMERIC github id (sessions.github_id),
// not the login that cards and events use.
export async function isMember(db, orgId, githubId) {
  const row = await db
    .prepare("SELECT 1 AS ok FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(githubId))
    .first();
  return Boolean(row);
}

// A row is written for every scanned item, including ones the triage rejected
// (card_id NULL). Without that, every sync re-reads and re-judges the same mail
// forever, paying the model to reach the same "no".
export async function isIngested(db, connector, externalId, githubId) {
  const row = await db
    .prepare(
      "SELECT 1 AS ok FROM ingested_items WHERE connector = ?1 AND external_id = ?2 AND user_github_id = ?3"
    )
    .bind(connector, externalId, String(githubId))
    .first();
  return Boolean(row);
}

export async function markIngested(db, { connector, externalId, githubId, orgId, cardId }) {
  await db
    .prepare(
      `INSERT INTO ingested_items (connector, external_id, user_github_id, org_id, card_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(connector, external_id, user_github_id) DO NOTHING`
    )
    .bind(connector, externalId, String(githubId), orgId, cardId || null, new Date().toISOString())
    .run();
}

// The AI meter lives here rather than on the device: the model call happens on
// the Worker and we pay for it, so a counter the user can reset by deleting the
// app is not a limit on our bill.
export async function usedToday(db, githubId, day) {
  const row = await db
    .prepare("SELECT used FROM ai_usage WHERE user_github_id = ?1 AND day = ?2")
    .bind(String(githubId), day)
    .first();
  return row ? Number(row.used) : 0;
}

export async function countAIUse(db, githubId, day) {
  await db
    .prepare(
      `INSERT INTO ai_usage (user_github_id, day, used) VALUES (?1, ?2, 1)
       ON CONFLICT(user_github_id, day) DO UPDATE SET used = used + 1`
    )
    .bind(String(githubId), day)
    .run();
}

export async function readEntitlement(db, githubId) {
  return (
    (await db
      .prepare("SELECT user_github_id, is_pro, checked_at FROM entitlements WHERE user_github_id = ?1")
      .bind(String(githubId))
      .first()) || null
  );
}

export async function writeEntitlement(db, githubId, isPro) {
  await db
    .prepare(
      `INSERT INTO entitlements (user_github_id, is_pro, checked_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_github_id) DO UPDATE SET is_pro = excluded.is_pro, checked_at = excluded.checked_at`
    )
    .bind(String(githubId), isPro ? 1 : 0, new Date().toISOString())
    .run();
}

// Per-user connector settings, keyed by the NUMERIC github id like memberships
// and sessions. Connectors that need no configuration never touch this.
export async function getConnectorConfig(db, githubId, connector) {
  const row = await db
    .prepare("SELECT config FROM connector_config WHERE user_github_id = ?1 AND connector = ?2")
    .bind(String(githubId), connector)
    .first();
  if (!row) return null;
  try {
    return JSON.parse(row.config);
  } catch {
    return null;
  }
}

export async function setConnectorConfig(db, githubId, connector, config) {
  await db
    .prepare(
      `INSERT INTO connector_config (user_github_id, connector, config, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_github_id, connector) DO UPDATE SET
         config = excluded.config, updated_at = excluded.updated_at`
    )
    .bind(String(githubId), connector, JSON.stringify(config), new Date().toISOString())
    .run();
}

export async function registerDevice(db, { deviceToken, githubId, login, environment }) {
  await db
    .prepare(
      `INSERT INTO device_tokens (device_token, user_github_id, login, environment, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(device_token) DO UPDATE SET
         user_github_id = excluded.user_github_id,
         login = excluded.login,
         environment = excluded.environment,
         updated_at = excluded.updated_at`
    )
    .bind(deviceToken, String(githubId), login, environment || "production", new Date().toISOString())
    .run();
}

// By login, because that is the name a card carries its recipient under.
export async function devicesForLogin(db, login) {
  if (!login) return [];
  const { results } = await db
    .prepare("SELECT device_token, environment FROM device_tokens WHERE login = ?1")
    .bind(login)
    .all();
  return results || [];
}

export async function removeDevice(db, deviceToken) {
  await db.prepare("DELETE FROM device_tokens WHERE device_token = ?1").bind(deviceToken).run();
}

// The relay knows a person by their github LOGIN; config is keyed by the numeric
// id. This is the bridge — comparing the two directly would never match.
export async function getUserByLogin(db, login) {
  if (!login) return null;
  return (
    (await db
      .prepare(
        "SELECT github_id, login, name, locale, email, notify_email FROM users WHERE login = ?1"
      )
      .bind(login)
      .first()) || null
  );
}

// Web Push subscriptions, one row per browser (or installed PWA) per person.
// The same shape of contract as device_tokens: keyed by what the push service
// makes unique, re-bound to whoever is signed in on that browser now.
export async function registerSubscription(db, { endpoint, githubId, login, p256dh, auth, userAgent }) {
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, user_github_id, login, p256dh, auth, user_agent, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_github_id = excluded.user_github_id,
         login = excluded.login,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`
    )
    .bind(endpoint, String(githubId), login, p256dh, auth, userAgent || null, new Date().toISOString())
    .run();
}

export async function subscriptionsForLogin(db, login) {
  if (!login) return [];
  const { results } = await db
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE login = ?1")
    .bind(login)
    .all();
  return results || [];
}

export async function removeSubscription(db, endpoint) {
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(endpoint).run();
}


// Directory for recipient pickers, using the same ids as card delivery.
export async function listWorkspaceMembers(db, orgId) {
  const rows = await db.prepare(
    `SELECT u.login AS id, COALESCE(NULLIF(u.name, ''), u.login) AS name,
            m.role AS role, u.avatar_url AS avatarUrl
       FROM memberships m JOIN users u ON u.github_id = m.user_github_id
      WHERE m.org_id = ?1
      ORDER BY name COLLATE NOCASE, u.login`
  ).bind(orgId).all();
  // Relay logins are the identifiers cards use. Do not expose account ids,
  // notification email addresses, credentials, or unrelated memberships.
  return (rows?.results || []).map((row) => ({
    id: row.id,
    name: row.name,
    role: (row.role || "member").toLowerCase(),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
  }));
}

// Routing uses the org-graph shape, including explicit roles for name/role
// matching. Keep it separate from the minimal member-directory response.
export async function listOrgNodes(db, orgId) {
  const rows = await db
    .prepare(
      `SELECT COALESCE(u.login, m.user_github_id) AS id,
              m.role AS role,
              COALESCE(u.name, u.login, m.user_github_id) AS name
         FROM memberships m
         LEFT JOIN users u ON u.github_id = m.user_github_id
        WHERE m.org_id = ?1`
    )
    .bind(orgId)
    .all();
  // role is carried on the node, not parsed back out of the label: a display
  // string is a formatting decision and breaks on any name containing " · ".
  return (rows?.results || []).map((r) => ({
    id: r.id,
    kind: "person",
    role: (r.role || "member").toLowerCase(),
    label: `${r.name} · ${r.role || "member"}`,
  }));
}

// Businesses. A slug is the name, lowercased, with runs of whitespace and
// punctuation folded to "-", letters of any script kept — "Hotel 本丸" and
// "hotel 本丸" are the same business. Sixty-four characters is plenty for a
// name and short enough to ride on every card.
export const MAX_BUSINESS_SLUG = 64;

export function businessSlug(name) {
  if (typeof name !== "string") return null;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BUSINESS_SLUG);
  return slug || null;
}

export async function listBusinesses(db, orgId) {
  const { results } = await db
    .prepare("SELECT slug, name, created_by, created_at FROM businesses WHERE org_id = ?1 ORDER BY created_at")
    .bind(orgId)
    .all();
  return (results || []).map((r) => ({ slug: r.slug, name: r.name, createdBy: r.created_by, createdAt: r.created_at }));
}

/// Create a business, or return the one a name already means. The name that
/// was typed first is the one that sticks: a later "HOTEL" does not rename
/// "Hotel".
export async function upsertBusiness(db, orgId, { name, createdBy }) {
  const slug = businessSlug(name);
  if (!slug) return null;
  await db
    .prepare(
      `INSERT INTO businesses (org_id, slug, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(org_id, slug) DO NOTHING`
    )
    .bind(orgId, slug, String(name).trim().slice(0, 120), createdBy || null, new Date().toISOString())
    .run();
  const row = await db
    .prepare("SELECT slug, name FROM businesses WHERE org_id = ?1 AND slug = ?2")
    .bind(orgId, slug)
    .first();
  return row ? { slug: row.slug, name: row.name } : null;
}

export async function removeBusiness(db, orgId, slug) {
  await db.prepare("DELETE FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug).run();
}
