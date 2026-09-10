# Progress

Last updated: 2026-09-10

## Where this is

The product works end to end on real infrastructure: instruct → route → decide →
sync to GitHub, across users, in real time. The backend is Cloudflare Workers +
Durable Objects + D1 + R2 (`worker/`), not the localhost Node relay this started
on (`server/`, kept only as the reference client's host).

- **Worker suite:** 332 tests, real `workerd` via `@cloudflare/vitest-pool-workers`
- **End to end:** `./e2e/run.sh` — a real Worker, a real D1, the built web
  client and a browser signing up with a code it reads out of the message the
  Worker actually sent. 23 steps
- **iOS suite:** `TikTokForWorkTests` — outbox, cache and card state
- **CI:** `.github/workflows/ci.yml` — Worker, the reference relay, the
  reference web client and the end-to-end suite on every push, iOS on pull
  requests
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
- [x] Businesses: an org runs several and every card belongs to one, filed
      by the AI in the background — the router, the relay, the sync and the
      email webhook all classify, creating a business when the name is new.
      No chip row, folder or filter; a label on the card and a list under
      ⋯ — [docs/businesses.md](docs/businesses.md)
- [x] The record: what was decided, per business, as a view over the cards
      — ⋯ → The record in the web client, `GET /record` (JSON or Markdown).
      The minimum documentation, written by nobody —
      [docs/record.md](docs/record.md)
- [x] ⋯ → You: the language every card and notification is written in, and
      an email address for a GitHub account so the email floor reaches it
- [x] An invite works on any day, not only the day you made your account. The
      code field is on both sign-in modes, `/auth/otp/verify` and `/auth/login`
      redeem one, and **You → Join a team** takes one from someone who is
      already signed in — `/invites/accept` had no caller in either client
      before, so an invite handed to an existing account did nothing at all,
      with no error and without even spending the code
- [x] Every sign-in reply names the workspace to open, and `GET /me` lists
      every workspace a person belongs to. Only sign-up used to say: signing in
      as an existing account named none, and the web client fell back to a
      hardcoded `web-team` — an org nobody is a member of — so the relay
      refused the socket and a second browser never showed a feed
- [x] **You → Where you work**, once there is more than one: your own
      workspace and any team you were invited into, named after whoever
      started it rather than by `personal:<hash>`
- [x] A client that republishes a card (iOS does, on a decision) can no
      longer erase the translation or the business the relay added to it
- [x] The web client is the feed: one decision per screen, snap-scrolled,
      swipe or A/D to decide, R to reply, and one button — Tell your AI.
      Sent, Done and You are sheets over it. Verified in Chromium at phone
      and desktop sizes against a fake relay

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
- [x] `/ai/route` checks membership like every other route that reads an
      organization. It did not, and it answers with a recipient and an agent
      route built from that org's real membership rows — so any signed-in
      account could name a team it had no part in (a repository org is just
      `owner/repo`) and be told, by name, who is on it
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
- [ ] Seeing a team, not just adding to it: there is no member list for a
      workspace made at sign-up, no way to remove someone from one, and no way
      to list or revoke the invite codes you have minted.
      `/orgs/:owner/:repo/graph` answers this for a repository-backed org and
      needs a GitHub session, so it answers it for nobody who signed in with
      an email address
- [ ] **Tools** shows GitHub as "Always on · Built in" to everyone, including
      an email account in a `personal:` workspace, where issue sync cannot run
      at all — there is no repository and no GitHub token
- [ ] iOS `AIService` now sends its session token, so the app is routed by the
      model rather than the keyword fallback. Not compiled here — no macOS in
      this environment; the iOS job on a pull request is what builds it
- [ ] A new account whose invite code has a typo is refused outright, and the
      emailed sign-in code has already been spent by then — so they start over
      rather than landing in a workspace of their own with the invite reported
      as failed, which is what an existing account now gets
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
