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

export async function saveCard(db, orgId, card) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO cards (org_id, card_id, recipient_user_id, sender_user_id, created_at, data,
                          status, priority, decided_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(org_id, card_id) DO UPDATE SET
         recipient_user_id = excluded.recipient_user_id,
         sender_user_id = excluded.sender_user_id,
         data = excluded.data,
         status = excluded.status,
         priority = excluded.priority,
         decided_at = excluded.decided_at,
         updated_at = excluded.updated_at`
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

export async function upsertUser(db, { githubId, login, name, avatarUrl, locale }) {
  await db
    .prepare(
      `INSERT INTO users (github_id, login, name, avatar_url, locale, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(github_id) DO UPDATE SET
         login = excluded.login, name = excluded.name,
         avatar_url = excluded.avatar_url, locale = excluded.locale`
    )
    .bind(String(githubId), login, name || null, avatarUrl || null, locale || "en", new Date().toISOString())
    .run();
}

export async function getUserByGithubId(db, githubId) {
  return (
    (await db
      .prepare("SELECT github_id, login, name, avatar_url, locale FROM users WHERE github_id = ?1")
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
  const { meta } = await db
    .prepare(`DELETE FROM memberships WHERE org_id = ?1 AND user_github_id NOT IN (${holes})`)
    .bind(orgId, ...ids)
    .run();
  // Agents belong to the person, so they go the same way.
  await db
    .prepare(`DELETE FROM agents WHERE org_id = ?1 AND user_github_id NOT IN (${holes})`)
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
  return (
    (await db
      .prepare("SELECT github_id, login FROM users WHERE login = ?1")
      .bind(login)
      .first()) || null
  );
}


// List an org's members with their display names, for routing. Joins to users
// so the router can match instructions like "ask Newbie to ..." to a real
// person, and returns them in the org-graph "nodes" shape the router expects.
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
