# Progress

Last updated: 2026-08-15

## Where this is

The product works end to end on real infrastructure: instruct → route → decide →
sync to GitHub, across users, in real time. The backend is Cloudflare Workers +
Durable Objects + D1 + R2 (`worker/`), not the localhost Node relay this started
on (`server/`, kept only as the reference client's host).

- **Worker suite:** 147 tests, real `workerd` via `@cloudflare/vitest-pool-workers`
- **iOS suite:** `TikTokForWorkTests` — outbox and cache logic
- **CI:** `.github/workflows/ci.yml` — Worker on every push, iOS on pull requests
- **Deployed:** `https://tiktokforwork.torubj0904.workers.dev`
- **Ships as:** Honmaru AI, `com.honmaru.ai`

The list of what is still missing, and why each item matters, is
[docs/production-release-plan.md](docs/production-release-plan.md).

## Done

### Product
- [x] Vertical decision feed, swipe to approve/decline, delegate, revise, undo
- [x] Instruction → Decision Card via OpenAI, keyword router as the always-available fallback
- [x] Real org graph from GitHub repository collaborators
- [x] Decisions sync to GitHub Issues, and back (closed issue → completed card)
- [x] Gmail, Slack and Notion inbound via Composio, authorized per user
- [x] Decisions written out to the decider's chosen Notion database
- [x] Video capture attached to a card, stored in R2
- [x] Dictation, English/Japanese, light and dark
- [x] RevenueCat subscriptions, metered server-side (off until `REVENUECAT_SECRET_KEY` exists)
- [x] Push notifications, and a cron that syncs connectors every 15 minutes

### Access and safety
- [x] Relay requires a session with write access to the repository; identity comes off the session
- [x] Only the recipient can decide, delete or undo a card
- [x] OAuth `state`, single-use and expiring
- [x] Rate limits on routing, token exchange, sync and uploads
- [x] Account deletion, in the app
- [x] `PrivacyInfo.xcprivacy` and a published privacy policy

### Reliability
- [x] Auto-reconnect with backoff, on foreground and on regaining a network
- [x] Cards cached per organization, so a cold launch is not a blank feed
- [x] Outbox: a decision made offline is delivered on reconnect, in order
- [x] One structured log line per request, with an id echoed to the client

## Still open

Tracked in full in [the plan](docs/production-release-plan.md#p2--polish).

- [ ] Card SLA — "waiting 3 days" and a nudge back to the sender
- [ ] Search and filter over history
- [ ] Session token refresh before the 30-day expiry
- [ ] Pending badge on the tab bar
- [ ] First App Store submission (TestFlight internal works today)

## Before the first App Store submission

Run through the checklist at the end of
[docs/production-release-plan.md](docs/production-release-plan.md#release-checklist).
The one that used to top this list — `AppConfig.relayURL` pointing at
`ws://127.0.0.1:8080` — is long gone; the app ships pointing at the deployed
Worker.
