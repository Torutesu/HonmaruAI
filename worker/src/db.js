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

/// One language's words onto a card, and nothing else. A translation takes
/// up to thirty seconds, and the recipient may decide in that time: writing
/// the whole card back afterwards would put the copy read before the
/// decision over the decision. This touches only `localized.<locale>`, in
/// the database, so whatever else changed meanwhile stays changed.
export async function saveCardLocalization(db, orgId, cardId, locale, text) {
  const label = String(locale).replace(/["\\]/g, "");
  await db
    .prepare(
      `UPDATE cards SET data = json_set(data, '$.localized."${label}"', json(?3)), updated_at = ?4
       WHERE org_id = ?1 AND card_id = ?2`
    )
    .bind(orgId, cardId, JSON.stringify(text), new Date().toISOString())
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
         login = excluded.login,
         name = CASE WHEN users.name_locked = 1 THEN users.name ELSE excluded.name END,
         -- A photo the person uploaded here outlives whatever their GitHub
         -- account says, and an upsert that knows of no photo keeps one.
         avatar_url = CASE
           WHEN users.avatar_url LIKE '%/users/avatar/user-avatar-%' THEN users.avatar_url
           ELSE COALESCE(excluded.avatar_url, users.avatar_url)
         END,
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
        "SELECT github_id, login, name, avatar_url, locale, email, notify_email, push_while_active, aliases, handle FROM users WHERE github_id = ?1"
      )
      .bind(String(githubId))
      .first()) || null
  );
}

export const MAX_ALIASES = 5;
export const MAX_ALIAS_CHARS = 40;

/// Other names this person answers to. Text, a few of them, short; the
/// router reads them, so a name that is a common word would misroute — that
/// is the person's call, and the flag under the card is how they find out.
export function normalizeAliases(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const alias = raw.trim().slice(0, MAX_ALIAS_CHARS);
    if (!alias || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

export const MAX_NAME_CHARS = 60;
/// Usernames nobody may take: words that already mean something after an @.
const RESERVED_HANDLES = new Set(["ai", "everyone", "here", "channel", "all", "admin", "team", "you", "me", "honmaru", "shogun", "shogunai"]);

/// A display name, cleaned: one line, bounded; null when there is nothing.
export function cleanName(value) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
  return clean && clean.length <= MAX_NAME_CHARS ? clean : null;
}

/// A username: what follows the @. Lowercase letters, digits, "." "_" "-",
/// 2 to 30 of them, starting with a letter or digit. Returns the handle, or
/// `{ error }` saying what is wrong with it.
export function checkHandle(value) {
  const h = String(value || "").trim().replace(/^@/, "").toLowerCase();
  if (!h) return { handle: null };
  if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(h)) return { error: "A username is 2–30 letters, numbers, “.”, “_” or “-”, starting with a letter or number." };
  if (RESERVED_HANDLES.has(h)) return { error: "That username is reserved." };
  return { handle: h };
}

export async function setUserName(db, githubId, name) {
  await db.prepare("UPDATE users SET name = ?2, name_locked = 1 WHERE github_id = ?1").bind(String(githubId), name).run();
}

/// Take a username, or say it is someone else's. The unique index is the
/// judge, so two people choosing the same one at once cannot both have it.
export async function setUserHandle(db, githubId, handle) {
  if (handle) {
    const other = await db.prepare("SELECT 1 FROM users WHERE handle = ?1 AND github_id != ?2").bind(handle, String(githubId)).first();
    if (other) return { error: "That username is taken." };
  }
  try {
    await db.prepare("UPDATE users SET handle = ?2 WHERE github_id = ?1").bind(String(githubId), handle).run();
    return { ok: true };
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err?.message))) return { error: "That username is taken." };
    throw err;
  }
}

export async function setUserAliases(db, githubId, aliases) {
  await db
    .prepare("UPDATE users SET aliases = ?2 WHERE github_id = ?1")
    .bind(String(githubId), aliases.length ? JSON.stringify(aliases) : null)
    .run();
}

export function parseAliases(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((a) => typeof a === "string") : [];
  } catch {
    return [];
  }
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

/// What a person may say they do.
///
/// These are descriptions, not standing. The router matches on them — "ask the
/// designer to review" finds the person whose title is `designer` — and saying
/// you are one grants you nothing, which is why anyone may set their own.
///
/// `admin`, `triager` and `maintainer` are absent because those are standing:
/// granted by an invite or by GitHub, never claimed.
export const SELF_ASSIGNABLE_ROLES = ["member", "designer", "engineer", "operator", "founder"];
export const MAX_TITLE_CHARS = 40;
const STANDING_WORDS = new Set(["admin", "administrator", "owner", "maintainer", "triager", "moderator"]);

/// Say what you do. Any member, in their own words — "CFO", "店長", "head of
/// suppliers" — or one of the presets above. No standing changes: an admin
/// who says they are a designer is still an admin. The title is what the
/// router reads when it decides who a thing is for, so it is the one line
/// every member gets to write about themselves.
export async function setOwnTitle(db, orgId, githubId, title) {
  const wanted = String(title || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!wanted) return { error: "Say what you do, in a word or a few." };
  if (wanted.length > MAX_TITLE_CHARS) return { error: `A role is at most ${MAX_TITLE_CHARS} characters.` };
  // A title that reads as standing — "admin", "maintainer", "triager" — is
  // refused: it would look like a promotion on every screen that shows it,
  // and standing is granted by an invite, never by the person themselves.
  if (STANDING_WORDS.has(wanted.toLowerCase()) && !SELF_ASSIGNABLE_ROLES.includes(wanted.toLowerCase())) {
    return { error: "That is not a role you can pick." };
  }
  const stored = SELF_ASSIGNABLE_ROLES.includes(wanted.toLowerCase()) ? wanted.toLowerCase() : wanted;
  const { meta } = await db
    .prepare("UPDATE memberships SET title = ?3 WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(githubId), stored)
    .run();
  if (!meta?.changes) return { error: "You are not a member of this organization." };
  return { role: stored };
}

/// What this person does in this org, for the client and the router: the title
/// they chose, or their standing when they have not chosen one.
export async function ownTitle(db, orgId, githubId) {
  const row = await db
    .prepare("SELECT role, title FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(githubId))
    .first();
  if (!row) return null;
  const title = String(row.title || "").trim();
  if (title) return SELF_ASSIGNABLE_ROLES.includes(title.toLowerCase()) ? title.toLowerCase() : title;
  return String(row.role || "member").toLowerCase();
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
  if (!ids.length) return { removed: 0, logins: [] };
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
  // Who is about to go, before they go. The relay stamps a login on a socket
  // and knows nothing about `user_github_id`, so a caller that wants to close
  // the connections these rows were holding needs the names, and a count
  // cannot be turned back into them once the rows are gone.
  const { results: going } = await db
    .prepare(
      `SELECT COALESCE(u.login, m.user_github_id) AS login
         FROM memberships m
         LEFT JOIN users u ON u.github_id = m.user_github_id
        WHERE m.org_id = ?1 AND m.user_github_id NOT IN (${holes})
          AND m.user_github_id NOT GLOB '*[^0-9]*'`
    )
    .bind(orgId, ...ids)
    .all();
  const { meta } = await db
    .prepare(`DELETE FROM memberships WHERE org_id = ?1 AND user_github_id NOT IN (${holes}) ${githubOnly}`)
    .bind(orgId, ...ids)
    .run();
  // Agents belong to the person, so they go the same way.
  await db
    .prepare(`DELETE FROM agents WHERE org_id = ?1 AND user_github_id NOT IN (${holes}) ${githubOnly}`)
    .bind(orgId, ...ids)
    .run();
  return { removed: meta?.changes ?? 0, logins: (going || []).map((r) => r.login).filter(Boolean) };
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

/// The message a card was made from, if this person's sync made it. The
/// one link between a card and an outside thread that a client cannot write.
export async function ingestedItemForCard(db, cardId, githubId) {
  const row = await db
    .prepare("SELECT connector, external_id AS externalId FROM ingested_items WHERE card_id = ?1 AND user_github_id = ?2")
    .bind(cardId, String(githubId))
    .first();
  return row || null;
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

export async function deleteConnectorConfig(db, githubId, connector) {
  await db
    .prepare("DELETE FROM connector_config WHERE user_github_id = ?1 AND connector = ?2")
    .bind(String(githubId), connector)
    .run();
}

/// Record which connectors Composio says this person has, so the cron can
/// find them without asking Composio about everyone with a session.
///
/// The cron picks people up by the existence of a `connector_config` row,
/// and until this existed only the Notion writer ever wrote one — so a
/// person who connected Gmail was synced only when they pulled by hand, and
/// "your AI triaged three decisions overnight" was true for exactly the
/// people who had also configured Notion. A `connected` flag lives beside
/// whatever configuration the connector already keeps; a row that carried
/// nothing else is dropped when the account goes away.
export async function rememberConnections(db, githubId, connectorIds, activeIds) {
  for (const id of connectorIds) {
    const existing = await getConnectorConfig(db, githubId, id);
    if (activeIds.has(id)) {
      if (!existing?.connected) await setConnectorConfig(db, githubId, id, { ...(existing || {}), connected: true });
      continue;
    }
    if (!existing) continue;
    const { connected, ...rest } = existing;
    if (Object.keys(rest).length === 0) await deleteConnectorConfig(db, githubId, id);
    else if (connected) await setConnectorConfig(db, githubId, id, rest);
  }
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

/// Forget a device — the caller's own. A token is the push service's secret
/// for one phone, but the delete was keyed on it alone, so knowing one was
/// enough to silence it from any account.
export async function removeDevice(db, deviceToken, githubId) {
  if (githubId === undefined) {
    await db.prepare("DELETE FROM device_tokens WHERE device_token = ?1").bind(deviceToken).run();
    return;
  }
  await db
    .prepare("DELETE FROM device_tokens WHERE device_token = ?1 AND user_github_id = ?2")
    .bind(deviceToken, String(githubId))
    .run();
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

/// Forget a browser's subscription. With a `githubId`, only if it is theirs;
/// without one — the push service said the endpoint is gone — whoever's it was.
export async function removeSubscription(db, endpoint, githubId) {
  if (githubId === undefined) {
    await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(endpoint).run();
    return;
  }
  await db
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_github_id = ?2")
    .bind(endpoint, String(githubId))
    .run();
}


// List an org's members with their display names, for routing. Joins to users
// so the router can match instructions like "ask Newbie to ..." to a real
// person, and returns them in the org-graph "nodes" shape the router expects.
export async function listOrgNodes(db, orgId) {
  const rows = await db
    .prepare(
      `SELECT COALESCE(u.login, m.user_github_id) AS id,
              COALESCE(m.title, m.role) AS role,
              COALESCE(u.name, u.login, m.user_github_id) AS name,
              u.aliases AS aliases,
              u.handle AS handle
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
    // A username is one more name the router matches on.
    ...((parseAliases(r.aliases).length || r.handle) ? { aliases: [...parseAliases(r.aliases), ...(r.handle ? [r.handle] : [])] } : {}),
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

/// The channels a business runs, for one person to see: every public one,
/// and the private ones they are in. With no viewer — the router filing a
/// card, the AI suggesting, a broadcast to the whole room — public ones only:
/// a private channel is never somewhere a stranger's card lands or a name
/// the room is told.
export async function listBusinesses(db, orgId, { viewer = null } = {}) {
  const { results } = await db
    .prepare(
      `SELECT b.slug, b.name, b.created_by, b.created_at, b.private,
              CASE WHEN b.private = 1 THEN (SELECT COUNT(*) FROM conversation_members c2 WHERE c2.org_id = ?1 AND c2.channel = 'b:' || b.slug) END AS member_count
         FROM businesses b
        WHERE b.org_id = ?1 AND (b.private = 0 OR (?2 IS NOT NULL AND EXISTS (
          SELECT 1 FROM conversation_members c WHERE c.org_id = ?1 AND c.channel = 'b:' || b.slug AND c.login = ?2)))
        ORDER BY b.created_at`
    )
    .bind(orgId, viewer)
    .all();
  return (results || []).map((r) => ({ slug: r.slug, name: r.name, createdBy: r.created_by, createdAt: r.created_at, ...(r.private ? { private: true, memberCount: r.member_count || 0 } : {}) }));
}

/// Whether the workspace has any private channel: a room told about the
/// public ones should ask for its own list again.
export async function hasPrivateBusinesses(db, orgId) {
  return Boolean(await db.prepare("SELECT 1 FROM businesses WHERE org_id = ?1 AND private = 1 LIMIT 1").bind(orgId).first());
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

/// A channel's new name. The slug — what cards are filed under — stays.
export async function renameBusiness(db, orgId, slug, name) {
  const clean = String(name || "").trim().slice(0, 120);
  if (!clean) return null;
  const { meta } = await db
    .prepare("UPDATE businesses SET name = ?3 WHERE org_id = ?1 AND slug = ?2")
    .bind(orgId, slug, clean)
    .run();
  return meta?.changes ? { slug, name: clean } : null;
}

/// Take the cards out of a deleted channel. Deleting a channel in a chat
/// client empties it; a card that still named the slug would keep the
/// channel alive in every list. Returns the cards that changed.
export async function unfileBusiness(db, orgId, slug) {
  const { results } = await db
    .prepare("SELECT card_id, data FROM cards WHERE org_id = ?1")
    .bind(orgId)
    .all();
  const changed = [];
  for (const row of results || []) {
    let card;
    try { card = JSON.parse(row.data); } catch { continue; }
    if (card?.business !== slug) continue;
    delete card.business;
    await saveCard(db, orgId, card);
    changed.push(card);
  }
  return changed;
}

/// Who someone is inside one organization: the name to show and the role they
/// hold. The card carries this so every client can render "Requested by" from
/// the card alone, rather than each one loading the org graph to turn a login
/// into a person.
/// Whether this login belongs to somebody in this organization.
///
/// By login, because that is what a card names its recipient by — the
/// memberships table is keyed by account id, so neither `isMember` nor
/// `getMemberProfile` answers this question: the latter LEFT JOINs
/// memberships and so returns a row for any user at all.
export async function isOrgMemberLogin(db, orgId, login) {
  if (!orgId || !login) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS ok
         FROM memberships m
         JOIN users u ON u.github_id = m.user_github_id
        WHERE m.org_id = ?1 AND u.login = ?2`
    )
    .bind(orgId, String(login))
    .first();
  return Boolean(row);
}

export async function getMemberProfile(db, orgId, login) {
  if (!orgId || !login) return null;
  const row = await db
    .prepare(
      `SELECT COALESCE(u.name, u.login) AS name, m.role AS role
         FROM users u
         LEFT JOIN memberships m
           ON m.user_github_id = u.github_id AND m.org_id = ?1
        WHERE u.login = ?2`
    )
    .bind(orgId, login)
    .first();
  if (!row) return null;
  return { login, name: row.name || login, role: row.role || "member" };
}

/// Every organization this person belongs to, oldest membership first.
///
/// Nothing asked this before: `/me` described a person and never said where
/// they worked, so a client that had lost its stored `orgId` — a second
/// browser, a cleared cache — had no way to find out and fell back to a
/// placeholder nobody is a member of.
///
/// `founder` is the org's oldest member, which is whoever created it. A
/// workspace made at sign-up is named `personal:<hash>` and that is not a name
/// anyone can read, so the person who started it stands in for one.
export async function listUserOrgs(db, githubId) {
  const rows = await db
    .prepare(
      `SELECT m.org_id AS id,
              m.role   AS role,
              (SELECT o.name FROM orgs o WHERE o.id = m.org_id) AS name,
              (SELECT COALESCE(u.name, u.login, om.user_github_id)
                 FROM memberships om
                 LEFT JOIN users u ON u.github_id = om.user_github_id
                WHERE om.org_id = m.org_id
                ORDER BY om.created_at ASC, om.user_github_id ASC
                LIMIT 1)              AS founder,
              (SELECT om.user_github_id
                 FROM memberships om
                WHERE om.org_id = m.org_id
                ORDER BY om.created_at ASC, om.user_github_id ASC
                LIMIT 1)              AS founder_id,
              (SELECT COUNT(*) FROM memberships om WHERE om.org_id = m.org_id) AS member_count
         FROM memberships m
        WHERE m.user_github_id = ?1
        ORDER BY m.created_at ASC, m.org_id ASC`
    )
    .bind(String(githubId))
    .all();
  return (rows?.results || []).map((r) => ({
    id: r.id,
    role: r.role || "member",
    // What the team called itself, when it did. A repository's id is its
    // name; a personal workspace nobody renamed has none.
    name: r.name || null,
    // A repository-backed org is already readable as "owner/repo"; only a
    // personal workspace needs a person's name to stand in for its id.
    founder: String(r.id).includes("/") ? null : r.founder || null,
    mine: String(r.founder_id) === String(githubId),
    memberCount: Number(r.member_count) || 1,
  }));
}

/// Where to put someone who did not say.
///
/// Where a person's own connected tools land: the workspace they last pulled
/// them into. The row is also the cron's queue position, so a first pull
/// counts as a sync just done; after that only the workspace changes.
export async function rememberPullWorkspace(db, githubId, orgId) {
  await db
    .prepare(
      `INSERT INTO connector_sync_state (user_github_id, synced_at, org_id) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_github_id) DO UPDATE SET org_id = excluded.org_id`
    )
    .bind(String(githubId), new Date().toISOString(), orgId)
    .run()
    .catch((err) => console.error("pull workspace not kept", err?.message || err));
}

/// Which workspace a person's own tools are pulled into, when they chose one.
export async function pullWorkspaceOf(db, githubId) {
  const row = await db.prepare("SELECT org_id FROM connector_sync_state WHERE user_github_id = ?1")
    .bind(String(githubId)).first().catch(() => null);
  return row?.org_id || null;
}

/// A workspace with other people in it beats one with only you: the solo org
/// handed out at sign-up is a starting point, and anywhere with a second
/// person is where the work is. Ties go to the earliest join, so the answer
/// does not move under a returning user.
///
/// Not "is it a personal: org" — the id says who made it, not whether anyone
/// else is there. An inviter's own workspace is a `personal:` one too, so that
/// test sent everyone they invited back to their own empty feed.
export async function primaryOrgId(db, githubId) {
  const row = await db
    .prepare(
      `SELECT m.org_id AS id,
              (SELECT COUNT(*) FROM memberships om WHERE om.org_id = m.org_id) AS people
         FROM memberships m
        WHERE m.user_github_id = ?1
        ORDER BY (people > 1) DESC, m.created_at ASC, m.org_id ASC
        LIMIT 1`
    )
    .bind(String(githubId))
    .first();
  return row?.id || null;
}
