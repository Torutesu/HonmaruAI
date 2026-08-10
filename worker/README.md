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
| POST | `/ai/route` | Instruction → intent, recipient, Decision Card (OpenAI, keyword fallback) |
| GET | `/oauth/github/config` | Client id + scope + redirect for the app |
| POST | `/oauth/github/token` | OAuth `code` → GitHub token (server-side) + app session |
| GET | `/orgs/:owner/:repo/graph` | Build the org graph from repo collaborators (auth: `x-session-token`); persists users/memberships/agents to D1 |
| — | `Upgrade: websocket` | Forwarded to the org's `OrgRelay` Durable Object |

WebSocket messages (AG-UI over `join {protocol:"agui/1"}`): `join`, `tool_result`,
`card_created`, `card_updated`, `card_deleted`, `context_updated`, `rollback`,
`clear_store`. A `join` may carry `sessionToken`; when present the relay binds the
connection to the session's real GitHub login instead of the (spoofable) `userId`.

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

```bash
npm install
npm test          # 11 tests under @cloudflare/vitest-pool-workers (real workerd)
npm run dev       # local wrangler dev
```

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

### Auth configs (project-level, reused by every user)

- Gmail: `ac_XcSzdgFl91Ds`
- Slack: `ac_qv8jozIjt29D`

One auth config per toolkit; each user gets their own connected account beneath
it, keyed by the Composio `user_id` we pass (the caller's numeric GitHub id).
