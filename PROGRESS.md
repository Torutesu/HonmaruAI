# Progress

Last updated: 2026-09-11

## Where this is

The product works end to end on real infrastructure: instruct → route → decide →
sync to GitHub, across users, in real time. The backend is Cloudflare Workers +
Durable Objects + D1 + R2 (`worker/`), not the localhost Node relay this started
on (`server/`, kept only as the reference client's host).

- **Worker suite:** 420 tests, real `workerd` via `@cloudflare/vitest-pool-workers`
- **End to end:** `./e2e/run.sh` — a real Worker, a real D1, the built web
  client and a browser signing up with a code it reads out of the message the
  Worker actually sent. 30 steps
- **iOS suite:** `TikTokForWorkTests` — outbox, cache and card state
- **Web unit suite:** 11 tests over the AG-UI client, including the outbox
- **QA report:** [docs/qa-report.md](docs/qa-report.md) — what was checked
  before calling this sellable, what was found, what was fixed
- **CI:** `.github/workflows/ci.yml` — Worker, the reference relay, the
  reference web client and the end-to-end suite on every push, iOS on pull
  requests
- **Deployed:** `https://tiktokforwork.torubj0904.workers.dev`
- **Ships as:** Honmaru AI, `com.honmaru.ai`

The list of what is still missing, and why each item matters, is
[docs/production-release-plan.md](docs/production-release-plan.md).

## Done

### The improvement loop (dogfooding)
- [x] **Feedback on every card.** "Is this card wrong?" sits under each card
      in the web feed; one tap says why (wrong person, not a decision, wrong
      priority, badly written). `POST /cards/:id/feedback`, sender or
      recipient only, one verdict per person per card, on the card's
      timeline as a `feedback` event
- [x] **On the phone too**: the flag sits under the swipe hint on every
      pending card, and You → Insights reads the same numbers
- [x] **Insights** (You → Insights, `GET /metrics?orgId=&days=`): cards per
      day, median time to decide, decline rate, pending, nudges, where cards
      come from, what was decided, what the AI got wrong. From the cards
      themselves; nothing to keep in sync
- [x] **The router reads the team.** `/ai/route` hands the model each
      member's pending load and the team's last twelve decisions, and the
      system prompt says what to do with them: between two who fit, the
      less loaded one; a recommendation that leans on a real recent decision.
      Bounded, optional, and absent on a fresh workspace
- [x] **An eval harness.** `worker/eval/golden.json` (20 entries, en + ja,
      one org fixture) and `npm run eval` (local router; `npm run eval:model`
      with `OPENAI_API_KEY`) print recipient / type / priority / business
      accuracy and write `eval/last-run.json`. `test/eval-golden.test.js`
      gates the local router's recipient accuracy at 90% in CI.
      `GET /eval/export?orgId=` turns real cards and their verdicts into
      golden candidates, with a flagged field left open for a person to fill
- [x] **"Ask anything" answers.** It used to route the question to somebody
      as a new card. `POST /ai/ask {orgId, cardId, question}` answers it
      from the card, a keyword search over the team's past decisions and
      its last eight, in the reader's language — two to five sentences, and
      "what is missing" rather than an invented decision. The answer lands
      under the card on the web and in the card's details sheet on the phone,
      with the decisions it drew on; the question
      is logged as an `asked` event; metered like a route; a deployment with
      no model says so
- [x] **The reply back to whoever asked, drafted.** A decision is one tap;
      the message telling the person who asked was still typed by hand.
      `POST /ai/draft {orgId, cardId}` writes it from the card and the
      decision — the action, the decider's note, the next step the card
      names — in the language the request came in, signed by the decider,
      three to six sentences, nothing invented. History → a decided row →
      "Draft the reply" shows it with Copy; it is a draft, the person sends
      it. Only the two people on the card, only once it is decided (409
      before); logged as a `drafted` event; metered like a route
- [x] **The router looks before it writes.** With a session and an org, the
      model is offered `search_decisions` — 2-4 keywords in, the team's
      matching decisions out, one line each — and told to use it when the
      instruction could repeat or depend on something already decided. One
      search at most, then it must write. A failed lookup is an empty one.
      The research shows up as a step on the card (`toolCalls`)
- [x] **A person can say what else they are called.** You → "Also called"
      (`PUT /me {aliases}`, five names, forty characters each). The org the
      router builds carries them, the local router matches them as whole
      words, and the model's prompt lists them — so 「美香に」 reaches
      `mika`. Golden set recipient accuracy: 18/18
- [x] The local router speaks Japanese: 承認 / 委任 / 修正 / 直して and 至急 /
      参考まで are read the way approve / delegate / revise / fix and urgent /
      FYI are. On the golden set, card type went from 41% to 88% and priority
      from 50% to 75% with no model at all

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
- [x] A cron that syncs connectors every 15 minutes — for everyone who has
      one connected, not only the people who configured Notion. `GET
      /connectors` remembers what Composio listed as ACTIVE, and the cron
      runs only the connectors this deployment offers
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
- [x] A pending decision does not die with the person it was for. Only its
      recipient may decide a card, so somebody leaving left theirs unanswerable
      in a feed nobody opens. They go back to whoever asked, `pending`, saying
      why — in the reader's language — and are dropped with a snapshot in
      `card_events` when the sender is gone too
- [x] **You → Your team**: who is here, the codes still out, and the form that
      mints another. Inviting used to be the whole of team management — no
      member list, no way to take anyone out, and no way to find or revoke a
      code already handed over. `GET/DELETE /members` and `GET/DELETE /invites`
      work for a workspace made at sign-up, which
      `/orgs/:owner/:repo/graph` never did: it reads a GitHub repository's
      collaborators and needs a GitHub session —
      [docs/screens.md](docs/screens.md#seeing-a-team-not-only-adding-to-it)
- [x] **Tools** tells the truth about GitHub. It printed "Always on · Built in"
      to everybody; `GET /connectors/github?orgId=` says no where there is no
      repository to open an issue in, and no where the session has no GitHub
      token to write with
- [x] A typo in an invite code no longer costs a new account the sign-up. It
      used to refuse outright — and the emailed six digits are spent by the
      time signup runs, so one wrong character cost the account *and* the
      credential. They get the workspace they would have got with no code, and
      are told the invite failed
- [x] iOS names its workspace when it routes. `OrganizationGraph` carries
      nodes and edges and never carried an `orgId`, so the relay could not
      rebuild the org from its own membership rows or hand the router the
      org's businesses — the app was routed against whatever graph it happened
      to be holding, and no card it produced could be filed
- [x] A client that republishes a card (iOS does, on a decision) can no
      longer erase the translation or the business the relay added to it
- [x] The web client is the feed: one decision per screen, snap-scrolled,
      swipe or A/D to decide, R to reply, and one button — Tell your AI.
      Sent, Done and You are sheets over it. Verified in Chromium at phone
      and desktop sizes against a fake relay

### Access and safety
- [x] A card cannot be overwritten by reusing its id. `saveCard` is an upsert
      and `card_created` never asked whether the id was taken, so any member
      could replace any card in the org — decision included — and have it
      logged as `created`. An existing id from another sender is refused; the
      same sender re-sending it is an outbox replay and is answered with
      silence. A new card cannot arrive already decided
- [x] `card_updated` names a card the relay has. With an unknown id it used
      to create one through the update path, which stamped no sender and
      checked no recipient — so a "decided" card could carry any login on
      the platform as its sender and have the relay push, web-push and email
      that person the attacker's words. Refused now, and an update can no
      longer rewrite who asked
- [x] The sign-in code's guess counter is spent in the same statement that
      reads the code, so guesses arriving together cannot all read "0 tries"
- [x] `?limit=-1` on the events route no longer means "everything"; JSON
      responses are `no-store`; a 429 carries CORS headers so a browser can
      read when to come back; a body that is not JSON is a 400, not a 500;
      an instruction longer than 4000 characters is refused before it
      reaches a model; a sign-up name is text and at most 120 characters;
      forgetting a push subscription or a device only works on your own
- [x] Relay requires a session with write access to the repository; identity comes off the session
- [x] Only the recipient can decide, delete or undo a card
- [x] OAuth `state`, single-use and expiring
- [x] The GitHub access token never leaves the server. The app holds a relay
      session and calls `/github`, which forwards the six calls it actually
      makes and refuses everything else — so a stolen session opens issues, it
      does not read the person's source
- [x] Rate limits on routing, token exchange, sync and uploads, and on how fast
      one socket may talk
- [x] A card may only be addressed to somebody in the workspace it is created
      in. The relay stamps the sender — "only ever as yourself" — and took the
      recipient on trust, so a card could name anyone with an account: stored
      in an org they can never join to decide it, and `notifyCard` resolves a
      recipient by login with no idea which org asked, so its title and summary
      went out as a push, a web push and an email to a stranger
- [x] `/media` is a video store, not a file host. The served object comes back
      from the Worker's own origin *as whatever the upload claimed* — so a
      session could store HTML and have this origin serve it as HTML, cached
      `public, immutable` by everything in between. Video types only on the way
      in, clamped again on the way out for what is already in the bucket, and
      `nosniff` on both
- [x] Cards from outside the app land where the person actually works. The
      email webhook and the connector cron both chose an org with `LIMIT 1` and
      no ordering — insertion order, invisible while almost everybody was in
      exactly one organization and wrong the moment joining a team became
      ordinary
- [x] `/ai/route` checks membership like every other route that reads an
      organization. It did not, and it answers with a recipient and an agent
      route built from that org's real membership rows — so any signed-in
      account could name a team it had no part in (a repository org is just
      `owner/repo`) and be told, by name, who is on it
- [x] Losing a membership closes the socket it was holding. A socket is
      authorized once, in `join`, and never asked again — so being removed
      from a repository, deleting your account, or being taken out of a
      workspace left a live connection that went on receiving that org's
      cards. All three paths evict now
- [x] The web client stops retrying a refusal. The relay closes with 1008 so a
      client can tell "you are not allowed in" from "the network died", and
      `onclose` ignored the code entirely — so a removed person's browser
      retried against the refusal for as long as the tab was open. The refusal
      carries a `code` (`not-a-member`, `sign-in-required`, `client-too-old`)
      so the decision is not made by matching on English prose
- [x] Account deletion, in the app — and it now names every table that names a
      person. `invites` left a live way into the organization minted by an
      account that no longer existed; `businesses.created_by` and `login_codes`
      kept the address somewhere a teammate could still read it
- [x] `PrivacyInfo.xcprivacy` and a published privacy policy

### Reliability
- [x] The web client holds a decision made offline and delivers it after the
      next accepted join; it says it is opening rather than "All clear"
      before the relay has answered; every decision leaves six seconds of
      Undo, and History keeps Undo on anything you decided
- [x] iOS: a receive loop whose socket was replaced no longer schedules a
      reconnect over the healthy one (a fresh join and snapshot every second,
      with the dot flickering, whenever the repository changed or the app
      woke mid-connect); the outbox puts back everything behind a failed
      send rather than only the failing event; sign-out clears the outbox
      and "how I work", which used to reach the next account on the phone;
      an email sign-in identifies RevenueCat with the account id the Worker
      meters by; the quota notice shows in the shell that ships; the capture
      screen no longer says "recording" when nothing is
- [x] Auto-reconnect with backoff, on foreground and on regaining a network
- [x] Cards cached per organization, so a cold launch is not a blank feed
- [x] Outbox: a decision made offline is delivered on reconnect, in order
- [x] One structured log line per request, with an id echoed to the client

### Polish
- [x] VoiceOver rotor actions on the card; approve and decline no longer need a swipe
- [x] "Waiting 3d" on a pending card, red at five days
- [x] Search and filter over history
- [x] Sent by you, on the phone as well as the web — and the nudge iOS never
      had, so an overdue decision can be asked about from where you see it
- [x] A name is never an address. `DisplayName.of` fell back to the account id,
      which for an email account is the whole address, so a colleague's inbox
      appeared on cards, routing lines and history throughout the app. The web
      client has stripped exactly this since the feed was built
- [x] Pending badge on the tab bar, from the same count as the app icon
- [x] Sessions extend with use, so an active user is never signed out

## Still open


- [ ] **The Release build carries the RevenueCat Test Store key.** `RevenueCatConfig.apiKey`
      is `test_…`, which the app refuses to configure in Release (the SDK
      would crash), so nothing is for sale in the binary. **You → Plan** says
      so now instead of offering an Upgrade that opens an empty paywall and a
      Restore that answers "not ready" — the two taps a reviewer makes first.
      Swap in the `appl_…` key before a paid submission
      ([docs/revenuecat.md](docs/revenuecat.md))
- [ ] Turn APNs on **in the app**. The four Worker secrets are set — the
      deployment reports `push: true` — so the server side is done; what is
      left is the App ID capability, a reissued profile, and flipping
      `PushService.isEnabledInThisBuild`, which is still `false` —
      [docs/push-notifications.md](docs/push-notifications.md)
- [ ] Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **GitHub
      Actions repository secrets**. This is the one piece of configuration that
      is genuinely missing, and it is not a Worker secret — those are all in
      place. Without it `Deploy Worker` stops at "Check credentials" on every
      push, which it has since before 2026-09-08, so `main` is ahead of what is
      actually running — [docs/setup-secrets.md](docs/setup-secrets.md#1-cloudflare自動デプロイを動かす)
- [ ] First App Store submission (TestFlight internal works today)
- [ ] Point a Mailgun domain at the inbound webhook. Email is a connector on
      the Worker now — `POST /webhooks/email`, signature verified (HMAC over
      timestamp+token, ±15 min, single-use nonce in D1, fails closed), routed
      by an address that names its owner (`u-<github id>@<domain>`), then the
      same triage, card, announcement and notification as Gmail and Slack. What
      is missing is the account: no real message has ever reached it, only
      synthetic posts shaped like Mailgun's. Needs `MAILGUN_WEBHOOK_SIGNING_KEY`
      and `INBOUND_EMAIL_DOMAIN` as Worker secrets. Both clients show a person
      their address now, under Tools/Connectors, and hide the row on the 503
      that says this deployment has no inbound domain

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
