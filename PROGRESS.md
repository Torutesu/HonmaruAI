# Progress Checklist

Last updated: 2026-07-30

## Overall

- Current phase: Phase 10 complete (language, GitHub inflow, escalation, memory)
- Core flow working: yes (instruction → routing → decision → result → GitHub)
- GitHub: OAuth + Issues two-way sync + inbound webhooks
- Realtime: authenticated WebSocket relay, deployable (Docker + persistence)
- AI: routing / triage / reply interpretation / translation / digests /
  recommendations via OpenRouter tool calling, deterministic fallbacks throughout
- Server tests: 78 (unit + WebSocket integration)

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

## Phase 7 — Decision loop depth

- [x] Priority change on received pending cards (detail sheet, synced to all clients)
- [x] Ask AI on a card — follow-up instruction refines title/summary/context/priority via relay `/ai/refine`
- [x] Revision requests return as actionable cards — revise and resend routes the updated card back to the requester
- [x] Resent state tracked on the original revision-request card

## Phase 9 — Channels (AI-native chat layer)

- [x] Channel + message store on the relay (persisted, capped, seeded #general)
- [x] WS protocol: channel_snapshot / channel_message / channel_create / channel_created
- [x] Agents as channel members: @ai / @ai-<name> mentions reply with conversation context
- [x] Agent files decision cards from chat (file_decision tool → normal routing pipeline → recipient's feed)
- [x] Offline fallback: `@ai file: <instruction>` routes a card without an AI key
- [x] iOS Channels UI: channel list, timeline, composer, agent messages with tool-call chips
- [x] AI auto-filing: "Tell your AI" triages via `/ai/ingest` — decisions become reviewable cards, updates are filed to channels, new topics auto-create channels
- [x] Decision cards carry a home channel; routing leaves an agent log message in that channel
- [x] Card reply layer: freeform text reply on pending cards, AI-interpreted via `/ai/reply` (conditional approve, reject with reason, revise, question, note)
- [x] Question/note cards back to the sender; notification cards get reply + mark-as-read instead of issue actions
- [x] Voice input: on-device dictation (Speech framework) on the composer, card replies, Ask AI, resend, and channel chat — transcript is editable before sending
- [x] Real org graph: relay owns users/nodes/edges (persisted, `GET /org`, `POST /org/members`, `org_updated` broadcast); routing, mentions, and prompts derive from the live org; add-member UI in the user switcher; GitHub login auto-matches an org member
- [x] Push notifications: APNs (p8 token auth, no deps) with an opinionated policy — only pending high/urgent cards, never to connected users; token registry persisted + pruned; iOS registration, foreground banners, tap-to-open-card deep link, aps-environment entitlement
- [ ] Live APNs verification — needs an Apple Developer p8 key (server runs with push off until then)
- [x] Digest cards: unseen channel activity → one low-priority AI-summarized card per user (`/digest/run` + `DIGEST_INTERVAL_MINUTES`), reply/mark-as-read, never pushes

## Phase 10 — Language & GitHub inflow

- [x] Per-user language: delivery-time card translation (translate.js), digests generated in the recipient's language, agents reply in the author's language, JA offline reply patterns; language editable in the user switcher
- [x] GitHub webhooks (`/github/webhook`, HMAC-verified): review requests → approval cards, issue assignments → task cards, CI failures → high-priority cards; routed via githubUsername mapping through the normal delivery path
- [x] SLA auto-escalation: pending cards past their per-priority SLA climb the manages edge — the manager gets an actionable "Escalated:" copy (translated, pushed if offline), the original is annotated and never escalates twice
- [x] Agent memory: per-user decision history (persisted, capped) → one-tap recommendation on new cards when the pattern is clear (AI + offline consistency heuristic), written in the recipient's language; advisory only
- [x] Provenance: cards carry one-tap sources — home-channel conversation (deep link + scroll to the triggering message) and auto-extracted document links (Notion/Docs/Figma/GitHub etc.); digests link to each summarized channel

## Phase 11 — Visual v2, Settings, cross-platform

- [x] Design v2: adaptive token system (full dark + light palettes), ambient accent glow backdrop, elevated rounded card surfaces, gradient primary actions, SF Rounded display type — all views adapt via tokens, no per-view branching
- [x] Settings screen: appearance (System/Dark/Light with instant apply), language, relay connection, GitHub repo, notifications, sign out, about
- [x] Cross-platform architecture doc (docs/CROSS_PLATFORM.md): TTFWCore package extraction, protocol schema + versioning, macOS three-column workbench + keyboard deciding + menu bar capture, Web thin client (@ttfw/core, web OAuth/PKCE, Web Push, GitHub proxy), shared design tokens pipeline, phased roadmap

## Phase 8 — Deployable relay

- [x] Relay URL + token configurable in-app (auth screen, Keychain-persisted, test connection)
- [x] Relay token auth (`RELAY_TOKEN`): Bearer on HTTP, token in WS join
- [x] Card persistence to disk (debounced JSON writes, reload on boot, flush on shutdown)
- [x] Server test suite (`npm test`): routing, refine, persistence, auth integration
- [x] Dockerfile for Fly.io / Render / Railway
- [ ] Relay deployed to a public URL (needs an account + credentials)
- [ ] TestFlight or installable build (needs Xcode + signing)

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
| AI (routing/triage/reply/translation/digest/memory) | Real + fallback | OpenRouter tool calling; keyword fallbacks keep everything working offline |
| Multi-user realtime | Real | Authenticated WebSocket relay, snapshots + deltas |
| Org graph | Real data | Relay-owned, persisted, member add + language, dynamic routing |
| GitHub auth | Real OAuth | Secret stays on relay |
| GitHub sync | Real | Issues create/update/close-sync + inbound webhooks (HMAC) |
| Push | Implemented, unverified live | APNs p8/HTTP2 unit-tested; needs Apple Developer key |
| Backend host | Configurable | localhost default; Docker + `RELAY_TOKEN`, URL set in-app |
| Persistence | Real (JSON) | Cards/channels/org/memory/tokens survive restarts |
