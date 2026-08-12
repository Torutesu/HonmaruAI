# Progress Checklist

Last updated: 2026-08-01

## Overall

- Current phase: Phase 7 — 3-second value + onboarding rework done
- Core flow working: yes
- GitHub sync working: yes (OAuth + Issues API, now contextual/optional)
- Realtime sync working: yes (localhost WebSocket relay, optional for single simulator)
- AI routing: OpenRouter via relay server with keyword fallback

## Phase 8 — AG-UI protocol adoption (see docs/agui-protocol.md)

- [x] `request_decision` / `submit_decision` schemas (`server/agui/tools.js`, `GET /agui/tools`)
- [x] Relay speaks AG-UI events behind `join {protocol: "agui/1"}`; legacy dialect intact
- [x] `npm test` in `server/`: 8 tests incl. dual-dialect integration
- [x] iOS inbound decoder (`AGUIEventAssembler`) + `WebSocketService` joins as `agui/1` with legacy fallback
- [x] Context sync: `context_updated` → `STATE_DELTA /context/{userId}`; in snapshots for late joiners
- [x] Rollback: `rollback {cardId}` → pending + `CUSTOM decision_rolled_back` (legacy gets `card_updated`)
- [x] Reference web client (`web/index.html`) served at relay `GET /` — inbox, decisions, context editor, live event stream
- [x] `npm test`: 10 tests (unit + 2 multi-client integration + HTTP)
- [x] iOS outbound `tool_result`: `DecisionCard.decision`, `WebSocketService.publishToolResult`,
      `DecisionCardService.resolve/delegate` now send `tool_result` (not legacy `card_updated`) with
      the `toolCallId` from the original `request_decision`
- [x] Standalone React reference client in `web-react/` (Vite + TS, separate from `web/` so it doesn't
      collide with the single-file demo the relay serves at `GET /`) speaking the same protocol —
      `npm run build` type-checks clean; verified the dev server actually serves this app, not `web/index.html`
- [ ] Production web via CopilotKit

## Phase 9 — Email connector (PoC, legacy `server/` relay only)

- [x] `server/connectors/email.js`: parses raw RFC822 email (`mailparser`), validates Mailgun webhook
      HMAC signatures (forged signatures rejected, requests with no signature fields treated as local/test)
- [x] `server/connectors/email-triage.js`: keyword-based (no LLM) classifier — decides whether an email
      needs a decision card; explicit negative patterns (`fyi`, `no action needed`, etc.) checked first
- [x] `server/connectors/email-handler.js`: builds a `DecisionCard`-shaped card (`id`, `recipientUserID`,
      `sourceApp: "Email"`, `sourceDetail: <sender>`) from a parsed email
- [x] `POST /webhooks/email` in `server/index.js`: receives the email, runs it through triage, and — if
      it's a decision — upserts the card into the live store and broadcasts it over WebSocket
- [x] `server/test/email.test.mjs`: unit tests (parser/triage/signature) + one integration test that spawns
      the relay and asserts a POSTed email produces a real `card_created` broadcast
- [ ] Real recipient routing (currently routes every email to the first user in the org's store — no `To:`
      address lookup against org membership)
- [ ] Actual Mailgun account wired up (signature validation is implemented and tested, but nothing has
      received a real inbound email yet — only synthetic POSTs shaped like Mailgun's)
- [ ] Dedup by `Message-ID` (sending the same email twice currently creates two cards)
- [ ] Port to `worker/` (production Cloudflare backend) — this connector lives in the legacy `server/`
      relay alongside the Gmail/Slack/Notion connectors' actual home in `worker/src/connectors/`

## Phase 7 — 3-second value + onboarding (see onboarding.md)

- [x] Five-screen guided onboarding: welcome → how it works → interactive swipe demo → GitHub sign-in (skippable) → persona
- [x] Auth wall removed: GitHub moved to step 4 of onboarding, after value is shown
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
2. iOS → onboarding: pitch → routing → swipe the demo card → **Sign in with GitHub** (or skip) → **Continue as Alice** → seeded decisions stream in → swipe right to approve
3. If GitHub was skipped: after first approval → **Connect GitHub** sheet → OAuth → pick repo
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
