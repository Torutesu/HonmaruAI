CREATE TABLE IF NOT EXISTS users (
  github_id     TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  locale        TEXT DEFAULT 'en',
    created_at    TEXT NOT NULL,
  /* Email/password auth. NULL for GitHub users; set for email sign-ups.
     github_id is just the primary user id; email users get an "email:" id. */
  email         TEXT,
  password_hash TEXT,
  password_salt TEXT,
  /* When the address was proved: an emailed code came back, or an SSO
     provider vouched for it. Only a proved address joins by its domain. */
  email_verified_at TEXT,
  /* What else this person is called — a Japanese given name, a nickname —
     as a JSON array. The router matches an instruction against these as
     well as the name, so 「美香に」 reaches mika. */
  aliases       TEXT,
  /* Whether a decision may reach this person by email when no push channel
     (APNs device, web push subscription) can. 1 = yes. */
  notify_email  INTEGER NOT NULL DEFAULT 1,
  /* 1: push the phone even while at the app on another device. */
  push_while_active INTEGER NOT NULL DEFAULT 0,
  /* Notifications paused until then ("Pause notifications"). */
  notify_paused_until TEXT,
  /* The hours notifications may come, as JSON (quiet.js): days, from, to,
     in the person's own timezone. */
  notify_schedule TEXT,
  /* Words that notify this person wherever they are said, as a JSON array
     ("Keywords" in notification settings). */
  notify_keywords TEXT,
  /* The secret half of the inbound email address, u-<token>@domain. A GitHub
     id is public and sequential, so u-<github id>@domain is an address anyone
     can guess — and a guessed address is a way to spend someone's AI allowance
     and put a forged card in their feed. NULL until the address is asked for;
     generated lazily so accounts that never use inbound mail carry no secret. */
  inbound_token TEXT,
  /* A username, as a person chose it: what @ finds them by, in any workspace.
     Lowercase, unique; NULL until they pick one. */
  handle        TEXT,
  /* 1 once the person has named themselves: a GitHub sign-in no longer
     writes its profile name over theirs. */
  name_locked   INTEGER NOT NULL DEFAULT 0,
  /* The IANA zone this person's browser reports, for "their local time". */
  timezone      TEXT
);


/* login exists on every version of this table, so its index is safe here.
   The email index is not: on a database predating those columns this file is
   a no-op for them, and indexing a column that does not exist yet fails the
   whole step. It lives in migrations.sql, after the ALTER that adds it. */
/* IF NOT EXISTS skips a same-named index; it does not tolerate duplicate rows.
   schema.sql is replayed on every deploy with no error tolerance, so a single
   pre-existing duplicate would fail this statement and every deploy after it,
   until someone repaired the data by hand. Move any loser out of the way first:
   the cost of the collision is total and permanent, the insurance is one line. */
UPDATE users SET login = login || '+stale-' || github_id
 WHERE rowid NOT IN (SELECT MAX(rowid) FROM users GROUP BY login);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login);

CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

/* `role` is standing — who may invite whom, who may act for the org. It is
   granted by an invite or by GitHub, never claimed.

   `title` is description — what this person does, which is what the router
   matches on when someone says "ask the designer to review". Anyone may set
   their own, because saying you are a designer grants you nothing.

   They were one column once, and that made the onboarding question unusable
   for the commonest case: signing up alone makes you admin of your own org,
   so every attempt to say "I am the founder" was refused as an attempt to
   demote an admin. */
CREATE TABLE IF NOT EXISTS memberships (
  org_id            TEXT NOT NULL,
  user_github_id    TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member',
  title             TEXT,
  /* How they came: invite | domain | sso | created. NULL is before this was kept. */
  joined_via        TEXT,
  created_at        TEXT NOT NULL,
  /* A status, as a chat client has one: an emoji, a few words, until when.
     Away until a time, with somebody to decide in your place meanwhile. */
  status_emoji      TEXT,
  status_text       TEXT,
  status_until      TEXT,
  away_until        TEXT,
  delegate_login    TEXT,
  PRIMARY KEY (org_id, user_github_id)
);

/* Team invite codes. A member creates a code for their org; anyone who
   redeems it joins that org. Kept simple: a code is reusable until deleted.
   Block comment (not --) so the test loader that flattens newlines is happy. */
CREATE TABLE IF NOT EXISTS invites (
  code           TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member',
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  /* A code is a bearer credential: whoever holds it joins. The TTL bounds how
     long a leaked one lasts, the cap bounds how many strangers it admits. */
  max_uses       INTEGER NOT NULL DEFAULT 1,
  uses           INTEGER NOT NULL DEFAULT 0,
  /* A non-secret name for this code, so a member of the team can be shown that
     it exists — and cancel it — without being shown the credential itself. It
     is sha256(code) cut short, so it is derivable; it is stored so that
     cancelling one is an indexed lookup rather than a scan of every invite in
     the workspace, hashing each. */
  ref            TEXT,
  /* The channels the person is introduced in when they join: a JSON list of
     business slugs, or NULL for none. */
  channels       TEXT
);
/* The index for `ref` is in migrations.sql, not here. This file runs first and
   `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
   table without the column — so an index on it here would be built against a
   column that does not exist yet, and D1 aborts a file at its first error,
   taking everything below this line with it. */

CREATE INDEX IF NOT EXISTS idx_invites_org ON invites (org_id);

/* The businesses an organization runs. Ten people, ten businesses: a card
   belongs to one of them, and the feed can be read one business at a time.
   Rows appear as they are used — tagging a card with a name nobody has typed
   before creates the business — so the taxonomy is discovered, not designed. */
CREATE TABLE IF NOT EXISTS businesses (
  org_id      TEXT NOT NULL,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  /* What the channel is for, in a sentence anyone may write. */
  description TEXT,
  /* 1: only its members (conversation_members) can see it at all. */
  private     INTEGER NOT NULL DEFAULT 0,
  /* Set when the channel is archived: out of every list, its history kept. */
  archived_at TEXT,
  PRIMARY KEY (org_id, slug)
);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  user_github_id    TEXT NOT NULL,
  display_name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  org_id            TEXT NOT NULL,
  card_id           TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  sender_user_id    TEXT,
  created_at        TEXT NOT NULL,
  data              TEXT NOT NULL,
  status            TEXT,
  priority          TEXT,
  decided_at        TEXT,
  updated_at        TEXT,
  PRIMARY KEY (org_id, card_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_recipient ON cards (org_id, recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (org_id, status);

CREATE TABLE IF NOT EXISTS contexts (
  org_id  TEXT NOT NULL,
  user_id TEXT NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token               TEXT PRIMARY KEY,
  github_id           TEXT NOT NULL,
  github_access_token TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT,
  /* What a person sees in "Where you're signed in" (sessions.js): the app
     or browser it is, where it was last used from, and when. Never the IP. */
  client              TEXT,
  user_agent          TEXT,
  place               TEXT,
  last_seen_at        TEXT,
  /* When this person last proved it was them again, for an admin action a
     workspace's login rules ask a recent sign-in for (policy.js). */
  reauth_at           TEXT,
  /* How it was signed in: email_code | password | github | sso. */
  auth_method         TEXT,
  /* The longest it has sat unused, for a workspace that ends idle sessions. */
  longest_idle_ms     INTEGER,
  /* For an SSO sign-in: which workspace's identity provider it came through. */
  sso_org_id          TEXT
);

/* One row per authorization attempt, deleted the moment it is redeemed. The
   redirect is a custom URL scheme, which iOS hands to any app that claims it,
   so an unguarded callback lets another app feed us a code and bind the session
   to its own account. The nonce is what makes the code ours.

   Block comments, not `--`: the tests load this file with newlines flattened to
   spaces, and a line comment would swallow the rest of the schema. */
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

/* Fixed-window counters. Keyed by session token where there is one and by IP
   where there is not, so a signed-in user's budget follows them across networks
   and an anonymous one cannot be reset by reconnecting. */
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

CREATE TABLE IF NOT EXISTS card_events (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  card_id        TEXT NOT NULL,
  type           TEXT NOT NULL,
  action         TEXT,
  actor_user_id  TEXT,
  note           TEXT,
  snapshot       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_card ON card_events (org_id, card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_org ON card_events (org_id, created_at);

/* What people said about a card after they saw it. One row per person per
   card, the latest standing; the metrics view and the eval export read it.
   This is the feedback loop the router improves through. */
CREATE TABLE IF NOT EXISTS card_feedback (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  card_id        TEXT NOT NULL,
  user_github_id TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  reason         TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (org_id, card_id, user_github_id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_org ON card_feedback (org_id, created_at);

CREATE TABLE IF NOT EXISTS ingested_items (
  connector      TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  user_github_id TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  card_id        TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (connector, external_id, user_github_id)
);

/* One row per device per user. Keyed by the token because that is what Apple
   makes unique, and because the same person on two phones must get both. The
   login is denormalized alongside the numeric id: the relay knows a recipient
   by their login and would otherwise need a join on the hot path of every
   card. */
CREATE TABLE IF NOT EXISTS device_tokens (
  device_token   TEXT PRIMARY KEY,
  user_github_id TEXT NOT NULL,
  login          TEXT NOT NULL,
  environment    TEXT NOT NULL DEFAULT 'production',
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_login ON device_tokens (login);

/* Web Push subscriptions: a browser, a PWA on a phone, or a desktop app that
   wraps one. Keyed by the endpoint because that is what the push service makes
   unique. The login is denormalized for the same reason device_tokens does it:
   the relay knows a recipient by their login, on the hot path of every card. */
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint       TEXT PRIMARY KEY,
  user_github_id TEXT NOT NULL,
  login          TEXT NOT NULL,
  p256dh         TEXT NOT NULL,
  auth           TEXT NOT NULL,
  user_agent     TEXT,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_login ON push_subscriptions (login);

/* Every model call, with its tokens and its dollars at list price: what the
   AI costs a team, by purpose and by provider, on our key or on theirs.
   `ai_usage` above counts calls for the allowance; this is the bill. */
CREATE TABLE IF NOT EXISTS ai_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL,
  user_github_id TEXT,
  purpose        TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  usd            REAL NOT NULL DEFAULT 0,
  byok           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_org ON ai_calls (org_id, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_github_id TEXT NOT NULL,
  day            TEXT NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_github_id, day)
);

/* When each user last ran through the connector cron. The run is capped, so
   ordering candidates by this — never-synced first — is what keeps the cap a
   window that moves rather than a wall the 51st user never gets past. */
CREATE TABLE IF NOT EXISTS connector_sync_state (
  user_github_id TEXT PRIMARY KEY,
  synced_at      TEXT NOT NULL,
  /* The workspace this person pulls their own tools into: the one they last
     pressed "Pull now" in. Each person's Gmail, Slack and Notion are theirs,
     and so is where they land. */
  org_id         TEXT
);

CREATE TABLE IF NOT EXISTS entitlements (
  user_github_id TEXT PRIMARY KEY,
  is_pro         INTEGER NOT NULL,
  checked_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_config (
  user_github_id TEXT NOT NULL,
  connector      TEXT NOT NULL,
  config         TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_github_id, connector)
);

/* Mailgun signs `timestamp + token`, never the body, so a signature that was
   valid once stays valid for anything you care to attach to it. Spending the
   token is what stops that. Rows are swept with the rate-limit windows. */
CREATE TABLE IF NOT EXISTS webhook_nonces (
  token      TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

/* Email sign-in codes. A six-digit code is the whole credential, so the row
   holds a hash of it (PBKDF2, same as a password) rather than the code, has a
   short life, and counts its own wrong guesses. One row per address: asking
   for a new code replaces the old one, so a code that was emailed twice is
   only valid in its latest form. */
CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  code_salt   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);


/* Permanent account grants, independent of the RevenueCat purchase cache.
   Deleting an account also deletes its grant. No redemption code is stored. */
CREATE TABLE IF NOT EXISTS complimentary_access (
  user_github_id TEXT PRIMARY KEY,
  granted_at TEXT NOT NULL,
  rc_synced_at TEXT,
  rc_attempted_at TEXT,
  rc_operation_until INTEGER NOT NULL DEFAULT 0,
  deletion_requested_at TEXT
);

/* A thread under a card: what people said about it, in order. A comment can
   name teammates (mentions are logins, resolved when it is written); the
   card's own row keeps the count so every list shows it without a join. */
CREATE TABLE IF NOT EXISTS card_comments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  card_id       TEXT NOT NULL,
  author_login  TEXT NOT NULL,
  body          TEXT NOT NULL,
  mentions      TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_card ON card_comments (org_id, card_id, created_at);

/* One emoji, one person, one card: a reaction is a toggle, not a message. */
CREATE TABLE IF NOT EXISTS card_reactions (
  org_id      TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  user_login  TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, card_id, user_login, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_card ON card_reactions (org_id, card_id);

/* What a workspace runs its AI on, chosen from the Tools screen: a model, a
   key of its own (their bill), System One switched on. Absent, the Worker's
   secrets apply. Keys sit here the way connector tokens do. */
CREATE TABLE IF NOT EXISTS org_ai_settings (
  org_id        TEXT PRIMARY KEY,
  model         TEXT,
  openai_key    TEXT,
  typesafe_key  TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL
);

/* The repository a workspace writes its decisions to, and a token that can.
   Connected once from Tools; every decision becomes an issue there. */
CREATE TABLE IF NOT EXISTS org_github (
  org_id        TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  token         TEXT,
  /* Or, instead of a token: the account id of a member whose GitHub is
     connected through Composio; the Worker writes issues as them. */
  composio_user TEXT,
  connected_by  TEXT,
  updated_at    TEXT NOT NULL
);

/* Small things the deployment learns and keeps: an auth config it made at
   Composio, and the like. */
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

/* Work the AI does on a schedule and delivers as a card: a report, a
   brief. One row per routine; `next_run_at` is when the cron picks it up. */
CREATE TABLE IF NOT EXISTS routines (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  owner_github_id TEXT NOT NULL,
  owner_login    TEXT NOT NULL,
  /* Whose feed the result lands in: the owner, or another member. */
  recipient_login TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'report',
  title          TEXT NOT NULL,
  instruction    TEXT NOT NULL,
  cadence        TEXT NOT NULL,
  weekday        INTEGER,
  monthday       INTEGER,
  hour           INTEGER NOT NULL,
  minute         INTEGER NOT NULL DEFAULT 0,
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,
  last_run_at    TEXT,
  last_card_id   TEXT,
  last_error     TEXT,
  last_usd       REAL,
  runs           INTEGER NOT NULL DEFAULT 0,
  origin         TEXT NOT NULL DEFAULT 'manual',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  /* A daily report's channel (`b:<slug>`): where the owner posts it once
     they have read the draft. Null for every other kind. */
  channel        TEXT
);
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_routines_org ON routines(org_id);

/* The team's playbook: rules the AI learned from decisions, or was told.
   Read by the router, "Ask anything", drafts and routines. */
CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  text           TEXT NOT NULL,
  origin         TEXT NOT NULL DEFAULT 'told',
  card_id        TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_org ON memories(org_id, updated_at);

/* What the AI has proposed on its own, so a declined proposal is never
   made twice and nobody is proposed to more than once a week. */
CREATE TABLE IF NOT EXISTS proposals (
  org_id         TEXT NOT NULL,
  signature      TEXT NOT NULL,
  login          TEXT NOT NULL,
  card_id        TEXT,
  /* The routine as proposed, kept here rather than trusted off the card:
     a card can be republished by a client, this row cannot. */
  routine        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (org_id, signature)
);
CREATE INDEX IF NOT EXISTS idx_proposals_login ON proposals(org_id, login, created_at);

/* Personal access tokens for agents speaking MCP. Only the hash is kept;
   the token is shown once, when it is made. */
CREATE TABLE IF NOT EXISTS api_tokens (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  org_id         TEXT NOT NULL,
  github_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  prefix         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT,
  /* What the token may do, as a JSON array: read, write, audit:read.
     NULL is a token made before scopes, and means read and write. */
  scopes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens(github_id, org_id);

/* A workspace's own mark: the logo on the rail and in the switcher. The
   bytes live in R2 under media_id; this is the one row that names them. */
CREATE TABLE IF NOT EXISTS org_icons (
  org_id        TEXT PRIMARY KEY,
  media_id      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

/* What people say in a channel: a business's (`b:<slug>`, the whole
   workspace) or a direct one (`dm:<login>|<login>`, sorted; the two of
   them). The AI reads it as context, and a message can become a decision:
   `card_id` is the card made from it. */
CREATE TABLE IF NOT EXISTS channel_messages (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  author_login  TEXT,
  kind          TEXT NOT NULL DEFAULT 'message',
  body          TEXT NOT NULL,
  card_id       TEXT,
  created_at    TEXT NOT NULL,
  /* Slack's verbs on a message: edited in place, deleted (a tombstone
     while it has replies), a reply in a thread under another, pinned. */
  edited_at     TEXT,
  deleted_at    TEXT,
  parent_id     TEXT,
  pinned_at     TEXT,
  pinned_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_messages ON channel_messages(org_id, channel, created_at);

/* One emoji from one person on one message. A browser is told who reacted
   by member ref, never by login. */
CREATE TABLE IF NOT EXISTS message_reactions (
  org_id      TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  login       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (message_id, emoji, login)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions ON message_reactions(org_id, message_id);

/* How far each person has read each conversation — kept here, not in one
   browser, so a phone and a laptop agree on what is new. `channel` is the
   stored key (b:<slug>, dm:<a>|<b>) or "activity" for the Activity inbox. */
CREATE TABLE IF NOT EXISTS channel_reads (
  org_id        TEXT NOT NULL,
  login         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  last_read_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, login, channel)
);

/* How loudly a conversation may call for you: all, mentions, or mute. */
CREATE TABLE IF NOT EXISTS channel_prefs (
  org_id   TEXT NOT NULL,
  login    TEXT NOT NULL,
  channel  TEXT NOT NULL,
  level    TEXT NOT NULL,
  PRIMARY KEY (org_id, login, channel)
);

/* Messages written now and sent later. The every-minute cron posts them as
   their author, in the conversation they were written in. */
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  author_login  TEXT NOT NULL,
  body          TEXT NOT NULL,
  parent_id     TEXT,
  send_at       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(sent_at, send_at);

/* Later: a message saved to come back to, optionally at a time — then it
   arrives in the feed as a card. */
CREATE TABLE IF NOT EXISTS saved_items (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  login         TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  channel       TEXT NOT NULL,
  remind_at     TEXT,
  reminded_at   TEXT,
  done_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_items ON saved_items(org_id, login);

/* "Approve these automatically": a person's standing yes to one kind of
   request from one sender, optionally in one business. The relay applies it
   as the card arrives, and says so on the card. */
CREATE TABLE IF NOT EXISTS auto_rules (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  recipient_login TEXT NOT NULL,
  sender_login    TEXT NOT NULL,
  card_type       TEXT NOT NULL,
  business        TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_rules ON auto_rules(org_id, recipient_login);


/* The Worker's own words in a language nobody wrote them in by hand: one row
   per language and catalog, written by the model the first time a reader of
   that language needed them. `version` tags the English it was made from, so
   a reworded catalog is translated again rather than read stale. */
CREATE TABLE IF NOT EXISTS copy_translations (
  locale     TEXT NOT NULL,
  catalog    TEXT NOT NULL,
  version    TEXT NOT NULL,
  strings    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (locale, catalog)
);

/* A channel's journal: one day's conversation, summarized for a reader —
   in their time zone and language — with each line pointing at the
   messages it came from. Kept until the day gains a message, so reading
   the journal again costs nothing. */
CREATE TABLE IF NOT EXISTS channel_journal (
  org_id     TEXT NOT NULL,
  channel    TEXT NOT NULL,
  day        TEXT NOT NULL,
  tz         TEXT NOT NULL,
  locale     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  items      TEXT NOT NULL,
  by_model   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, channel, day, tz, locale)
);

/* What to tell your AI, suggested from a person's own work, per language.
   Kept a few hours so opening the conversation is not a model call. */
CREATE TABLE IF NOT EXISTS ai_suggestions (
  org_id     TEXT NOT NULL,
  login      TEXT NOT NULL,
  locale     TEXT NOT NULL,
  items      TEXT NOT NULL,
  by_model   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, login, locale)
);

/* A workspace's webhooks: its events posted to a service of the team's own,
   signed with a secret shown once. A webhook hears what the member who made
   it could see — direct conversations only when it asked for them. */
CREATE TABLE IF NOT EXISTS org_webhooks (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  name              TEXT,
  url               TEXT NOT NULL,
  events            TEXT NOT NULL,
  include_dms       INTEGER NOT NULL DEFAULT 0,
  secret            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_status       INTEGER,
  last_delivery_at  TEXT,
  last_error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_webhooks_org ON org_webhooks(org_id);

/* A link that brings an agent into a workspace: single use, fifteen minutes,
   stored as a hash. Opening it mints the agent an MCP token that acts for
   the member who made the link, and introduces it in the channels picked. */
CREATE TABLE IF NOT EXISTS agent_invites (
  code_hash      TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  channels       TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);

/* A file or a picture in a conversation. Uploaded before the message that
   carries it (message_id NULL until then; swept after a day if never sent),
   the bytes in R2 under `file-<id>`. `channel` is the stored key it was
   uploaded into: only a message there may claim it. */
CREATE TABLE IF NOT EXISTS message_files (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  channel     TEXT NOT NULL,
  message_id  TEXT,
  uploader    TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_files ON message_files(org_id, message_id);
CREATE INDEX IF NOT EXISTS idx_message_files_unsent ON message_files(message_id, created_at);

/* Who is in a conversation with a closed door: a private channel
   (`b:<slug>`) or a group DM (`g:<id>`). A two-person DM needs no rows —
   its key names the two. */
CREATE TABLE IF NOT EXISTS conversation_members (
  org_id      TEXT NOT NULL,
  channel     TEXT NOT NULL,
  login       TEXT NOT NULL,
  added_by    TEXT,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, channel, login)
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_login ON conversation_members(org_id, login);

/* When somebody was last at the app, on any client: the relay writes it at
   most every thirty seconds while they use it. A phone is not pushed about
   what its owner was there to see. */
CREATE TABLE IF NOT EXISTS user_activity (
  login           TEXT PRIMARY KEY,
  last_active_at  TEXT NOT NULL,
  client          TEXT
);

/* A message that needs somebody, waiting a minute to see whether they read
   it first. The every-minute cron claims (sent_at) and sends what is due. */
CREATE TABLE IF NOT EXISTS push_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL,
  login       TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  due_at      TEXT NOT NULL,
  sent_at     TEXT,
  UNIQUE (login, message_id)
);
CREATE INDEX IF NOT EXISTS idx_push_queue_due ON push_queue(sent_at, due_at);

/* A workspace's own emoji: `:name:` drawn from a picture one of its members
   added. Only this workspace has them. The bytes live in R2 under media_id
   (an unguessable id, like the workspace's logo); created_by is the login
   of whoever added it, who with an admin may remove it. */
CREATE TABLE IF NOT EXISTS org_emoji (
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  media_id      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, name)
);

/* User groups: `@sales` names everyone in it at once. The workspace's; any
   member may make one or change who is in it, and whoever made it, or an
   admin, may delete it. `handle` is stored folded, without the "@". */
CREATE TABLE IF NOT EXISTS user_groups (
  org_id        TEXT NOT NULL,
  handle        TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, handle)
);
CREATE TABLE IF NOT EXISTS user_group_members (
  org_id        TEXT NOT NULL,
  handle        TEXT NOT NULL,
  login         TEXT NOT NULL,
  PRIMARY KEY (org_id, handle, login)
);

/* Agents a team writes for itself: "@hayao" answers in a channel the way
   its instructions (Markdown) say. A team agent is the workspace's: anyone
   in it may call it and change it. A personal one answers only its owner.
   Deleted agents keep their row (deleted_at) so what they wrote keeps its
   name. Messages they write have author_login 'agent:<id>'. */
CREATE TABLE IF NOT EXISTS custom_agents (
  org_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  handle        TEXT NOT NULL,
  name          TEXT NOT NULL,
  emoji         TEXT,
  description   TEXT,
  instructions  TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'team',
  owner_login   TEXT NOT NULL,
  preset        TEXT,
  created_at    TEXT NOT NULL,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS idx_custom_agents_handle ON custom_agents(org_id, handle);

/* One person's sidebar in one workspace: the conversations they starred and
   the sections they made, as JSON (people-groups.js cleans it). It only
   arranges what they can already see. */
CREATE TABLE IF NOT EXISTS sidebar_prefs (
  org_id        TEXT NOT NULL,
  login         TEXT NOT NULL,
  data          TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, login)
);

/* The audit log (docs/enterprise-audit-log.md): who did what, to what, from
   where — never what was said. Written only through audit.js, never updated
   or deleted by the app. `seq` counts up per workspace, so a gap is a
   deletion; each row's hash covers the one before it. */
CREATE TABLE IF NOT EXISTS audit_events (
  org_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  id            TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  action        TEXT NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  body          TEXT NOT NULL,
  prev_hash     TEXT,
  hash          TEXT,
  /* 1 when the people in `body` are encrypted, each under their own key
     (audit_principal_keys), and actor_id / entity_id hold pseudonyms. */
  enc           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(org_id, action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(org_id, actor_id, created_at);

/* Every attempt to deliver a webhook, the last 50 per webhook: what was
   sent, what came back, so a failure can be read and sent again. */
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            TEXT PRIMARY KEY,
  webhook_id    TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        INTEGER,
  error         TEXT,
  duration_ms   INTEGER,
  redelivery    INTEGER NOT NULL DEFAULT 0,
  attempted_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, attempted_at);

/* Links and files kept at the top of a conversation, as in Slack. */
CREATE TABLE IF NOT EXISTS channel_bookmarks (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_channel_bookmarks ON channel_bookmarks(org_id, channel, position);

/* A conversation's canvas: one shared document — the procedure, what was
   decided, who owns what — that anyone in the conversation reads and edits.
   `version` counts every save, so two people editing at once are told
   rather than one quietly overwriting the other. */
CREATE TABLE IF NOT EXISTS channel_canvases (
  org_id        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  body          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, channel)
);

/* Earlier versions of a canvas, the last 30, so a save can be undone. */
CREATE TABLE IF NOT EXISTS channel_canvas_revisions (
  org_id        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  version       INTEGER NOT NULL,
  body          TEXT NOT NULL,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, channel, version)
);

/* An owner's offer to hand the workspace on (docs/admin-controls.md §4.4).
   One at a time per workspace; the person named accepts or declines. */
CREATE TABLE IF NOT EXISTS owner_transfers (
  org_id          TEXT PRIMARY KEY,
  from_github_id  TEXT NOT NULL,
  to_github_id    TEXT NOT NULL,
  step_down       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

/* The key each person's entries in a workspace's audit log are encrypted
   under (docs/audit-log-phase2.md §2), wrapped by AUDIT_MASTER_KEY. Deleting
   an account sets wrapped_key to NULL: the rows stay and still verify, and
   nobody can read who they were about again. `principal` is the pseudonym
   the log keeps for them; `subject` finds all of one person's keys. `hold`
   keeps a key through deletion while a legal hold needs it. */
CREATE TABLE IF NOT EXISTS audit_principal_keys (
  org_id        TEXT NOT NULL,
  principal     TEXT NOT NULL,
  subject       TEXT,
  wrapped_key   TEXT,
  created_at    TEXT NOT NULL,
  shredded_at   TEXT,
  hold          INTEGER NOT NULL DEFAULT 0,
  /* The person deleted their account while a hold kept this key: it goes
     when the hold is lifted. */
  shred_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, principal)
);
CREATE INDEX IF NOT EXISTS idx_audit_keys_subject ON audit_principal_keys(subject);

/* A workspace's rules for how long a sign-in lasts in it
   (docs/admin-controls.md §3). Owners set them; NULL is no rule. */
CREATE TABLE IF NOT EXISTS org_session_policy (
  org_id                   TEXT PRIMARY KEY,
  web_max_hours            INTEGER,
  mobile_max_hours         INTEGER,
  idle_hours               INTEGER,
  reauth_for_admin_minutes INTEGER,
  updated_by               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

/* A workspace's own keys (docs/admin-controls.md §2): for an HR system or
   Terraform, owned by the workspace rather than by whoever made them. The
   value is shown once and kept only as a hash. */
CREATE TABLE IF NOT EXISTS org_keys (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  name          TEXT NOT NULL,
  scopes        TEXT NOT NULL,
  allowed_ips   TEXT,
  expires_at    TEXT,
  never_reason  TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  last_used_ip  TEXT,
  warned_at     TEXT,
  revoked_at    TEXT,
  revoked_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_keys_org ON org_keys(org_id);

/* The addresses each workspace key has been used from, so a new one is
   noticed. */
CREATE TABLE IF NOT EXISTS org_key_ips (
  key_id        TEXT NOT NULL,
  ip            TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (key_id, ip)
);

/* The admin API's answers to an Idempotency-Key, for a day. */
CREATE TABLE IF NOT EXISTS admin_idempotency (
  key_id        TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  status        INTEGER NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (key_id, idem_key)
);

/* Domains a workspace has proved are its own, by a DNS TXT record
   (docs/sso-and-domain-join.md §4). One domain, one workspace. */
CREATE TABLE IF NOT EXISTS org_domains (
  domain          TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  verify_token    TEXT NOT NULL,
  verified_at     TEXT,
  last_checked_at TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  join_policy     TEXT NOT NULL DEFAULT 'off',
  join_role       TEXT NOT NULL DEFAULT 'member',
  join_channels   TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_domains_org ON org_domains(org_id);

/* People at a workspace's domain asking to join it, when joining asks. */
CREATE TABLE IF NOT EXISTS join_requests (
  org_id          TEXT NOT NULL,
  user_github_id  TEXT NOT NULL,
  email           TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  decided_by      TEXT,
  decided_at      TEXT,
  outcome         TEXT,
  PRIMARY KEY (org_id, user_github_id)
);

/* A workspace's single sign-on connection (docs/sso-and-domain-join.md §6).
   The client secret is encrypted with SSO_SECRET_KEY and never read back. */
CREATE TABLE IF NOT EXISTS org_sso (
  org_id          TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  client_secret   TEXT NOT NULL,
  allowed_domains TEXT NOT NULL,
  hosted_domain   TEXT,
  tenant_id       TEXT,
  enforce         INTEGER NOT NULL DEFAULT 0,
  enforce_since   TEXT,
  session_hours   INTEGER,
  status          TEXT NOT NULL DEFAULT 'draft',
  tested_at       TEXT,
  test_result     TEXT,
  created_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

/* Who a person is at the identity provider, and their account here. */
CREATE TABLE IF NOT EXISTS sso_identities (
  org_id          TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  user_github_id  TEXT NOT NULL,
  email           TEXT NOT NULL,
  last_login_at   TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities(user_github_id);

/* A sign-in on its way to the provider: state, nonce, PKCE. Ten minutes. */
CREATE TABLE IF NOT EXISTS sso_states (
  state           TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  code_verifier   TEXT NOT NULL,
  return_to       TEXT,
  tester_id       TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

/* The one-time code a finished SSO sign-in is handed back with, in place
   of the session token. A minute, once. `code` is its hash. */
CREATE TABLE IF NOT EXISTS sso_handoffs (
  code            TEXT PRIMARY KEY,
  token           TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  client          TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

/* Each hour of a workspace's audit log sealed into the archive
   (docs/audit-log-phase2.md §3): the rows it covers, and the digest's hash,
   which the next hour's digest points back to. */
CREATE TABLE IF NOT EXISTS audit_seals (
  org_id        TEXT NOT NULL,
  hour          TEXT NOT NULL,
  from_seq      INTEGER NOT NULL,
  to_seq        INTEGER NOT NULL,
  digest_sha256 TEXT NOT NULL,
  sealed_at     TEXT NOT NULL,
  PRIMARY KEY (org_id, hour)
);

/* A workspace whose sealing keeps failing, and since when. */
CREATE TABLE IF NOT EXISTS audit_seal_failures (
  org_id          TEXT PRIMARY KEY,
  first_failed_at TEXT NOT NULL,
  last_error      TEXT,
  alerted         INTEGER NOT NULL DEFAULT 0
);

/* How long a workspace's audit log stays in D1, and whether a legal hold
   keeps all of it. Set by the operator, on the customer's request. */
CREATE TABLE IF NOT EXISTS org_audit_settings (
  org_id            TEXT PRIMARY KEY,
  retention_days    INTEGER,
  legal_hold        INTEGER NOT NULL DEFAULT 0,
  legal_hold_reason TEXT,
  updated_by        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
