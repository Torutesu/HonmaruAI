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
  /* 1: messages in another language are shown translated into this
     person's (translate.js). On unless they turn it off. */
  translate_messages INTEGER NOT NULL DEFAULT 1,
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

/* A workspace an owner asked to delete (workspaceDeletion.js): closed to all
   but its owners until due_at, then deleted by the daily job. purge_started_at:
   when that job claimed it; from then on it can no longer be taken back.
   purge_cursor: how far through the Jam recordings a run that stopped got. */
CREATE TABLE IF NOT EXISTS workspace_deletions (
  org_id        TEXT PRIMARY KEY,
  due_at        TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  purge_started_at TEXT,
  purge_cursor  TEXT
);

/* Each workspace's own data key, random, wrapped under DATA_KEY
   (secrets.js). Deleted with the workspace: what was sealed under it then
   opens nowhere, a backup included. */
CREATE TABLE IF NOT EXISTS workspace_keys (
  org_id        TEXT PRIMARY KEY,
  wrapped       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

/* What is left of a deleted workspace: when, and at whose request. */
CREATE TABLE IF NOT EXISTS workspace_tombstones (
  org_id        TEXT PRIMARY KEY,
  deleted_at    TEXT NOT NULL,
  requested_by  TEXT
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
/* Workflow approvals were once saved with priority "normal", which is not one
   of the priorities a card may have (agui/validate.js): the iOS app could not
   decode them and dropped the card, so the run waited on a decision nobody
   saw. Replayed on every deploy; a no-op once none are left. */
UPDATE cards SET priority = 'medium', data = json_set(data, '$.priority', 'medium')
 WHERE json_extract(data, '$.priority') = 'normal';

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
  sso_org_id          TEXT,
  sso_connection_id   TEXT,
  /* For an OIDC sign-in, what lets the provider end it (sso.js): who it
     was there (sub), which sign-in (sid), and a refresh token (sealed) to
     ask it now and then whether they may still sign in. */
  sso_subject         TEXT,
  sso_sid             TEXT,
  sso_refresh         TEXT,
  sso_checked_at      TEXT
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
   (or Google) makes unique, and because the same person on two phones must get
   both. The login is denormalized alongside the numeric id: the relay knows a
   recipient by their login and would otherwise need a join on the hot path of
   every card. `platform` says which push service the token belongs to: 'ios'
   goes to APNs, 'android' to FCM. Every row from before Android is an iPhone. */
CREATE TABLE IF NOT EXISTS device_tokens (
  device_token   TEXT PRIMARY KEY,
  user_github_id TEXT NOT NULL,
  login          TEXT NOT NULL,
  environment    TEXT NOT NULL DEFAULT 'production',
  updated_at     TEXT NOT NULL,
  platform       TEXT NOT NULL DEFAULT 'ios',
  /* The iPhone app the token is for (its bundle id), so the Expo build and the
     App Store app are each sent under their own APNs topic. NULL: registered
     before devices said, which is the App Store app. */
  app_id         TEXT
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
/* A metered call's place in the day's allowance, held from the check until
   the call is counted in ai_usage or let go (gate.js). Counted with `used`
   when the next call is checked, so two calls checked at once cannot both
   take the last one. One never settled lapses at expires_at (ms). */
CREATE TABLE IF NOT EXISTS ai_reservations (
  id             TEXT PRIMARY KEY,
  user_github_id TEXT NOT NULL,
  day            TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_reservations_user ON ai_reservations (user_github_id, day, expires_at);

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
  gemini_key    TEXT,
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
  scopes         TEXT,
  /* When it stops. NULL: made before tokens expired; set on its next use. */
  expires_at     TEXT,
  /* Made from a sign-in through the workspace's SSO: it keeps working in a
     workspace that requires SSO. */
  sso_backed     INTEGER NOT NULL DEFAULT 0
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
  /* Slack's verbs on a message: edited in place, deleted (unsent: the row
     stays with its words gone, its thread is deleted with it, and no page
     of history shows it), a reply in a thread under another, pinned. */
  edited_at     TEXT,
  deleted_at    TEXT,
  parent_id     TEXT,
  pinned_at     TEXT,
  pinned_by     TEXT,
  pin_version   INTEGER NOT NULL DEFAULT 0,
  /* The author took the link cards off this message. */
  previews_hidden INTEGER NOT NULL DEFAULT 0,
  /* An inline reply, as Discord has: the message this one answers, in the
     same conversation. Its words are looked up when read, never copied, so
     an edit or an unsend shows in the quote too. */
  reply_to_id   TEXT,
  /* The sender's own id for this post (`tmp-…`). A retry of a send that
     already landed returns this row instead of writing another. */
  client_id     TEXT,
  /* A thread reply sent to the conversation as well ("Also send to
     #channel"): one message, read in its thread and in the conversation. */
  also_channel  INTEGER NOT NULL DEFAULT 0,
  /* Said by an agent for a person who was mentioned (proxy.js): whose
     agent it is, so it reads as theirs and never as them. */
  on_behalf_of  TEXT
);
/* The index for `client_id` is in migrations.sql, after the ALTER that adds
   it, for the same reason as `ref` above. */
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
  read_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, login, channel)
);

/* Activity items a person has looked at, on any device: `m:<message>` or
   `r:<message>:<who+emoji>`. Kept a month, as long as Activity looks back. */
CREATE TABLE IF NOT EXISTS activity_reads (
  org_id   TEXT NOT NULL,
  login    TEXT NOT NULL,
  item     TEXT NOT NULL,
  read_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, login, item)
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
  sent_at       TEXT,
  also_channel  INTEGER NOT NULL DEFAULT 0,
  /* A cron run sending it holds it until then (later.js). `sent_at` is
     written only once it is posted; a run that fails or dies leaves this
     to run out, and it is tried again. */
  lease_until   TEXT
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
/* The minute cron's question: reminders that are due. Partial, so only the
   items still waiting on a reminder are in it. */
CREATE INDEX IF NOT EXISTS idx_saved_items_remind ON saved_items(remind_at) WHERE done_at IS NULL AND reminded_at IS NULL AND remind_at IS NOT NULL;

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
  used_at        TEXT,
  sso_backed     INTEGER NOT NULL DEFAULT 0
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

/* R2 keys whose delete failed, tried again by the cron with backoff until they
   go (files.js deleteMediaKeys / retryMediaDeletions). Without this a refused
   delete left the bytes in the bucket with nothing pointing at them. */
CREATE TABLE IF NOT EXISTS media_deletions (
  key         TEXT PRIMARY KEY,
  org_id      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  next_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_deletions_due ON media_deletions(next_at);

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
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  last_error TEXT,
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
  /* A picture in place of the emoji, when somebody gave it one: a URL of
     ours (/agents/avatar/…), the bytes in R2. */
  avatar_url    TEXT,
  description   TEXT,
  instructions  TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'team',
  owner_login   TEXT NOT NULL,
  created_by_login TEXT,
  preset        TEXT,
  created_at    TEXT NOT NULL,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  /* Set for an AI teammate (teammates.js): "claude". It answers through
     that service, not the workspace's model. */
  provider      TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS idx_custom_agents_handle ON custom_agents(org_id, handle);

/* An AI teammate, set up by an admin (teammates.js): the key of the account
   made for it, what it may reach, where it may work and what it may spend.
   Tool keys are not here: they go to the service's own vault. */
CREATE TABLE IF NOT EXISTS ai_teammates (
  org_id              TEXT NOT NULL,
  provider            TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 0,
  api_key             TEXT,
  github_token        TEXT,
  repos               TEXT,
  model               TEXT,
  instructions        TEXT,
  /* JSON list of channel keys; NULL is every channel. */
  channels            TEXT,
  /* NULL is no limit. */
  monthly_limit_cents INTEGER,
  /* JSON: [{name, secretName, host, credentialId}]. */
  tools               TEXT,
  /* JSON: the service's own ids (agent, environment, vault). */
  remote              TEXT,
  agent_id            TEXT,
  updated_by          TEXT,
  updated_at          TEXT NOT NULL,
  /* An issue link or a bug report posted in a channel starts it on its own
     (autoBuild.js). On unless turned off. */
  auto_build          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, provider)
);

/* What was started on its own (autoBuild.js), once each: an issue by
   owner/name#number, a report by its message. */
CREATE TABLE IF NOT EXISTS auto_builds (
  org_id     TEXT NOT NULL,
  key        TEXT NOT NULL,
  message_id TEXT NOT NULL,
  run_id     TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);

/* One piece of work a teammate took on in a thread: its session there,
   what it has cost and how far it has been read. */
CREATE TABLE IF NOT EXISTS ai_teammate_runs (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  provider       TEXT NOT NULL,
  channel        TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  remote_id      TEXT NOT NULL,
  remote_turn    TEXT,
  status         TEXT NOT NULL,
  cost_cents     INTEGER NOT NULL DEFAULT 0,
  last_event_at  TEXT,
  started_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  /* Working for a person who was mentioned (proxy.js): its answer is theirs. */
  on_behalf_of   TEXT,
  room_hook_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_teammate_runs_status ON ai_teammate_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_teammate_runs_thread ON ai_teammate_runs(org_id, channel, thread_id);
CREATE INDEX IF NOT EXISTS idx_teammate_runs_month ON ai_teammate_runs(org_id, provider, created_at);

/* An agent added to a channel or a group: shown among its members, and
   called there by anyone in it — a personal agent too, once its owner
   brings it in. */
CREATE TABLE IF NOT EXISTS channel_agents (
  org_id    TEXT NOT NULL,
  channel   TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  added_by  TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, channel, agent_id)
);

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

/* A message put into one reader's language: written once per message and
   language, and again only when the message is edited (source_hash). */
CREATE TABLE IF NOT EXISTS message_translations (
  org_id       TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  locale       TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (org_id, message_id, locale)
);

/* A channel's context, written by the model for the record: kept with a
   fingerprint of what it read (in last_message_at, a name from when it held
   the newest message's time), so it is written again only after something
   it read changed (channelContext.js). One per reader language. */
CREATE TABLE IF NOT EXISTS channel_context_cache (
  org_id           TEXT NOT NULL,
  channel          TEXT NOT NULL,
  locale           TEXT NOT NULL,
  body             TEXT NOT NULL,
  generated_at     TEXT NOT NULL,
  last_message_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, channel, locale)
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

/* The admin API's answers to an Idempotency-Key, for a day (adminApi.js).
   status 0: claimed by a request still being carried out. */
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

/* People at a workspace's domain asking to join it, when joining asks. One
   held from an invitation (via 'invite') keeps the channels it named (JSON)
   and who sent it, so approving it lets them in where the invitation would
   have. */
CREATE TABLE IF NOT EXISTS join_requests (
  org_id          TEXT NOT NULL,
  user_github_id  TEXT NOT NULL,
  email           TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  decided_by      TEXT,
  decided_at      TEXT,
  outcome         TEXT,
  role            TEXT,
  via             TEXT,
  channels        TEXT,
  invited_by      TEXT,
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

/* Who a person is at Apple (Sign in with Apple, src/apple.js): Apple's stable
   `sub` for our team, and their account here. The address is the one Apple
   last vouched for — often a private relay one. `refresh_token` is Apple's,
   from trading the app's authorization code, sealed under DATA_KEY and kept
   only so deleting the account can revoke it; `client_id` is the app it was
   issued to. Both are empty for a sign-in made before they were kept. */
CREATE TABLE IF NOT EXISTS apple_identities (
  subject         TEXT PRIMARY KEY,
  user_github_id  TEXT NOT NULL,
  email           TEXT,
  created_at      TEXT NOT NULL,
  last_login_at   TEXT NOT NULL,
  refresh_token   TEXT,
  client_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_apple_identities_user ON apple_identities(user_github_id);

/* A sign-in on its way to the provider: state, nonce, PKCE. Ten minutes. */
CREATE TABLE IF NOT EXISTS sso_states (
  state           TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  code_verifier   TEXT NOT NULL,
  return_to       TEXT,
  tester_id       TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  connection_id   TEXT,
  /* The hash of the secret the web page that started this keeps (sso.js). */
  browser_hash    TEXT
);

/* The one-time code a finished SSO sign-in is handed back with, in place
   of the session token. A minute, once. `code` is its hash. */
CREATE TABLE IF NOT EXISTS sso_handoffs (
  code            TEXT PRIMARY KEY,
  token           TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  client          TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  browser_hash    TEXT
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
/* The last sealed row of a workspace, read once an hour (sealPending). */
CREATE INDEX IF NOT EXISTS idx_audit_seals_seq ON audit_seals(org_id, to_seq);

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

/* Where a workspace's audit log is streamed (docs/audit-log-phase2.md §4):
   its SIEM over HTTPS, Splunk HEC or Datadog, and how far it has got. The
   secret is encrypted and never read back. */
CREATE TABLE IF NOT EXISTS audit_streams (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  secret        TEXT NOT NULL,
  region        TEXT,
  min_severity  TEXT NOT NULL DEFAULT 'info',
  categories    TEXT,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  failures      INTEGER NOT NULL DEFAULT 0,
  next_try_at   TEXT,
  failing_since TEXT,
  last_error    TEXT,
  last_sent_at  TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_streams_org ON audit_streams(org_id);

/* People and groups a workspace's identity provider keeps here over SCIM
   2.0 (docs/sso-and-domain-join.md §11). `id` is the SCIM id the provider
   addresses them by; `active = 0` is someone it has stopped, who is no
   longer a member. A group is a user group (`user_groups.handle`). */
CREATE TABLE IF NOT EXISTS scim_users (
  org_id         TEXT NOT NULL,
  id             TEXT NOT NULL,
  user_github_id TEXT NOT NULL,
  user_name      TEXT NOT NULL,
  external_id    TEXT,
  display_name   TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_users_name ON scim_users(org_id, user_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_users_user ON scim_users(org_id, user_github_id);
CREATE TABLE IF NOT EXISTS scim_groups (
  org_id         TEXT NOT NULL,
  id             TEXT NOT NULL,
  handle         TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  external_id    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (org_id, id)
);

/* Data loss prevention (docs/enterprise-audit-log.md §10): what a workspace
   does not want said in it. `kind` is builtin (a detector by `detector`),
   regex (`pattern`) or keywords (`pattern` is a JSON list). A rule warns or
   blocks; what it matched is never stored. */
CREATE TABLE IF NOT EXISTS dlp_rules (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detector    TEXT,
  pattern     TEXT,
  action      TEXT NOT NULL DEFAULT 'warn',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dlp_rules_org ON dlp_rules(org_id);

/* Whether attached pictures and scanned PDF pages are read (ocr.js): off
   unless an admin turns it on, since the picture goes to the AI model. */
CREATE TABLE IF NOT EXISTS dlp_settings (
  org_id      TEXT PRIMARY KEY,
  read_images INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT,
  updated_at  TEXT
);

/* A workspace's identity providers (docs/sso-and-domain-join.md §11): one
   per company or subsidiary, each for its own domains, OIDC or SAML. The
   first workspace setup lived in `org_sso`; it moves here the first time it
   is read. Whether SSO is required is the workspace's (`org_sso_policy`). */
CREATE TABLE IF NOT EXISTS sso_connections (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  name            TEXT,
  provider        TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  client_id       TEXT,
  client_secret   TEXT,
  sso_url         TEXT,
  idp_cert        TEXT,
  /* Where the IdP takes our answer to its logout (SAML SLO), when it has one. */
  idp_slo_url     TEXT,
  allowed_domains TEXT NOT NULL,
  hosted_domain   TEXT,
  tenant_id       TEXT,
  session_hours   INTEGER,
  status          TEXT NOT NULL DEFAULT 'draft',
  tested_at       TEXT,
  test_result     TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sso_connections_org ON sso_connections(org_id);
CREATE TABLE IF NOT EXISTS org_sso_policy (
  org_id          TEXT PRIMARY KEY,
  enforce         INTEGER NOT NULL DEFAULT 0,
  enforce_since   TEXT,
  updated_at      TEXT NOT NULL
);

/* What a company decides about its workspace (docs/enterprise-audit-log.md
   §10): how long messages and files are kept (days; NULL is for ever), the
   networks it may be used from, and who may be invited. */
CREATE TABLE IF NOT EXISTS org_governance (
  org_id                  TEXT PRIMARY KEY,
  retention_public_days   INTEGER,
  retention_private_days  INTEGER,
  retention_dm_days       INTEGER,
  retention_files_days    INTEGER,
  ip_enforce              INTEGER NOT NULL DEFAULT 0,
  ip_allowlist            TEXT,
  invite_policy           TEXT NOT NULL DEFAULT 'open',
  invite_guests_exempt    INTEGER,
  /* A repository's workspace: whoever has write access on GitHub comes in
     by themselves. NULL is on (as before); 0, an owner turned it off, and
     only an invitation brings someone in. */
  github_auto_join        INTEGER,
  updated_by              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

/* Legal holds on messages: a person (by login) or a channel (by key). What
   they cover is never deleted by retention, and an edit or an unsend keeps
   the earlier words in message_history, for exports only. */
CREATE TABLE IF NOT EXISTS message_holds (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_holds_org ON message_holds(org_id, released_at);
CREATE TABLE IF NOT EXISTS message_history (
  org_id              TEXT NOT NULL,
  message_id          TEXT NOT NULL,
  channel             TEXT NOT NULL,
  author_login        TEXT,
  body                TEXT NOT NULL,
  message_created_at  TEXT NOT NULL,
  reason              TEXT NOT NULL,
  recorded_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_history ON message_history(org_id, message_created_at);

/* Compliance exports: JSON Lines in storage for a week, owners only. */
CREATE TABLE IF NOT EXISTS compliance_exports (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  range_from    TEXT NOT NULL,
  range_to      TEXT NOT NULL,
  filters       TEXT,
  status        TEXT NOT NULL,
  object_key    TEXT,
  counts        TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_exports_org ON compliance_exports(org_id, created_at);

/* Logout tokens already taken (OIDC back-channel logout), so one sent again
   cannot end a later sign-in. Kept a little past when they could be used. */
CREATE TABLE IF NOT EXISTS sso_logout_tokens (
  id          TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL
);

/* Apps through Smithery Connect (smitheryApps.js, docs/smithery-apps.md).
   The apps an owner allows in a workspace; none by default. */
CREATE TABLE IF NOT EXISTS org_apps (
  org_id        TEXT NOT NULL,
  server        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  icon_url      TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  allow_writes  INTEGER NOT NULL DEFAULT 0,
  added_by      TEXT,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, server)
);

/* One person's connection to one allowed app, in one workspace. The ID is
   random and never leaves the server; a route finds a row only by who asks. */
CREATE TABLE IF NOT EXISTS app_connections (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  user_github_id  TEXT NOT NULL,
  server          TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (org_id, user_github_id, server)
);

/* Connections ended here whose deletion at Smithery has not gone through
   yet; the sweep retries them. */
CREATE TABLE IF NOT EXISTS app_connection_tombstones (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

/* Lookups by person across workspaces, and the sweeps that run every
   minute, without reading whole tables as the data grows. */
CREATE INDEX IF NOT EXISTS idx_sessions_github ON sessions(github_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_github_id);
CREATE INDEX IF NOT EXISTS idx_cards_org_created ON cards(org_id, created_at);
/* Daily report drafts, which the 15-minute cron looks for (dailyReport.js).
   Partial, so a card that is not a draft costs nothing here. */
CREATE INDEX IF NOT EXISTS idx_cards_daily_draft ON cards(created_at) WHERE json_extract(data, '$.dailyReport.status') = 'draft';
CREATE INDEX IF NOT EXISTS idx_channel_messages_author ON channel_messages(org_id, author_login, created_at);
CREATE INDEX IF NOT EXISTS idx_push_queue_created ON push_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_reads_read ON activity_reads(read_at);

/* A session is the account's; which workspaces it has been used in, and
   where it was signed out of one workspace only (by that workspace's admin
   or its rules) — without touching the others. */
CREATE TABLE IF NOT EXISTS session_workspaces (
  token         TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  ended_at      TEXT,
  PRIMARY KEY (token, org_id)
);
CREATE INDEX IF NOT EXISTS idx_session_workspaces_org ON session_workspaces(org_id);

/* Somebody at the app, per workspace (pushes.js): being at one team's app
   does not silence another team's pushes, nor answer another's "@here". */
CREATE TABLE IF NOT EXISTS workspace_activity (
  org_id          TEXT NOT NULL,
  login           TEXT NOT NULL,
  last_active_at  TEXT NOT NULL,
  client          TEXT,
  PRIMARY KEY (org_id, login)
);
CREATE INDEX IF NOT EXISTS idx_workspace_activity_seen ON workspace_activity(org_id, last_active_at);
CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY, org_id TEXT, login TEXT NOT NULL, card_id TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL, lease_until TEXT,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_due ON notification_jobs(state, due_at);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, channel TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0, status_code INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_job ON notification_deliveries(job_id);

/* A person's agent, answering for them when they are mentioned (proxy.js).
   Off until they turn it on. `agent_id` is one of their own personal
   agents; `use_teammate` lets work on code go to the workspace's AI
   teammate instead. */
CREATE TABLE IF NOT EXISTS proxies (
  org_id        TEXT NOT NULL,
  login         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  agent_id      TEXT,
  use_teammate  INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, login)
);

/* Something a person's agent would do outside the chat — a comment on a
   pull request — waiting on that person's approval, as a card to them. */
CREATE TABLE IF NOT EXISTS proxy_actions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  login         TEXT NOT NULL,
  card_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  channel       TEXT NOT NULL,
  thread_id     TEXT,
  agent_login   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  result        TEXT,
  created_at    TEXT NOT NULL,
  settled_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_proxy_actions_card ON proxy_actions(org_id, card_id);

/* ── Harness (docs/kylon-gap-plan.md) ─────────────────────────────────────
   Everything below backs the Kylon-style surfaces. A workspace in "simple"
   mode never sees them; the tables exist either way so a switch back and
   forth loses nothing. */

/* Which face a workspace shows: 'simple' (the decision feed and chat, as
   Honmaru always was) or 'harness' (plus Apps, Tables, Agents as members,
   Workflows, Follow-ups, Approvals, Skills). No row means 'simple'. */
CREATE TABLE IF NOT EXISTS org_settings (
  org_id        TEXT PRIMARY KEY,
  mode          TEXT NOT NULL DEFAULT 'simple',
  updated_by    TEXT,
  updated_at    TEXT NOT NULL
);

/* A typed table: the database under an App. Columns are JSON
   [{ id, name, type, options? }] (harness/tables.js). */
CREATE TABLE IF NOT EXISTS hx_tables (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  columns       TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hx_tables_org ON hx_tables(org_id);

/* One row of a table. data is JSON keyed by column id. */
CREATE TABLE IF NOT EXISTS hx_rows (
  id            TEXT PRIMARY KEY,
  table_id      TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  data          TEXT NOT NULL,
  position      REAL NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  updated_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hx_rows_table ON hx_rows(table_id, position);

/* An internal app: a table plus the views over it (harness/apps.js). The
   definition is the current version; every earlier one is kept below. */
CREATE TABLE IF NOT EXISTS hx_apps (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,
  table_id      TEXT NOT NULL,
  template      TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  definition    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hx_apps_org ON hx_apps(org_id);

CREATE TABLE IF NOT EXISTS hx_app_versions (
  app_id        TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  version       INTEGER NOT NULL,
  definition    TEXT NOT NULL,
  note          TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (app_id, version)
);

/* An app pinned to a room: it shows wherever it is linked. */
CREATE TABLE IF NOT EXISTS hx_app_links (
  app_id        TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (app_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_hx_app_links_channel ON hx_app_links(org_id, channel);

/* What makes a custom agent a member (harness/agents.js): its specialty,
   the tier it thinks at, whether it speaks only when named, and who may
   call it. No row means the agent as it always was. */
CREATE TABLE IF NOT EXISTS hx_agent_profiles (
  org_id        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  specialty     TEXT,
  tier          TEXT NOT NULL DEFAULT 'standard',
  mention_only  INTEGER NOT NULL DEFAULT 0,
  access        TEXT NOT NULL DEFAULT 'everyone',
  people        TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, agent_id)
);

/* What one agent remembers, across every conversation it is in: written by
   people ("@agent remember …") or by the agent's own notes. Visible,
   editable, forgettable — like the playbook, but the agent's own. */
CREATE TABLE IF NOT EXISTS hx_agent_memories (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  text          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'person',
  created_by    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hx_agent_memories ON hx_agent_memories(org_id, agent_id, created_at);

/* Skills: the team's way of doing a thing, written once and given to any
   agent that needs it (harness/skills.js). */
CREATE TABLE IF NOT EXISTS hx_skills (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  body          TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  owner_id      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  metadata      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_hx_skills_org ON hx_skills(org_id);

CREATE TABLE IF NOT EXISTS hx_agent_skills (
  org_id        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  skill_id      TEXT NOT NULL,
  added_by      TEXT NOT NULL,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, agent_id, skill_id)
);

/* Workflows (harness/workflows.js): a trigger — by hand, a schedule, a
   webhook, a row added or changed — and the steps that follow. */
CREATE TABLE IF NOT EXISTS hx_workflows (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  trigger       TEXT NOT NULL,
  steps         TEXT NOT NULL,
  hook_secret   TEXT,
  next_run_at   TEXT,
  last_run_at   TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hx_workflows_org ON hx_workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_hx_workflows_due ON hx_workflows(enabled, next_run_at);

/* Paused webhook input is retained without starting a run. */
CREATE TABLE IF NOT EXISTS hx_workflow_held_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES hx_workflows(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_hx_held_workflow ON hx_workflow_held_events(org_id, workflow_id, received_at);
CREATE INDEX IF NOT EXISTS idx_hx_held_expiry ON hx_workflow_held_events(expires_at);

/* Every run, kept: what started it, each step's outcome, and where it
   stopped — waiting on a person's approval, done, or failed. */
CREATE TABLE IF NOT EXISTS hx_workflow_runs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL,
  input         TEXT,
  log           TEXT NOT NULL,
  next_step     INTEGER NOT NULL DEFAULT 0,
  card_id       TEXT,
  started_by    TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_hx_runs_workflow ON hx_workflow_runs(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_hx_runs_card ON hx_workflow_runs(org_id, card_id);

/* Follow-ups (harness/followups.js): an agent, or the team's AI, comes back
   to a conversation at a set time to do something again. */
CREATE TABLE IF NOT EXISTS hx_followups (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  thread_id     TEXT,
  agent_id      TEXT,
  instruction   TEXT NOT NULL,
  due_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  done_at       TEXT,
  result        TEXT
);
CREATE INDEX IF NOT EXISTS idx_hx_followups_due ON hx_followups(status, due_at);
CREATE INDEX IF NOT EXISTS idx_hx_followups_channel ON hx_followups(org_id, channel, status);

/* Room rules survive Simple / Harness switches. */
CREATE TABLE IF NOT EXISTS hx_room_guidelines (org_id TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, channel));

CREATE TABLE IF NOT EXISTS hx_memory_scopes (memory_id TEXT PRIMARY KEY REFERENCES hx_agent_memories(id) ON DELETE CASCADE, org_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'context');

CREATE TABLE IF NOT EXISTS hx_workflow_run_definitions (run_id TEXT PRIMARY KEY REFERENCES hx_workflow_runs(id) ON DELETE CASCADE, org_id TEXT NOT NULL, definition TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hx_app_access (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, visibility TEXT NOT NULL CHECK (visibility IN ('workspace', 'private')), version INTEGER NOT NULL, PRIMARY KEY (org_id, app_id));

CREATE TABLE IF NOT EXISTS hx_skill_access (org_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES hx_skills(id) ON DELETE CASCADE, visibility TEXT NOT NULL CHECK (visibility IN ('workspace', 'private')), version INTEGER NOT NULL, PRIMARY KEY (org_id, skill_id));

CREATE TABLE IF NOT EXISTS hx_gateways (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS hx_gateway_jobs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, gateway_id TEXT NOT NULL REFERENCES hx_gateways(id), created_by TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, lease_hash TEXT, lease_until INTEGER, deadline INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, UNIQUE(org_id, created_by, request_id));
CREATE INDEX IF NOT EXISTS hx_gateway_jobs_queue ON hx_gateway_jobs(gateway_id, status, created_at);

/* Company Harness app capabilities; all resources retain the app ACL. */
CREATE TABLE IF NOT EXISTS hx_app_database_state (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(org_id,app_id));
CREATE TABLE IF NOT EXISTS hx_app_entities (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, entity_key TEXT NOT NULL, table_id TEXT NOT NULL UNIQUE, PRIMARY KEY(org_id,app_id,entity_key));
CREATE TABLE IF NOT EXISTS hx_app_migrations (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, migration_id TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL, plan TEXT NOT NULL, nonce TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id,migration_id), UNIQUE(org_id,app_id,version));
CREATE TABLE IF NOT EXISTS hx_app_forks (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, created_by TEXT NOT NULL, id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id,created_by));
CREATE TABLE IF NOT EXISTS hx_app_actions (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, name TEXT NOT NULL, version INTEGER NOT NULL, draft TEXT NOT NULL, published TEXT, published_version INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id,name));
CREATE TABLE IF NOT EXISTS hx_app_action_versions (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, name TEXT NOT NULL, version INTEGER NOT NULL, code TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id,name,version));
CREATE TABLE IF NOT EXISTS hx_app_action_jobs (org_id TEXT NOT NULL, app_id TEXT NOT NULL, job_id TEXT NOT NULL PRIMARY KEY, action_name TEXT NOT NULL, action_version INTEGER NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hx_app_connections (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, created_by TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'GET', token TEXT, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(org_id,app_id,created_by,name));

CREATE TABLE IF NOT EXISTS hx_app_connection_requests (org_id TEXT NOT NULL,app_id TEXT NOT NULL,created_by TEXT NOT NULL,request_id TEXT NOT NULL,connection_name TEXT NOT NULL,connection_version INTEGER NOT NULL,body_hash TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(org_id,app_id,created_by,request_id));

/* Immutable baselines and one-shot, reviewed preview merges. */
CREATE TABLE IF NOT EXISTS hx_app_fork_bases (org_id TEXT NOT NULL,app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE,created_by TEXT NOT NULL,fork_id TEXT NOT NULL PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hx_app_fork_merges (org_id TEXT NOT NULL,app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE,created_by TEXT NOT NULL,fork_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL,checksum TEXT NOT NULL,nonce TEXT NOT NULL,plan TEXT NOT NULL,created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hx_app_pins (org_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(org_id,user_id,app_id));

CREATE TABLE IF NOT EXISTS hx_personal_views (
 org_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
 app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 settings TEXT NOT NULL,
 PRIMARY KEY(org_id,user_id,app_id)
);

/* One durable conversation per app or app/entity/record. Access is rechecked on every operation. */
CREATE TABLE IF NOT EXISTS hx_app_messages (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 org_id TEXT NOT NULL,
 app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE,
 table_id TEXT NOT NULL DEFAULT '',
 row_id TEXT NOT NULL DEFAULT '',
 author_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 body TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(org_id,app_id,table_id,row_id,author_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_hx_app_messages_scope ON hx_app_messages(org_id,app_id,table_id,row_id,sequence);

CREATE TABLE IF NOT EXISTS hx_app_conversation_sources (
 org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE,
 channel TEXT NOT NULL, thread_id TEXT NOT NULL, created_by TEXT NOT NULL,
 PRIMARY KEY(org_id,app_id)
);
CREATE TABLE IF NOT EXISTS hx_app_notifications (
 org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE,
 message_id INTEGER NOT NULL REFERENCES hx_app_messages(sequence) ON DELETE CASCADE,
 user_id TEXT NOT NULL, kind TEXT NOT NULL, read_at TEXT,
 PRIMARY KEY(message_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_hx_app_notifications_user ON hx_app_notifications(org_id,user_id,app_id);
CREATE TABLE IF NOT EXISTS hx_app_ai_replies (
 message_id INTEGER PRIMARY KEY REFERENCES hx_app_messages(sequence) ON DELETE CASCADE,
 org_id TEXT NOT NULL, app_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
 started_at INTEGER NOT NULL DEFAULT (unixepoch())
);

/* Durable app creation retries and source capture. */
CREATE TABLE IF NOT EXISTS hx_app_generation_jobs (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','failed','complete')),
  generated TEXT,
  app_id TEXT,
  PRIMARY KEY(org_id,user_id,request_id),
  CHECK(status != 'complete' OR (app_id IS NOT NULL AND generated IS NOT NULL))
);

/* Shared thread names are separate from the original message and its history. */
CREATE TABLE IF NOT EXISTS channel_thread_details (
  org_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, message_id)
);

CREATE TABLE IF NOT EXISTS channel_thread_pins (org_id TEXT NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (org_id,user_id,message_id));
CREATE TABLE IF NOT EXISTS channel_thread_shares (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL,
  digest TEXT NOT NULL, access_digest TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_thread_shares_org ON channel_thread_shares(org_id,message_id);
CREATE TABLE IF NOT EXISTS channel_thread_share_policy (
  org_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_thread_mutes (org_id TEXT NOT NULL, login TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, PRIMARY KEY (org_id,login,message_id));
CREATE INDEX IF NOT EXISTS idx_channel_thread_mutes_message ON channel_thread_mutes(org_id,message_id,login);

CREATE TABLE IF NOT EXISTS hx_skill_files (org_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES hx_skills(id) ON DELETE CASCADE, path TEXT NOT NULL, size INTEGER NOT NULL CHECK (size >= 0 AND size <= 1048576), content BLOB NOT NULL, PRIMARY KEY (org_id, skill_id, path));

/* Room-level explicit addressing policy, independent of presentation mode. */
CREATE TABLE IF NOT EXISTS hx_room_responses (
  org_id TEXT NOT NULL, channel TEXT NOT NULL, mentioned_only INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, channel)
);

/* Full structured memory alongside the backwards-compatible short note. */
CREATE TABLE IF NOT EXISTS hx_memory_entries (
  memory_id TEXT PRIMARY KEY REFERENCES hx_agent_memories(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

/* Explicit human roles for managed agents. The maker is an implicit admin;
   workspace membership must still be active whenever a role is used. */
CREATE TABLE IF NOT EXISTS hx_agent_access (
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT,
  PRIMARY KEY (org_id, agent_id),
  FOREIGN KEY (org_id, agent_id) REFERENCES custom_agents(org_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hx_agent_members (
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  member_since TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, agent_id, user_id),
  FOREIGN KEY (org_id, agent_id) REFERENCES custom_agents(org_id, id) ON DELETE CASCADE
);

/* Atomic member departure receipts gate the associated ownership writes. */
CREATE TABLE IF NOT EXISTS hx_member_departures (
  org_id TEXT NOT NULL, user_id TEXT NOT NULL, nonce TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id)
);

/* Explicit room administration; membership stamps prevent revived grants. */
CREATE TABLE IF NOT EXISTS hx_room_access (org_id TEXT NOT NULL, channel TEXT NOT NULL, version INTEGER NOT NULL, mutation_id TEXT, deleted_at TEXT, PRIMARY KEY (org_id,channel));
CREATE TABLE IF NOT EXISTS hx_room_roles (org_id TEXT NOT NULL, channel TEXT NOT NULL, subject_kind TEXT NOT NULL CHECK(subject_kind IN ('person','agent')), subject_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), member_since TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,channel,subject_kind,subject_id));

CREATE TABLE IF NOT EXISTS hx_room_creations (org_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, channel TEXT NOT NULL, fingerprint TEXT NOT NULL, member_since TEXT NOT NULL, nonce TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,user_id,request_id), UNIQUE(org_id,channel));

CREATE TABLE IF NOT EXISTS hx_room_appearance (org_id TEXT NOT NULL, channel TEXT NOT NULL, color TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,channel));

/* Private room visual metadata. Bytes require room ACL checks. */
CREATE TABLE IF NOT EXISTS hx_room_visuals (org_id TEXT NOT NULL, channel TEXT NOT NULL, object_key TEXT NOT NULL, content_type TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,channel));

CREATE TABLE IF NOT EXISTS hx_room_hooks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel TEXT NOT NULL, name TEXT NOT NULL, creator_id TEXT NOT NULL, member_since TEXT NOT NULL, secret_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hx_room_hooks_room ON hx_room_hooks(org_id,channel,created_at);
CREATE TABLE IF NOT EXISTS hx_room_hook_events (event_key TEXT PRIMARY KEY, hook_id TEXT NOT NULL, org_id TEXT NOT NULL, channel TEXT NOT NULL, payload_hash TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hx_room_hook_dispatch (message_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hx_room_hook_dispatch_due ON hx_room_hook_dispatch(status,next_attempt,lease_until);

/* Validation is independent from editing and belongs to the reviewed version. */
CREATE TABLE IF NOT EXISTS hx_memory_reviews (
  memory_id TEXT PRIMARY KEY REFERENCES hx_agent_memories(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  reviewed_version INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hx_memory_review_history (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES hx_agent_memories(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  reviewed_version INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hx_memory_review_history ON hx_memory_review_history(org_id,memory_id,reviewed_at,id);

INSERT OR IGNORE INTO hx_memory_review_history (id,memory_id,org_id,reviewed_version,verdict,evidence,reviewed_by,reviewed_at)
SELECT 'legacy:' || r.memory_id,r.memory_id,r.org_id,r.reviewed_version,'keep',r.evidence,r.reviewed_by,r.reviewed_at
FROM hx_memory_reviews r WHERE NOT EXISTS (
  SELECT 1 FROM hx_memory_review_history h WHERE h.org_id=r.org_id AND h.memory_id=r.memory_id
);

/* Review evidence survives memory deletion; body content is not copied. */
CREATE TABLE IF NOT EXISTS hx_memory_review_audit (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  reviewed_version INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hx_memory_review_audit_scope ON hx_memory_review_audit(org_id,agent_id,channel,reviewed_at,id);
CREATE INDEX IF NOT EXISTS idx_hx_memory_review_audit_memory ON hx_memory_review_audit(org_id,memory_id,reviewed_at,id);
INSERT OR IGNORE INTO hx_memory_review_audit (id,memory_id,org_id,agent_id,channel,reviewed_version,verdict,evidence,reviewed_by,reviewed_at)
SELECT h.id,h.memory_id,h.org_id,m.agent_id,COALESCE(s.channel,''),h.reviewed_version,h.verdict,h.evidence,h.reviewed_by,h.reviewed_at
FROM hx_memory_review_history h JOIN hx_agent_memories m ON m.id=h.memory_id AND m.org_id=h.org_id
LEFT JOIN hx_memory_scopes s ON s.memory_id=m.id AND s.org_id=m.org_id;
CREATE TRIGGER IF NOT EXISTS hx_memory_review_audit_insert AFTER INSERT ON hx_memory_review_history
BEGIN
  INSERT INTO hx_memory_review_audit (id,memory_id,org_id,agent_id,channel,reviewed_version,verdict,evidence,reviewed_by,reviewed_at)
  SELECT NEW.id,NEW.memory_id,NEW.org_id,m.agent_id,COALESCE(s.channel,''),NEW.reviewed_version,NEW.verdict,NEW.evidence,NEW.reviewed_by,NEW.reviewed_at
  FROM hx_agent_memories m LEFT JOIN hx_memory_scopes s ON s.memory_id=m.id AND s.org_id=m.org_id
  WHERE m.id=NEW.memory_id AND m.org_id=NEW.org_id;
END;

CREATE TABLE IF NOT EXISTS hx_skill_source_scopes (
  org_id TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES hx_skills(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  memory_id TEXT NOT NULL,
  memory_version INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_source_agent ON hx_skill_source_scopes(org_id,agent_id,channel);

CREATE TABLE IF NOT EXISTS hx_memory_skill_conversions (
  org_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_version INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  keep_entry INTEGER NOT NULL CHECK(keep_entry IN (0,1)),
  skill_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,request_id),
  UNIQUE(org_id,memory_id,memory_version)
);

CREATE TABLE IF NOT EXISTS hx_agent_assignments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
  initial_agent_id TEXT NOT NULL, current_agent_id TEXT NOT NULL, channel TEXT NOT NULL,
  thread_id TEXT NOT NULL, actor_id TEXT NOT NULL, session_key TEXT NOT NULL,
  source_hash TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('running','pending','finished','failed','cancelled','interrupted')),
  visited TEXT NOT NULL, hop_limit INTEGER NOT NULL CHECK(hop_limit BETWEEN 1 AND 8),
  mutation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,source_message_id,initial_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_hx_agent_assignments_source ON hx_agent_assignments(org_id,source_message_id);
CREATE TABLE IF NOT EXISTS hx_agent_handoffs (
  org_id TEXT NOT NULL, operation_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL, source_agent_id TEXT NOT NULL, target_agent_id TEXT NOT NULL,
  brief TEXT NOT NULL, message_body TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,operation_id), UNIQUE(assignment_id,source_generation)
);
CREATE TABLE IF NOT EXISTS hx_agent_handoff_dispatch (
  org_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
  lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY(org_id,operation_id)
);
CREATE INDEX IF NOT EXISTS idx_hx_agent_handoff_dispatch_due ON hx_agent_handoff_dispatch(status,next_attempt,lease_until);
