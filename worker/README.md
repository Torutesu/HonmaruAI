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
| — | `Upgrade: websocket` | Forwarded to the org's `OrgRelay` Durable Object |

WebSocket messages (AG-UI over `join {protocol:"agui/1"}`): `join`, `tool_result`,
`card_created`, `card_updated`, `card_deleted`, `context_updated`, `rollback`,
`clear_store`.

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
