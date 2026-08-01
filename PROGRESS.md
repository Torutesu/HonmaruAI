# Progress Checklist

Last updated: 2026-08-01

## Overall

- Current phase: Phase 7 — 3-second value + onboarding rework done
- Core flow working: yes
- GitHub sync working: yes (OAuth + Issues API, now contextual/optional)
- Realtime sync working: yes (localhost WebSocket relay, optional for single simulator)
- AI routing: OpenRouter via relay server with keyword fallback

## Phase 7 — 3-second value + onboarding (see onboarding.md)

- [x] Auth wall removed: one-tap persona entry (`OnboardingView`)
- [x] Seeded first-session feed per persona, staggered arrival + triage note
- [x] Local-first approve/delegate (works without GitHub)
- [x] Contextual GitHub connect sheet (post-first-approval, chip, menu)
- [x] Session restore without GitHub; sign-out resets first-run flags
- [x] Empty relay snapshot merges with local seeds instead of wiping

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

1. (Optional for realtime/GitHub) `cd server && cp .env.example .env` → add credentials → `npm start`
2. iOS → **Continue as Alice** → seeded decisions stream in → swipe right to approve
3. After first approval → **Connect GitHub** sheet → OAuth → pick repo
4. Second simulator as Bob (same relay URL)
5. Alice → Message your AI → instruction
6. Bob sees card (green dot = connected)
7. Bob approves → GitHub Issue → Alice gets result

## Mocked vs Real

| Area | Status | Notes |
|------|--------|-------|
| AI routing | Real + fallback | OpenRouter if `OPENROUTER_API_KEY` set |
| Multi-user | Real | localhost WebSocket |
| Org graph | Real UI | Demo org data |
| GitHub auth | Real OAuth | Token exchange on localhost |
| GitHub sync | Real | Issues create/update |
| Backend host | localhost only | `127.0.0.1:8080` |
