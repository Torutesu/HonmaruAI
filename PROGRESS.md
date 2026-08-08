# Progress Checklist

Last updated: 2026-08-08

## Overall

- Current phase: Phase 5 complete, GitHub OAuth done
- Core flow working: yes
- GitHub sync working: yes (OAuth + Issues API)
- Realtime sync working: yes (localhost WebSocket relay)
- AI routing: OpenRouter via relay server with keyword fallback

## GitHub OAuth

- [x] ASWebAuthenticationSession in iOS
- [x] `honmaruai://oauth/callback` URL scheme
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
- [x] Release tooling — `asc` CLI pipeline (`scripts/release.sh`, [docs](docs/app-store-release.md))
- [x] Rebrand to Honmaru AI (`com.honmaru.ai`, `honmaruai://`)
- [x] App icon flattened to RGB — App Store rejects any alpha channel
- [ ] TestFlight or installable build — tooling ready, needs a real API key + `ASC_APP_ID`

## App Store submission blockers

TestFlight **internal** testing needs none of these — it skips Beta App Review,
so a build can go to a device today. All of them block App Store review.

- [ ] **Relay server must be hosted.** `AppConfig.relayURL` is `ws://127.0.0.1:8080`;
      on a device that is the phone itself. Deploy `server/` and switch to `wss://`.
      Without it the reviewer cannot sign in at all → Guideline 2.1 (App Completeness).
- [ ] **Reviewer demo account.** Sign-in is GitHub OAuth only. App Review
      Information needs working credentials or the review stops at the auth screen.
- [ ] Screenshots — 6.9" and 6.5" iPhone are mandatory
- [ ] Privacy policy URL — required because the app handles GitHub tokens
- [ ] App Privacy disclosure — GitHub account data, and user text sent to OpenRouter
- [ ] Export compliance answer

`scripts/release.sh doctor` runs `asc review doctor`, which catches most of the
metadata-side items before a submission is spent.

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
