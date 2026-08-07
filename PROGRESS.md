# Progress Checklist

Last updated: 2026-08-07

## Phase 7 — Designer IA build (33 screens)

- [x] Onboarding flow (11 screens): intro ×4, connect AI, tools intro, GitHub OAuth, Slack, Notion/Gmail/Calendar, context build, ready
- [x] Main tab navigation: Feed / Assistant / Org / Tools / Settings
- [x] Feed shows pending cards only; `Later` action snoozes a card to the end
- [x] History screen (resolved decisions, grouped by day, GitHub links)
- [x] AI Assistant tab: assistant home, "What your AI knows", agent activity log
- [x] Organization tab: Teams / People / AI Agents / Org graph
- [x] Integrations tab: GitHub live, Slack/Notion/Gmail/Calendar simulated
- [x] Settings: Profile, Context, Billing, Security, Language
- [x] App display name → Honmaru AI
- [x] Xcode project updated (also regenerable via `xcodegen generate`)

## Overall

- Current phase: Phase 5 complete, GitHub OAuth done
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
