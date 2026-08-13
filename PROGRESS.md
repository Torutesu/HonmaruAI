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
      the `toolCallId` from the original `request_decision`, plus the GitHub sync fields
      (`githubIssueNumber/URL/Repository`) since `tool_result` doesn't carry the whole card
- [x] `agui/tools.js` `DECISION_ACTIONS`/`ACTION_STATUS` now include `revised`/`delegate` — a code-review
      catch: they were missing entirely, so revision/delegation actions silently left the server's copy
      of the card at `status: "pending"` after the `tool_result` migration above. `applyDecision` also now
      re-applies `revisionNote`/`context` and the GitHub fields carried on `content`, since `tool_result`
      only carries the decision, not the whole card. Regression test in `server/test/agui.test.mjs`.
- [x] Standalone React reference client in `web-react/` (Vite + TS, separate from `web/` so it doesn't
      collide with the single-file demo the relay serves at `GET /`) speaking the same protocol —
      `npm run build` type-checks clean; verified the dev server actually serves this app, not `web/index.html`
- [ ] Production web via CopilotKit

## Phase 9 — Email connector (PoC, legacy `server/` relay only)

- [x] `server/connectors/email.js`: parses raw RFC822 email (`mailparser`), validates Mailgun webhook
      HMAC signatures with `crypto.timingSafeEqual`, timestamp freshness (±15 min), and single-use token
      replay protection. **Fails closed by default** — a request with no signature fields, or a missing
      `MAILGUN_WEBHOOK_SIGNING_KEY`, is rejected (401) unless `ALLOW_UNSIGNED_EMAIL_WEBHOOK=1` is set
      explicitly. (Code review caught this: it originally defaulted to *allowing* unsigned requests, which
      meant anyone who knew the webhook URL could broadcast an approval card as anyone. Never set
      `ALLOW_UNSIGNED_EMAIL_WEBHOOK` in production.)
- [x] `server/connectors/email-triage.js`: keyword-based (no LLM) classifier — decides whether an email
      needs a decision card; negative patterns (`fyi`, `no action needed`, etc.) and decision patterns are
      matched only against content *before* the first quoted-reply marker (`stripQuotedReplies`), so a
      phrase from earlier in a thread can't suppress or trigger classification of the new message
- [x] `server/connectors/email-handler.js`: builds a `DecisionCard`-shaped card (`id`, `recipientUserID`,
      `sourceApp: "Email"`, `sourceDetail: <sender>`) from a parsed email
- [x] `server/connectors/email-dedup.js`: skips redelivered emails by `parseEmailMessage`'s content hash
      (per-org, 24h in-memory TTL) — same `Message-ID` twice no longer creates two cards
- [x] `POST /webhooks/email` in `server/index.js`: multipart/form-data (real Mailgun with attachments),
      urlencoded, and JSON bodies all supported; non-multipart bodies capped at 5 MiB
      (`EMAIL_WEBHOOK_MAX_BODY_BYTES`); failures after the early `200` response (Mailgun requires a fast
      ack) are counted in `emailWebhookStats`, visible on `GET /health`, since there's no retry queue to
      otherwise surface them
- [x] `server/test/email.test.mjs`: 28 tests — unit (parser/triage/signature/dedup) + integration tests
      that spawn the real relay and assert against actual WebSocket broadcasts (decision card created,
      FYI suppressed, forged/unsigned/stale-timestamp/replayed-token all rejected, genuine signature and
      multipart both accepted, redelivery deduped, oversized body rejected)
- [ ] Real recipient routing — routes every email to `EMAIL_DEFAULT_RECIPIENT_USER_ID` if set, else the
      first user in the org's store; still no `To:` address lookup against actual org membership
- [ ] Actual Mailgun account wired up (signature validation is implemented and tested, but nothing has
      received a real inbound email yet — only synthetic POSTs shaped like Mailgun's)
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
