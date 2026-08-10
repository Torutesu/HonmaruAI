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

export async function removeCard(db, orgId, cardId) {
  await db
    .prepare("DELETE FROM cards WHERE org_id = ?1 AND card_id = ?2")
    .bind(orgId, cardId)
    .run();
}

export async function clearCards(db, orgId) {
  await db.prepare("DELETE FROM cards WHERE org_id = ?1").bind(orgId).run();
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

export async function getSession(db, token) {
  if (!token) return null;
  const row = await db
    .prepare(
      "SELECT token, github_id, github_access_token, expires_at FROM sessions WHERE token = ?1"
    )
    .bind(token)
    .first();
  if (!row) return null;
  // A NULL expiry is a session minted before expiry existed — still valid, so
  // shipping this does not sign out the people currently testing.
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;
  return row;
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
