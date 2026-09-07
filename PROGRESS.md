# Progress

Last updated: 2026-09-07

## Where this is

The product works end to end on real infrastructure: instruct → route → decide →
sync to GitHub, across users, in real time. The backend is Cloudflare Workers +
Durable Objects + D1 + R2 (`worker/`), not the localhost Node relay this started
on (`server/`, kept only as the reference client's host).

- **Worker suite:** 260 tests, real `workerd` via `@cloudflare/vitest-pool-workers`
- **iOS suite:** `TikTokForWorkTests` — outbox, cache and card state
- **CI:** `.github/workflows/ci.yml` — Worker, the reference relay and the
  reference web client on every push, iOS on pull requests
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
- [x] Decisions go out as AG-UI `tool_result` carrying the `toolCallId` of the
      `request_decision` that asked for them, so an answer can be matched to the
      question that prompted it rather than arriving as a bare card update
- [x] A React/TypeScript reference client (`web-react/`) speaking the same AG-UI
      protocol as the app, next to the single-file demo the relay serves at `GET /`
- [x] One AG-UI implementation, in `worker/src/agui/`. `server/agui/` re-exports
      it rather than keeping the near-identical copy it used to — the copies had
      already drifted far enough for a fix to land in the backend nobody runs
- [x] RevenueCat subscriptions, metered server-side (off until `REVENUECAT_SECRET_KEY` exists)
- [x] A cron that syncs connectors every 15 minutes
- [~] Push notifications — built and tested end to end, switched off in the client
      (`PushService.isEnabledInThisBuild`) until the App ID carries `aps-environment`
- [x] Notifications that reach people who do not have the iOS app: one hub
      (`worker/src/notify.js`) behind every call site, fanning out to APNs,
      **Web Push** (VAPID + `aes128gcm` written against Web Crypto, no
      dependency; any browser, Android, an iPhone with the site on its home
      screen) and **email** as the floor when no push arrived —
      [docs/notifications.md](docs/notifications.md)
- [x] Every notification in the recipient's language. `users.locale` is
      seeded from `Accept-Language`, set by the app toggle and the browser,
      and no longer reset to English by the org graph. All copy in
      `notifyCopy.js`, en + ja
- [x] A new card is translated into the recipient's language on the relay
      (`localize.js`, one model call, paid from the sender's allowance) and
      stored as `localized[locale]`, so the alert and the card agree
- [x] A nudge notifies. It used to re-send to open sockets only — the one
      audience that did not need reminding
- [x] The web client subscribes to Web Push, is installable as a PWA, opens
      the card a notification names, and shows a card in the browser's language

### Access and safety
- [x] Relay requires a session with write access to the repository; identity comes off the session
- [x] Only the recipient can decide, delete or undo a card
- [x] OAuth `state`, single-use and expiring
- [x] The GitHub access token never leaves the server. The app holds a relay
      session and calls `/github`, which forwards the six calls it actually
      makes and refuses everything else — so a stolen session opens issues, it
      does not read the person's source
- [x] Rate limits on routing, token exchange, sync and uploads, and on how fast
      one socket may talk
- [x] Account deletion, in the app
- [x] `PrivacyInfo.xcprivacy` and a published privacy policy

### Reliability
- [x] Auto-reconnect with backoff, on foreground and on regaining a network
- [x] Cards cached per organization, so a cold launch is not a blank feed
- [x] Outbox: a decision made offline is delivered on reconnect, in order
- [x] One structured log line per request, with an id echoed to the client

### Polish
- [x] VoiceOver rotor actions on the card; approve and decline no longer need a swipe
- [x] "Waiting 3d" on a pending card, red at five days
- [x] Search and filter over history
- [x] Pending badge on the tab bar, from the same count as the app icon
- [x] Sessions extend with use, so an active user is never signed out

## Still open

- [ ] Turn APNs on: App ID capability, reissued profile, APNs secrets, and the
      constant — [docs/push-notifications.md](docs/push-notifications.md).
      Until then Web Push and email are the channels that actually deliver
- [ ] Set the Web Push and Mailgun secrets on the deployment
      (`VAPID_*`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`) —
      [docs/notifications.md](docs/notifications.md#web-push--setup)
- [ ] A language row in the web client, and a way for a GitHub account to add
      an email address — today only email accounts have one to fall back to
- [ ] First App Store submission (TestFlight internal works today)
- [ ] Point a Mailgun domain at the inbound webhook. Email is a connector on
      the Worker now — `POST /webhooks/email`, signature verified (HMAC over
      timestamp+token, ±15 min, single-use nonce in D1, fails closed), routed
      by an address that names its owner (`u-<github id>@<domain>`), then the
      same triage, card, announcement and notification as Gmail and Slack. What
      is missing is the account: no real message has ever reached it, only
      synthetic posts shaped like Mailgun's. Needs `MAILGUN_WEBHOOK_SIGNING_KEY`
      and `INBOUND_EMAIL_DOMAIN` as Worker secrets, and the app has nowhere yet
      to show a person their address (`GET /connectors/email/address` returns it)
- [ ] A sent-items view — without one there is nowhere to nudge someone whose
      decision is overdue, which is why the SLA work shipped as a chip only
- [ ] A card layout that scrolls within its page, so Dynamic Type does not have
      to be clamped at `accessibility1`


Both of the last two, and the other compromises made here, are written up under
[Known compromises](docs/production-release-plan.md#known-compromises).

## Before the first App Store submission

Run through the checklist at the end of
[docs/production-release-plan.md](docs/production-release-plan.md#release-checklist).
The one that used to top this list — `AppConfig.relayURL` pointing at
`ws://127.0.0.1:8080` — is long gone; the app ships pointing at the deployed
Worker.
