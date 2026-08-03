# Progress Checklist

Last updated: 2026-07-27

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

## Phase 7 — Monetization (RevenueCat)

- [x] `purchases-ios-spm` (RevenueCat + RevenueCatUI) via SPM
- [x] SDK configured at launch, app user aliased to the signed-in user
- [x] `honmaruai Pro` entitlement checked via `customerInfoStream`
- [x] Hosted paywall (`PaywallView`) + native fallback
- [x] Customer Center for cancel / refund / plan change
- [x] Free tier: 3 AI routes/day; org graph is Pro-only
- [ ] Production `appl_…` key + App Store Connect products
- [ ] RevenueCat webhooks → relay server for server-side entitlement checks

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
