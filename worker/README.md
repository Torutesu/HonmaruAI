# TikTok for Work — Cloudflare backend

Real-time relay + AI routing + GitHub OAuth for the iOS app, on Cloudflare
Workers + Durable Objects + D1. Ported from the old localhost Node relay
(`../server/`); the AG-UI core and AI routing logic are reused verbatim.

## Deployed

- Base URL: `https://tiktokforwork.torubj0904.workers.dev`
- WebSocket (per org): `wss://tiktokforwork.torubj0904.workers.dev/?orgId=<repo-full-name>`
- D1 database: `tiktokforwork` (`08d78a7f-45eb-4837-8393-4f7c92bf39cb`, APAC)

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Readiness + which AI/GitHub features are configured |
| GET | `/agui/tools` | AG-UI tool manifest |
| POST | `/auth/signup` | Email/password account → session, relay login, workspace; optional invite code |
| POST | `/auth/login` | Email/password → session, relay login, earliest current workspace (`orgId`) |
| GET | `/members?orgId=` | Current workspace members `{id,name,role,avatarUrl?}` for email or GitHub sessions |
| POST | `/ai/route` | Instruction → draft card; optional validated `recipientUserID` preserves an explicit choice |
| GET | `/oauth/github/config` | Client id + scope + redirect for the app |
| GET | `/oauth/github/state` | Mint a single-use, 10-minute nonce for the authorize URL |
| POST | `/oauth/github/token` | OAuth `code` + `state` → GitHub token (server-side) + app session |
| POST | `/devices` | Register an APNs token (auth: `x-session-token`) |
| DELETE | `/devices` | Forget one, on sign-out |
| GET | `/me` | Login, locale, email preference (auth: `x-session-token`) |
| PUT | `/me` | `{ locale?, notifyEmail? }` — the language every notification is written in |
| GET | `/push/vapid` | Web Push public key; 503 until `VAPID_*` are set |
| POST | `/push/subscriptions` | Register a browser's `PushSubscription` (auth: `x-session-token`) |
| DELETE | `/push/subscriptions` | Forget one, on sign-out |
| GET/POST/DELETE | `/businesses` | The org's businesses — [docs/businesses.md](../docs/businesses.md) |
| GET | `/record?orgId=` | Every decision, per business; `&format=md` for Markdown — [docs/record.md](../docs/record.md) |
| DELETE | `/account` | Erase the caller's account (auth: `x-session-token`) |
| GET | `/orgs/:owner/:repo/graph` | Build the org graph from repo collaborators (auth: `x-session-token`); persists users/memberships/agents to D1 |
| — | `Upgrade: websocket` | Forwarded to the org's `OrgRelay` Durable Object |

WebSocket messages (AG-UI over `join {protocol:"agui/1"}`): `join`, `tool_result`,
`card_created`, `card_updated`, `card_deleted`, `context_updated`, `rollback`,
`nudge`, `set_business`.

The member directory requires `x-session-token` and current membership in the
requested workspace. Its `id` is the relay login used by cards, not a display
name; existing email-account logins contain their sign-in address. No separate
private notification address, account id, or credential is returned.

For an explicit draft recipient, send `recipientUserID` with `orgId` (or
`organization.orgId`) to `/ai/route`. The caller and recipient must both belong
to that workspace. Invalid selections return 400, missing sessions 401, and
unrelated workspace access 403. Both model drafting and keyword fallback keep
the selected recipient; `routedBy` still identifies the drafting method.
Routing returns a draft only: the client reviews it before `card_created`.
Without an explicit recipient, automatic routing retains its existing behavior.

Login adds `orgId` without changing `token`, `userId`, or `login`. Accounts with
several memberships get the earliest current one; accounts whose memberships
were removed still receive a session, with `orgId: null`, so they can redeem an
invite through `/invites/accept` instead of silently regaining access.

### The relay's access rules

The socket holds every decision an organization has made, so none of these are
negotiable:

- **`join` requires `sessionToken`.** No token, or a token whose session cannot
  prove write access to `orgId`, and the relay sends an error and closes with
  1008. There is no anonymous read.
- **Opening a socket grants no read access.** Broadcasts and recipient prompts
  require a completed authenticated join. Each subsequent read and mutation
  checks the current session and D1 membership; expired/deleted sessions and
  removed memberships are refused. Sockets hibernating across this release
  reconnect with 1012 to establish the new attachment format.
- **Identity is never taken from the client.** `payload.userId` is read only to
  be discarded; you act as the login on your session.
- **Membership** is a `memberships` row, or — when there is none yet, because
  the client connects before it loads the org graph — GitHub asked directly.
  Write access is what counts: a public repository hands `pull` to the entire
  internet, and `GET /repos` cannot tell a read-only collaborator from a
  stranger.
- **A created card is stamped with the sender the session proves.** You may
  route to anyone in the org, only ever as yourself.
- **Creation cannot overwrite an existing decision.** Concurrent creates of
  the same ID store one card. Updates preserve the original sender and creation
  time and refuse deleted or concurrently changed cards.
- **Only the recipient** can decide, delete or undo a card, and a decision is
  attributed to whoever made it. Delegation is a new card, not a moved one.
- **`clear_store` does nothing.** It used to run `DELETE FROM cards` for the
  whole org, and the app sent it on every sign-out. It survives as a no-op so
  builds that still send it do not fail.
- **Delayed AI enrichment cannot undo a decision.** Translation and filing
  merge their fields atomically into a surviving card with matching source
  text. They cannot restore deleted cards or replace a newer approval.

These checks use the membership table; a GitHub permission change takes effect
after membership refresh removes the row. Client sign-out currently clears the
client's credentials and does not revoke its server session. WebSocket delivery
also has no durable per-message acknowledgement yet: a successful transport send
is not proof of persistence.

Rate limits (fixed windows in D1, keyed by session where there is one and by IP
where there is not; fails open): `/ai/route` 30/5min, `/oauth/github/token`
10/5min, `/connectors/*/sync` 6/5min, `/media` 20/hour.

### Scheduled

`crons = ["*/15 * * * *"]` syncs connectors for users who have a session, an org
and a configured connector, pushes anything new, and sweeps expired nonces and
stale rate-limit rows. Metered by the same per-message allowance a manual sync
uses.

### Phase 2 status (real identity & org)

Live-verified: `/health` 200, `/orgs/:owner/:repo/graph` returns 401 without a
valid session (auth guard), and `/ai/route` routes to real org members — an
invalid recipient guessed by the model is rejected and falls back to a real
member (`routingError: "AI picked an invalid recipient."`, `routedBy:"fallback"`).

Deferred: end-to-end `/orgs` against real GitHub needs the `GITHUB_CLIENT_ID`/
`GITHUB_CLIENT_SECRET` secrets (a valid session comes from OAuth). Unit tests
cover the build+persist logic via `fetchMock`.

Phase 3 follow-up: the OpenAI `SYSTEM_PROMPT` still references demo members, so
the model may guess a demo id (caught by the validator and corrected via
fallback). Feed the real org members into the prompt so OpenAI picks them
directly.

## Develop

Use Node 20.19+ or 22.12+. The pinned test toolchain is Vitest 3.2.6,
Cloudflare's Workers pool 0.12.21, and Wrangler 4.72.0. The pool's matching
Miniflare/workerd versions are recorded in `package-lock.json`.

```bash
npm ci --no-audit
npm test          # under @cloudflare/vitest-pool-workers (local workerd + D1)
npm run dev       # local wrangler dev
```

Vitest 3.2.6 includes the fix for
[GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp).
Wrangler 4.72.0 also replaces the older pool's embedded Wrangler 3.100.0 and
includes the fix for
[GHSA-36p8-mvp6-cv38](https://github.com/cloudflare/workers-sdk/security/advisories/GHSA-36p8-mvp6-cv38).
The Workers pool remains on the last release series compatible with Vitest 3
to preserve the existing per-test storage isolation and `fetchMock` coverage.
[Cloudflare's Vitest 4 migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)
changes those APIs and requires a separate test migration. These are targeted
advisory fixes, not a claim that every transitive dependency has been audited.

## Deploy / operate

```bash
npx wrangler deploy
npx wrangler d1 execute tiktokforwork --remote --file=./schema.sql   # apply schema
npx wrangler secret put OPENAI_API_KEY        # set / rotate
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler tail                              # live logs
```

### Secrets

| Secret | Status | Notes |
|--------|--------|-------|
| `OPENAI_API_KEY` | set | Enables OpenAI routing (`gpt-4o-mini`); without it, keyword fallback |
| `GITHUB_CLIENT_ID` | pending | From a GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | pending | Stays server-side; never returned to the client |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | pending | Web Push. `node scripts/vapid-keys.mjs` prints a pair — [docs/notifications.md](../docs/notifications.md) |
| `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` | pending | Email, the floor when no push reaches someone. `NOTIFY_EMAIL_FROM`, `MAILGUN_API_BASE`, `APP_WEB_URL` optional |

GitHub OAuth App: callback `tiktokforwork://oauth/callback`, homepage the base
URL above.

Optional env: `OPENAI_MODEL`, `GITHUB_REDIRECT_URI`, `GITHUB_OAUTH_SCOPE`
(default `repo`), `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` (dev fallback).

## Composio (Gmail connector)

Verified live on 2026-08-10. The Worker talks to Composio over plain HTTPS; the
`composio` CLI is not usable from a deployed Worker (it authenticates with a
`composio login` session, not an API key).

| | |
|---|---|
| Base URL | `https://backend.composio.dev/api/v3` |
| Auth header | `x-api-key` |
| Key format | **`ak_…` (Project API key)**. Keys starting `ck_` are rejected 401 — they are not REST API keys. |
| Secret name | `COMPOSIO_API_KEY` |

**The key and the connection must live in the same Composio project.** A valid key
pointed at a project with no connection returns 200 with zero connected accounts,
which looks like success and behaves like failure.

### Connecting an account (this is how the in-app connect flow will work)

```
POST /v3/auth_configs
  { "toolkit": { "slug": "gmail" },
    "auth_config": { "type": "use_composio_managed_auth" } }
→ 201 { "auth_config": { "id": "ac_…" } }

POST /v3/connected_accounts/link
  { "user_id": "<our id for the person>", "auth_config_id": "ac_…" }
→ 201 { "redirect_url": "https://connect.composio.dev/link/lk_…",
        "connected_account_id": "ca_…", "expires_at": "…" }
```
The user opens `redirect_url`, authorizes, and the connection becomes ACTIVE under
that `user_id`. (`initiate()` is retired for Composio-managed OAuth since
2026-07-03; `link` is its replacement.)

Current state: auth config `ac_XcSzdgFl91Ds`, connection `ca_rISpkV_xpRVj`,
`user_id` **`honmaru-default`**, status ACTIVE. That `user_id` is what
`COMPOSIO_USER_ID` must be set to until per-user connections exist.

### Reading mail

```
POST /v3/tools/execute/GMAIL_FETCH_EMAILS
  { "user_id": "honmaru-default",
    "arguments": { "query": "newer_than:7d", "max_results": 10,
                   "verbose": false, "include_payload": false } }
```

Response (verified):

```
{ "successful": true, "error": null, "log_id": "…",
  "data": { "messages": [ … ], "nextPageToken": "…", "resultSizeEstimate": N } }
```

A message carries: `messageId`, `threadId`, `sender`, `to`, `subject`,
`messageTimestamp`, `labelIds`, `preview: { body, subject }`, plus
`messageText`/`payload`/`attachmentList` when verbose.

Composio's documented traps, all still worth coding against: the payload is
sometimes wrapped as `results[i].response.data.messages`; an empty `messages`
array is a valid no-matches result, not an error; and `verbose:true` /
`include_payload:true` can trigger 413 or truncation.

### Slack (verified 2026-08-10)

```
POST /v3/tools/execute/SLACK_SEARCH_MESSAGES
  { "user_id": "<per-user id>",
    "arguments": { "query": "to:me after:2026-08-03", "count": 10,
                   "sort": "timestamp", "sort_dir": "desc" } }
```

`to:me` is the modifier that means "addressed to or mentioning me" — confirmed
working; the tool's own docs list only `in:`/`from:`/`has:`, so this was pinned by
calling it rather than read from documentation.

Response: `{ successful: true, data: { ok, query, messages: { matches: [ … ] } } }`
— note the matches are nested under `messages.matches`, not `messages`.

A match carries: `text`, `username`, `user`, `channel`, `ts`, `permalink`, `iid`,
`team`, `score`, `attachments`.

Use **`permalink`** as the dedup `external_id`: it encodes channel + timestamp and
is stable. `iid` is a per-search result id and must not be trusted across calls.

### Notion (verified 2026-08-10)

Notion is the first **bidirectional** connector. Everything below was pinned by
running the tools live via the `composio` CLI against an ACTIVE Notion
connection — the same tool slugs and response shapes the Worker will see over
REST. Each area is tagged with how it was confirmed.

**Response nesting differs per tool.** `SEARCH`, `FETCH_DATABASE`,
`QUERY_DATABASE_WITH_FILTER` and `INSERT_ROW_DATABASE` all return their payload
directly under `data`. But `NOTION_LIST_USERS` nests it under
`data.response_data` — the same `results[i].response.…` wrapping trap the Gmail
section warns about. Parse defensively per tool.

#### Listing databases — `NOTION_SEARCH_NOTION_PAGE` — verified with a real call

```
POST /v3/tools/execute/NOTION_SEARCH_NOTION_PAGE
  { "user_id": "<per-user id>",
    "arguments": { "query": "", "page_size": 25,
                   "filter_value": "database", "filter_property": "object" } }
```

Response: `{ successful: true, data: { results: [ … ], has_more, next_cursor } }`.

Each result is a **database object**. For the picker we need two fields:

- **id** → `results[i].id` (a UUID).
- **human-readable title** → `results[i].title` — this is a **rich-text array,
  NOT a plain string**. The label is `results[i].title[].plain_text` joined
  (usually one segment). Do not read it off `properties`.

`filter_value:"database"` returns only databases (pages are excluded). An empty
`results` array is a valid "nothing shared with the integration" result, not an
error — Composio's own pitfalls list flags this. Only databases explicitly
shared with the Notion integration appear; in this test project exactly one did.

#### Reading one database's schema — `NOTION_FETCH_DATABASE` — verified with a real call

```
POST /v3/tools/execute/NOTION_FETCH_DATABASE
  { "user_id": "<id>", "arguments": { "database_id": "<uuid>" } }
```

Response `data` carries `title` (same rich-text array as above) and
`properties`: a **map keyed by property name**, each value
`{ id, name, type, <type-specific config> }`.

**Identifying the title property (the write target):** find the property whose
`type === "title"`. Every database has exactly one. Its Notion `id` is the
literal string `"title"` (not the property's display name — that name is
user-defined, e.g. `"Name"`). Match on `type`, not on name.

#### Inserting a row — `NOTION_INSERT_ROW_DATABASE` — VERIFIED by creating a real test row

This confirms the design doc's central bet: **writing only the title property
plus body content works on an arbitrary user schema.** A real row was created in
a test database whose columns we do not control, targeting only the title.

```
POST /v3/tools/execute/NOTION_INSERT_ROW_DATABASE
  { "user_id": "<id>",
    "arguments": {
      "database_id": "<uuid>",
      "properties": [
        { "name": "<title prop display name>", "type": "title", "value": "<card title>" }
      ],
      "child_blocks": [
        { "block_property": "heading_2", "content": "Summary" },
        { "block_property": "paragraph", "content": "…decision, who, when, source…" }
      ]
    } }
```

- `properties` is a **LIST of `{ name, type, value }` objects** (not a map). For
  the title-only write, one object with `type: "title"` and `name` = the title
  property's display name. `value` is a literal string (title/rich_text take
  plain text; select is a single option name; multi_select is comma-separated;
  date is ISO 8601; people wants comma-separated user UUIDs — see the tool
  schema's `value` description for the full per-type encoding).
- Body content is `child_blocks`: a list where each block is
  `{ block_property, content }`. `block_property` is the block type
  (`paragraph`, `heading_1/2/3`, `bulleted_list_item`, `quote`, `divider`, …);
  `content` supports inline markdown (`**bold**`, `[text](url)`). This is where
  summary / decision / actor / timestamp / source link go.

Response `data` is the created **page** object: the new row's id is `data.id`
(the same UUID a later query returns — usable as the dedup key immediately).

#### Querying rows with a filter — `NOTION_QUERY_DATABASE_WITH_FILTER` — verified with a real call

```
POST /v3/tools/execute/NOTION_QUERY_DATABASE_WITH_FILTER
  { "user_id": "<id>",
    "arguments": {
      "database_id": "<uuid>", "page_size": 100,
      "filter": { "property": "<prop name>", "<filter_type>": { "<condition>": <value> } }
    } }
```

Filter shape: `{ "property": "<name>", "<filter_type>": { "<condition>": <value> } }`
where `filter_type` matches the property's schema type
(`title`, `rich_text`, `select`, `status`, `date`, `people`, `checkbox`, …) and
must be exactly one key. Compound: `{ "and": [ … ] }` / `{ "or": [ … ] }`.
Select/status/multi_select option names are **case-sensitive** and must match
the schema exactly. `title` as a filter key always means the built-in title
column. (Round-tripped live: filtered on the title property and got the row back.)

Response: `{ successful: true, data: { results: [ … ], has_more, next_cursor } }`.
Each row is a **page object**:

- **page id (dedup key)** → `results[i].id`. Verified equal to the `data.id`
  returned by the insert above.
- **title** → `results[i].properties.<titleName>.title[].plain_text` (locate
  `<titleName>` the same way: the property whose `type === "title"`).
- Also present: `url`, `created_time`, `last_edited_time`, `parent`.

Paginate via `has_more` / `next_cursor` (pass the exact cursor string back as
`start_cursor`; non-UUID cursors may be rejected — a documented pitfall).

#### "Assigned to me" — CONCERN, contradicts the design doc's inbound assumption

The design doc's inbound ("rows assigned to that user arrive as cards") assumes
an "assigned to me" filter exists. **It is unreliable and schema-dependent —
treat this as a finding, not a solved problem:**

1. **There is no guaranteed assignee column.** "Assigned to me" requires a
   `people`-type property, which is arbitrary per database — the test database
   had **none**. A decisions database created by our own onboarding could add
   one, but a database the user picks may not have it, and its name is unknown.
   The `title`-only write bet holds precisely because assignee mapping does not.
2. **There is no clean "who am I".** `NOTION_GET_ABOUT_USER` is a *retrieve user
   by id* call — it **requires** a `user_id` and is not a "current user"
   endpoint. The integration authenticates as a **bot**, so there is no built-in
   human "me". Resolving "me" means listing users
   (`NOTION_LIST_USERS`, nested under `data.response_data.results`), picking the
   `type: "person"` entry, and taking its `id` — brittle when a workspace has
   more than one person.

Recommended path until real usage proves otherwise: for inbound, query the
configured database and run **every** row through the existing triage (the
design doc already says being in a database does not make something a decision),
rather than pre-filtering by an assignee that may not exist. If an assignee
filter is added later, resolve the person UUID once, confirm the target database
actually has a `people` property, and filter with
`{ "property": "<people prop>", "people": { "contains": "<user-uuid>" } }`.

### Auth configs (project-level, reused by every user)

- Gmail: `ac_XcSzdgFl91Ds`
- Slack: `ac_qv8jozIjt29D`
- Notion: `ac_qtoaZ6G__JEd`

One auth config per toolkit; each user gets their own connected account beneath
it, keyed by the Composio `user_id` we pass (the caller's numeric GitHub id).
