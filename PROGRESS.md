# Progress Checklist

Last updated: 2026-08-06

## Overall

- Current phase: Phase 7 — production backend (`backend/`) built; iOS migration pending
- Core flow working: yes
- GitHub sync working: yes (OAuth + Issues API)
- Realtime sync working: yes (localhost WebSocket relay)
- AI routing: OpenRouter via relay server with keyword fallback

## GitHub OAuth

- [x] ASWebAuthenticationSession in iOS
- [x] `tiktokforwork://oauth/callback` URL scheme
- [x] Localhost `/oauth/github/config` + `/oauth/github/token`
- [x] Client secret stays on server only
- [x] Repository picker after OAuth
- [x] PAT flow removed

## Phase 5 — Realtime

- [x] WebSocket relay server (`server/`)
- [x] WebSocketService client
- [x] Cross-client card sync
- [x] Snapshot on join
- [x] Local fallback if relay unavailable

## Phase 6 — Polish + Ship

- [x] Clean flat design
- [x] Org graph UI
- [x] Agent route on cards
- [x] AIService (OpenRouter via relay)
- [ ] TestFlight or installable build

## Phase 7 — Production backend (cross-platform foundation)

- [x] Schema-first protocol package (`@honmaru/protocol`, zod)
- [x] TypeScript server (`@honmaru/server`): Hono REST + WebSocket hub
- [x] SQLite persistence (WAL) + per-org event log with cursor resume
- [x] Session auth (GitHub OAuth exchange + hashed tokens + dev login)
- [x] Multi-org: create/invite/accept, admin roles, org graph CRUD
- [x] Server-side routing (org-data-driven, no hardcoded users)
- [x] Card state machine server-side (approve/reject/revise/delegate/complete/delete)
- [x] Pluggable integration layer; GitHub Issues as first adapter
- [x] 25 unit/API tests + WS end-to-end smoke script
- [x] Rally layer: card threads (`card_message`) for high-frequency exchange
- [x] Two-phase AI pipeline: instant local routing + async LLM refinement/re-route
- [x] Notifications: unread inbox + WS frames + webhook bridge + device registry
- [x] Analytics: decision latency, bottleneck ranking, AI-scored feed order
- [x] Web client (React/TS) on `@honmaru/protocol` (`backend/packages/web`)
- [x] Quick replies in threads (1-tap rally)
- [x] SLA deadlines + overdue escalation to manager (sweeper + `card_overdue`)
- [x] Browser E2E: 2 Chromium sessions through org setup → instruction → rally → approval
- [x] Agent memory (context layer): decision observations → prompt injection → LLM condensation + `/v1/orgs/:id/memory`
- [x] iOS client migrated to protocol v1 (token auth, org create/join, server-side actions; AIService/GitHubService removed — needs an Xcode build to verify, no Swift toolchain in CI yet)
- [x] iOS: thread rally UI (card detail sheet with quick replies) + notification inbox with unread badge
- [x] Deploy-ready: Dockerfile + fly.toml example + server serves the built web client (single image)
- [x] @Mentions + watchers: `@Name` in a thread pulls the member into the card (visibility + card_mention notification); 35 server tests
- [x] Web UI overhaul: Slack-style 3-pane layout (sidebar views + members / compact card list / right thread panel), light-first theme with OS dark, mention highlighting + one-tap mention chips
- [ ] Run `fly deploy` (needs an account) + GitHub webhook reverse sync
- [ ] iOS: mentions UI + light theme pass (server-side mentions already work for iOS users via notifications)

## Demo script

1. `cd server && cp .env.example .env` → add GitHub OAuth credentials → `npm start`
2. iOS → **Sign in with GitHub** → pick repo → Continue as Alice
3. Second simulator as Bob (same relay URL)
4. Alice → Message your AI → instruction
5. Bob sees card (green dot = connected)
6. Bob approves → GitHub Issue → Alice gets result

## Mocked vs Real

| Area | Status | Notes |
|------|--------|-------|
| AI routing | Real + fallback | OpenRouter if `OPENROUTER_API_KEY` set |
| Multi-user | Real | localhost WebSocket |
| Org graph | Real UI | Demo org data |
| GitHub auth | Real OAuth | Token exchange on localhost |
| GitHub sync | Real | Issues create/update |
| Backend host | localhost only | `127.0.0.1:8080` |
