# QA report — release candidate, 2026-09-11

What was checked before calling this a product someone can pay for, what was
found, what was fixed, and what is still the owner's to do. Every claim here
is something that ran, not something that was read.

## Suites

| Suite | Before | After |
|-------|--------|-------|
| Worker (`worker/`, real workerd) | 391 pass | 411 pass |
| Web unit (`web-react/`, vitest) | 8 pass | 11 pass |
| Web typecheck + build | clean | clean |
| End to end (`e2e/run.sh`, real Worker + D1 + browser) | 27 steps pass | 30 steps pass |
| iOS (`xcodebuild test`, macOS CI) | not runnable here (Linux) | pass — [CI run #287](https://github.com/Torutesu/HonmaruAI/actions/runs/34561892140), dispatched by hand |

## The web client, screen by screen

Every screen was photographed at 390×844 and 1440×900 in the end-to-end run
(`/tmp/e2e-shots` in CI artifacts) and read as a person would. What was wrong,
and what changed:

### Fixed

- **The feed lied on a cold start.** Before the relay's snapshot arrived the
  feed showed "All clear ✓" — to exactly the person who opened the app to see
  what was waiting. It now shows "Opening your feed…" until the relay has
  answered, and only then "All clear" or the cards.
- **A swipe could not be taken back.** A decision left the screen the moment
  it was made, with no way back: the only rollback button in the code was
  inside a sheet nothing opened, behind a condition (`!card.status`) that
  could never be true. Every decision now leaves six seconds of **Undo** on
  the screen, and History keeps Undo on anything you decided.
- **A decision made offline vanished.** `sendDecision` returned early when
  the socket was not open and said nothing, so the card stayed on screen
  looking undecided. The client now holds outbound messages in an outbox and
  delivers them, in order, once the relay has accepted the next join. The top
  bar says "N waiting to send" until they are gone. Tested against a fake
  socket: held while down, sent after the snapshot, never before the join,
  never twice.
- **Keyboard shortcuts leaked under screens.** With the profile or a sheet
  open, pressing **D** declined the card underneath. The feed's keys are now
  inert whenever anything is over it.
- **Every card's context chip sat in a grey box.** An unused legacy component's
  stylesheet defined `.card-context` globally and painted a box behind the
  feed's chip row. The component (and its sheets, which no button opened) is
  gone; the chips sit on the card as designed.
- **History rows did nothing.** Tapping a settled decision closed History and
  opened a feed that, by definition, did not contain it. A row now opens in
  place: summary, reply, note, the GitHub issue, and Undo where it applies.
- **Urgent cards lit no priority mark.** The legend drew low/medium/high; the
  fourth level the API sends lit nothing. It lights the top of the scale and
  says "Urgent".
- **Half the interface stayed English in Japanese.** Sign-in, the code screen,
  Plans, the delete-account confirmation, the record, the notification
  prompts, in-tab notifications and the crash screen were hard-coded. All go
  through the dictionary now, with Japanese for every key.
- **A render error was a blank white page.** An error boundary shows what
  happened, in the reader's language, with a Reload button.
- **Errors never went away.** The error toast stayed until clicked; it now
  clears itself after eight seconds and is announced (`role="alert"`).
- **Pointer capture on swipe.** A fast swipe that ended off the card left it
  stuck mid-drag; the page captures the pointer for the gesture.
- **The tab title read "Honmaru Decision Feed"**; the app is Honmaru AI.
- **`index.html`** gained a description, Open Graph tags, a light/dark
  `theme-color`, and a `<noscript>` line.
- `App.tsx` set state during render on a missing session (a React warning
  and a double render); it is an effect now.

### Checked and fine

- Welcome, sign-up, code entry, onboarding (three pages and the two questions),
  the feed, the list, compose, History, Tools, Notifications, Plans, You,
  Your team, invite/revoke, join by code, removal and eviction — at both
  sizes, in both languages.
- Nothing spills off a 390px viewport on any screen (the suite asserts it).
- No raw account id or email appears on a card or in a list.
- Dark mode has a variant for every new element.
- Focus ring, `aria-label` on every icon-only control, `aria-modal` on sheets,
  `aria-keyshortcuts` on the two answers, `aria-live` on the page counter and
  the loading state, reduced-motion respected for the spinner and the mark.

## The Worker

A read of every route and the relay against the questions a paying customer's
security review would ask: who can write what, what happens when the input is
wrong, and what a browser can read. Every finding below was reproduced against
the code, fixed, and pinned by a test in `worker/test/card-forgery.test.js`
(plus the two existing tests whose expectations changed).

### Fixed — security

- **Any member could overwrite any card in the org** (P1). `saveCard` is an
  upsert, and `card_created` never asked whether the id was taken. Reusing a
  card's id replaced it — status, decision, title — and logged it as
  `created`; the forged `decision.actorUserID` was whoever the attacker named.
  An existing id from another sender is refused. The same sender re-sending
  the same id is an outbox replaying after a lost ack, and is answered with
  silence rather than an error. A new card cannot arrive already decided.
- **`card_updated` with an unknown id created a card with a forged sender**
  (P1). The update branch stamped no sender and checked no recipient, so a
  self-addressed "decided" card could name any login on the platform as its
  sender, and the relay would push, web-push and email that person — in any
  org — with text the attacker wrote. An update must name a card the relay
  has, and it can no longer rewrite who asked.
- **The sign-in code's five guesses were check-then-increment** (P2). Guesses
  arriving together all read "0 attempts" and were all evaluated. The counter
  is now spent by the same `UPDATE … RETURNING` that reads the code, so a
  row with no guesses left never comes back.
- **`?limit=-1` on the events route returned every event the org ever
  logged**, each with a full card snapshot (SQLite reads a negative LIMIT as
  none). Only a positive limit is honoured.
- **Forgetting a push subscription or a device was not scoped to the caller.**
  Both deletes now require the row to be the caller's.
- **Nothing marked session-bearing responses uncacheable.** Every JSON
  response is `cache-control: no-store`.

### Fixed — correctness and robustness

- A 429 from the rate limiter carried no CORS headers, so the web client saw a
  network failure instead of "try again in 40 seconds". It carries them now.
- A body that was not JSON was a 500 ("something went wrong on our side") on
  six routes. It is a 400 that says so.
- `/ai/route` accepted an instruction of any length as prompt material. It is
  capped at 4000 characters, and `text` is required to be text.
- A sign-up name had no type or length check, and landed on every card the
  account created and in every member's join snapshot. Text, at most 120
  characters; email at most 254.

### Caught by the end-to-end suite, not the unit suite

- The instruction cap was first written as an exported constant from the
  Worker's main module. All 403 unit tests passed; `wrangler dev` refused to
  start — workerd rejects a main-module export that is not a handler or a
  function — and the end-to-end run reported the Worker never came up. The
  constant is module-private now. This is the argument for the e2e job being
  on every push: it is the only suite that starts the Worker the way
  production does.

- **The connector cron only synced people who had configured Notion.** It
  picked people up by the existence of a `connector_config` row, and only the
  Notion writer wrote one — so a Gmail-only person was synced only when they
  pulled by hand. `GET /connectors` now remembers what Composio lists as
  ACTIVE (a `connected` flag beside any configuration the connector keeps,
  dropped when the account goes away), and the cron runs only the connectors
  the deployment offers rather than the whole catalogue.

### Checked and solid

Membership checks on every org route and on the relay join; sender stamping
and recipient-only decide/delete/rollback; invite minting, ceilings and
single-use redemption; OAuth state consumed atomically and the GitHub token
never leaving the server; the `/github` proxy allowlist; PBKDF2 for passwords
and codes with constant-time comparison; Mailgun HMAC with nonce replay
protection; every SQL statement parameterised; secrets redacted from logs;
media byte-capped and video-only in both directions; third-party failures
degrading rather than throwing; the UTC quota day.

## iOS

Read-only review — there is no macOS here. What was applied is small, local,
and written to the surrounding code's own conventions, and it was then built
and tested on a macOS runner: the CI workflow now accepts `workflow_dispatch`
so the iOS job can run for a branch before a pull request exists, and run
#287 passed on this branch.

### Applied

- **Reconnect loop** (P1). `connect()` cancelled the old receive loop and then
  cleared `intentionalDisconnect` for the new socket, so the old loop's error
  scheduled a reconnect over the healthy connection — which replaced it, whose
  old loop erred, and so on: a fresh join and snapshot every second, with the
  status dot flickering, whenever the repository changed or the app woke
  mid-connect. The loop now stops if it was cancelled or its socket replaced.
- **Outbox lost everything behind a failed send** (P1). `drain()` empties the
  queue; on a throw only the failing event was put back and the loop broke,
  so decisions two and three of three made offline vanished. Everything from
  the failing event on goes back, in order.
- **Email subscribers were metered as free** (P1). An email sign-in never
  identified RevenueCat, so a purchase sat under an anonymous id and the
  Worker's lookup found nothing. The sign-in reply's account id is stored
  (and cleared on sign-out) and used to identify.
- **Sign-out left two things for the next account on the phone**: the outbox
  (replayed as the new session's sender) and "how I work" (sent as
  `senderContext` on every route). Both cleared.
- **The quota notice never rendered in the shipped shell**, so after the free
  routes ran out the feed fell back to keyword routing with nothing on screen
  to say so. It renders regardless of whose chrome is on.
- **The capture screen said "recording" before anything recorded**, and Send
  then did nothing; with no video connection `startRecording` raised an
  Objective-C exception. Guarded on both sides, and `stop` answers at once
  when nothing was recording. Dictation could be started twice across its
  permission prompt and install a second tap on the input bus; guarded.
- **App Store**: the logo's VoiceOver label said "TikTok for Work"; three
  icon-only buttons had no label; four navigation titles and labels had no
  Japanese.
- **You → Plan** no longer offers an Upgrade that opens an empty paywall and a
  Restore that answers "not ready yet" when RevenueCat is not configured. It
  says plans are not on sale in this version.

### Still the owner's — needs a decision, not a patch

- **The Release build carries the RevenueCat Test Store key** (P0 for a paid
  submission). The app refuses to configure the SDK with it in Release, which
  is correct — the SDK would crash — but it means nothing is for sale in the
  binary. The screen says so honestly now; selling requires the `appl_…` key
  in `RevenueCatConfig.apiKey` ([docs/revenuecat.md](revenuecat.md)).
- English baked into card content and routing sentences on iOS
  (`OrganizationGraph.routingReason`, `DecisionCardService` status/route
  text, `GitHubService` error copy — one of which mentions localhost). Moving
  these to `String(localized:)` is mechanical but wide; the relay already
  composes notification copy in the reader's language and could compose these.

### Checked and solid

Tokens in the Keychain, never logged; stock ATS, `wss://` in production, the
relay override is DEBUG-only; camera, microphone and speech usage strings
present; `PrivacyInfo.xcprivacy` declares the required-reason APIs; account
deletion reachable and requires typing DELETE; no `try!`, no `fatalError`, no
unguarded indexing; every service on the main actor with delegate callbacks
hopping to it; backoff with jitter and a terminal refused state; the outbox
bounded, ordered and on disk; the feed distinguishes offline, refused and
empty.

## Still the owner's to do

These are configuration and store steps, not code:

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions
  secrets, so **Deploy Worker** runs — `main` is ahead of production until
  then ([docs/setup-secrets.md](setup-secrets.md)).
- Turn APNs on in the app: App ID capability, reissued profile, and
  `PushService.isEnabledInThisBuild` ([docs/push-notifications.md](push-notifications.md)).
- Point a Mailgun domain at `POST /webhooks/email` and set
  `MAILGUN_WEBHOOK_SIGNING_KEY` / `INBOUND_EMAIL_DOMAIN`.
- `REVENUECAT_SECRET_KEY` only when billing is meant to be live.
- First App Store submission: the checklist at the end of
  [production-release-plan.md](production-release-plan.md#release-checklist).
