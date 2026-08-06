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

## Run

1. `cd server && cp .env.example .env` → add GitHub OAuth credentials → `npm start`
2. iOS → **Sign in with GitHub** → pick repo → pick who you are → Continue
3. Second device/simulator as another member (same relay URL)
4. Sender → Tell your AI → instruction
5. Recipient sees the card (green dot = connected)
6. Recipient approves → GitHub Issue → sender gets the result

## Organization

- [x] Roster owned by the relay, seeded with Toru (CEO) and Gota (PM)
- [x] Add member from the app (name, role, GitHub username, reports-to)
- [x] Roster broadcast to every connected client
- [x] AI routing built from the live roster — new members routable immediately
- [x] Org graph derived from the roster instead of a hand-maintained list
- [ ] Roster persistence across relay restarts (in memory today)

## Status

| Area | State | Notes |
|------|-------|-------|
| AI routing | Real + fallback | OpenRouter if `OPENROUTER_API_KEY` set |
| Multi-user | Real | localhost WebSocket |
| Organization | Real | Live roster, add member, derived org graph |
| GitHub auth | Real OAuth | Token exchange on localhost |
| GitHub sync | Real | Issues create/update |
| Backend host | localhost only | `127.0.0.1:8080` |
| UI / design system | Mockup stage | Visual layer is provisional — see the handoff docs |
