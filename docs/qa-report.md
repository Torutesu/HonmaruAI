# QA report — release candidate, 2026-09-11

What was checked before calling this a product someone can pay for, what was
found, what was fixed, and what is still the owner's to do. Every claim here
is something that ran, not something that was read.

## Suites

| Suite | Before | After |
|-------|--------|-------|
| Worker (`worker/`, real workerd) | 391 pass | 553 pass |
| Web unit (`web-react/`, vitest) | 8 pass | 52 pass |
| Web typecheck + build | clean | clean |
| End to end (`e2e/run.sh`, real Worker + D1 + browser) | 27 steps pass | 48 steps pass |
| iOS (`xcodebuild test`, macOS CI) | not runnable here (Linux) | pass — [CI run #287](https://github.com/Torutesu/HonmaruAI/actions/runs/34561892140), dispatched by hand |

## Threads, mentions, links, roles, and the AI you can change, 2026-09-24

**A card has a thread.** `card_comments` and `card_reactions` per workspace
and card; `GET/POST /cards/:id/comments` and `POST /cards/:id/reactions`
(membership-checked; a comment is at most 2000 characters; reactions are
one of six). A comment is logged as a card event, the card's own row keeps
`commentCount`, `lastCommentAt` and `reactions`, and the relay announces
both the words (a `comment` / `reaction` custom event) and the card, so
every list shows "3 replies" without a join. Whoever the card concerns —
recipient, sender — is notified of a comment; whoever is named with an @ is
notified of the mention, once, in their own language (five new copy
strings, checked by the completeness test). On the web the thread under a
card interleaves comments with what happened, has a reply box where "@"
offers the team's names (arrows, Enter, Escape), and a reaction bar; on
the phone the card sheet gains a Thread section with the same. Classic rows
say how many replies a decision has.

**@mentions name the recipient.** The composer offers names on "@"; one
mention becomes the recipient outright (`mentions: [ref]` on `/ai/route`),
several leave it to the router with the member list in front of it. The
card carries the refs; the relay notifies the people named.

**Invitations are three-day links.** `INVITE_TTL_DAYS` is 3; every endpoint
reads the code out of whatever was pasted (`inviteCodeFrom`), so a link
works wherever a code did; the list of invitations carries the link; the web
and the phone show a link, never a bare code; the join box takes a link.

**Roles are the member's own words.** `setOwnTitle` accepts any title up to
40 characters in any script (presets keep their canonical spelling; a word
that reads as standing — admin, maintainer, triager — is refused); the
Profile row is a text box with the presets as suggestions; the phone gets a
Role field under "Your work context".

**GitHub is a tool any workspace connects.** A team made at sign-up had
nowhere to open an issue. Now `org_github` holds a repository and a token
per workspace; `GET/PUT/DELETE /connectors/github` (admins write; a GitHub
sign-in connects on its own token with one tap, anyone else enters a
fine-grained token, checked against the repository for Issues: write before
it is saved; the token never comes back). Once connected the relay writes
every card as an issue and closes it on a decline or completion, whoever
decided it and however they signed in; the card carries the issue back to
every client. The router's GitHub lookup and "ask" search use the
workspace's repository too.

**Channels are yours to make.** The Classic list's Channels section has a
"+" that makes one, and an open channel offers Rename and Delete channel.
`PUT /businesses` renames (the slug stays, so nothing already filed moves);
`DELETE /businesses` now empties the channel — its cards are unfiled rather
than left pointing at a slug that would keep the channel alive in every
list — and both are announced to the room as a `businesses` event, so every
open list agrees. Empty channels are listed; a channel opens as a channel
even with one card, so its controls are reachable.

**The tools wear their own marks.** Gmail's M, Slack's hash, Notion's page,
GitHub's Invertocat, Google Calendar and Drive, as inline SVG in a white
tile, in Tools and in the list's Apps. Generic glyphs there read as a
mock-up.

**A workspace key is unmetered.** `allowanceFor(env, orgId, …)` treats the
workspace's own OpenAI key like a person's: no daily allowance, their bill.
Every metered call (route, ask, draft, translate, triage, sync, filing, the
relay's enrichment) goes through it, and `GET /billing/status?orgId=` says
`workspaceKey: true` with no remaining count, which the Plans screen shows
as unlimited.

**Your AI is editable.** Tools → Your AI was a read-out of the Worker's
secrets, with nothing to change or enter. Now `org_ai_settings` holds a
model, an OpenAI key and a TypeSafe key per workspace; `GET/PUT /orgs/ai`
(admins write; keys never come back, only a hint) and every model call —
routing, ask, draft, translate, triage, sync, filing, the scheduled run —
is built through `providerFor` / `jevFor` with the order person's key →
workspace key → deployment secret. A workspace key is the workspace's bill,
and the ledger records it as such.

Worker 553, web 52, e2e 48 (three new steps: the thread with an @mention
and a reaction, a role in your own words, the model picked and a bad key
refused on Tools).

## Workspaces and the list, 2026-09-24

**Nothing of one workspace is readable from another.** Every REST read that
takes an `orgId` was already behind `requireMember`; the socket upgrade was
not — a client with no `orgId` landed in a shared `"core-team"` room, which
membership then refused, but the room existed. It no longer does: the
upgrade answers 400 without an `orgId`, the Durable Object refuses a request
without one, and the health probe no longer advertises a default. On the
web, `<Dashboard>` is keyed by `orgId`, so switching teams is a new
Dashboard: state, the synced flag and the card cache restart, and the old
team's cards can no longer be written to the cache under the new team's
name (they could, for one render, before). `worker/test/workspace-isolation.test.js`
holds a member of team A against every read of team B — members, invites,
businesses, record, search, a card, its events, metrics, the eval export,
the stored context, businesses and AI calls that name a card, the rename,
and the socket join — and asserts a 403 whose body names nothing of B.

**"How I work" is stored per person, per workspace, on the server.** The web
kept it in `localStorage` alone, one copy for every team; the phone published
it to the relay, which already wrote it to `contexts (org_id, user_id)`. Now
both sides share that row: `GET/PUT /me/context?orgId=` reads and writes it
(membership-checked; the write is announced to the workspace's open sockets
through the relay's new internal events path, so a phone sees the browser's
edit), the web's copy lives under `senderContext:<orgId>` as a cache, and
`/ai/route` falls back to the stored row when a client sends no
`senderContext`. On iOS, switching teams clears the field before the new
team's snapshot fills it.

**The list is a chat client's home.** Classic was three flat sections. It is
now the Slack-shaped surface the design calls for: the team's name as the
header (with the team screen behind it), a "Jump to or search…" pill that
opens ⌘K, then **Channels** (one per business, `#`), **Direct messages** (one
per person you trade decisions with, with the relay's presence as a green
dot) and **Apps** (Gmail, Slack, your own AI). A conversation with something
waiting on you is bold with a red count; opening it lists its decisions,
each of which opens as a card, and a conversation with one decision opens
that card directly. Slack's neutral scale (`#1d1c1d`, `#616061`, `#f2f2f2`,
`#e01e5a`, `#2bac76`) on purpose, with a dark variant on `#1a1d21`.

## Greys, 2026-09-23

The web had two grey scales: the design system's neutral one (`#202020`,
`#646464`, `#838383`, `#e8e8e8`, `#eeeeee`, `#f8f9fa`) and a cool, blue-tinted
one that had grown beside it (`#101014`, `#45454f`, `#6b6b75`, `#8b8b93`,
`#9a9aa5`, `#ececf0`, `#f5f5f7`, plus a `#e9ebf0` ground on laptops), and the
night side had eleven near-blacks. Every value is now on one neutral scale
per side — day: the tokens above; night: `#0f0f0f` ground, `#1a1a1a`
surface, `#2a2a2a` border, `#f2f2f2` / `#a3a3a3` text — mapped rule by rule
with the dark blocks handled separately, so a light value that lived inside
a dark block (a light pill's text) stayed light. `e2e/design-audit.mjs`
takes `DESIGN_DARK=1` and photographed both sides at six widths; that
turned up the night side's own gaps — the profile's title, name and
numbers, the inputs, and the ground of every page and of the sign-in card,
all still on day-side values — and they are fixed.

## Responsive pass, 2026-09-23

Photographed every screen at 390, 834, 1024, 1280, 1440 and 1920px, signed
out and in (`e2e/design-audit.mjs`). What was wrong: everything between a
phone and 1080px was the phone layout stretched — a bottom tab bar on an
iPad, a card floating in a sea of grey on a small laptop; at 1440 the pane
was pinned to the left of a huge empty area and at 1920 more so; screens
(History, You, Team, Tools) were phone columns with a "‹" chip stranded at
the left; the composer was a bottom sheet the width of the window; the
welcome and sign-in were a phone column with the button at the bottom edge
of the window. Fixed by a three-step layout (720 / 1024 / 1280), the pane
centred with a wider card and labelled decision buttons, screens as pages,
the composer as a dialog, sign-in as a card. Found on the way: pressing `n`
to compose typed an "n" into the composer, and the rail vanished while the
composer was open. The rail now lights the screen that is open.

## Teams and invitations, 2026-09-23

Added after the QA pass, with `main`'s native UI (1.0.1) merged in first.
Three end-to-end steps drive the whole thing on the real Worker: a team is
named on its screen and an invitation is sent by email — the mail in the
sink names the team and carries a `#/join/<code>` link; a signed-in person
opens a link and lands in the named team with a second workspace to switch
to; a stranger opens the mailed link, sees "E2E Person invited you to
Honmaru Coffee" on sign-up with the code filled in, and the account they
make lands in that team. Worker tests cover the routes' refusals (a member
renaming, a repository being renamed, a guessed or spent code peeked at, an
invitation with no mail configured, a mail that fails leaving no code
behind) and the copy in every language.

Found on the way: the credential bucket (10 per 5 minutes per address)
counted code *requests* as well as verifications, so an office signing in
from one address, or this suite, hit 429 by the sixth person. Requests have
their own bucket now; verifying still has the tight one.

## QA pass, 2026-09-23 — the workbench, Jev, translation, connected context

The second full pass, over everything added since the release candidate: the
laptop workbench, ⌘K, voice input, the offline shell, Jev as the decision
layer, translation on request, Notion/GitHub context, GitHub sign-in on the
web. Same method: every suite run, five steps added to the end-to-end run
for what the earlier run never looked at, every screenshot read, and the
whole diff since `610693a` reviewed for correctness and security by a
second reader with the findings verified against the code.

### Added to the end-to-end run

- **j and k walk the inbox, and the URL follows** — the keyboard walk on a
  laptop, and `#/feed/<id>` tracking the selection.
- **A decided card opens in the workbench** with its decision line, Undo,
  no decide buttons, and "Draft the reply" answering in the pane.
- **The workbench reads in Japanese** — the inbox heading and the palette
  placeholder, not just the phone screens.
- **The workbench holds up in the dark** — the page paints its own dark
  ground under a dark shell.
- **What happened to a card opens on a phone** — the thread under a card at
  390×844.

### Found by reading the screenshots, fixed

- **In the dark, "Tell your AI" and the Cards count were invisible** — the
  compose tab's label and the mode switch's badge kept their light-theme
  colours on a dark laptop shell.
- **The thread showed its wire format.** A flag came out as `feedback` with
  `wrong-priority` under it; a translation as `localized`. Every event and
  every reason has a word now, and the reader's own actions say "You".
- **"4 urgent" for four high-priority cards.** The inbox's today line
  counted high as urgent. Urgent and high are counted apart, and the chip
  says "High or urgent", which is what it filters.
- **The clock ignored the interface language.** Times in the thread were
  formatted in the browser's locale under a Japanese interface.
- **The phone page could not scroll with the thread open** — a card plus
  its history overflowed a page that did not scroll.
- **The inbox re-mounted every row on every render.** The row was an
  inline component, a new type each time, so focus was lost mid j/k walk
  and a click could land on a row that was no longer there (the end-to-end
  run caught this: "Element is not attached to the DOM"). Hoisted.

### Found by the code review, fixed

- **A translation could erase a decision.** `POST /cards/:id/localize`
  read the card, spent up to thirty seconds translating, and wrote the
  whole card back, so a decision made in between was overwritten and
  broadcast as undone. The route now writes only `localized.<locale>`
  (`json_set` in D1), re-reads, and announces what is there. Tested with a
  decision made inside the mocked model call.
- **Auto-translation spent the free day.** The web client asked for up to
  six translations per render for every card of yours, against the same
  allowance and rate bucket as routing: three Japanese cards used a free
  reader's three daily calls before they typed anything. The client now
  asks only for the card in front and what is pending for you, two at a
  time; the Worker keeps the last call of a metered day for the person's
  own instruction (429, and the client stops asking); translation has its
  own rate bucket.
- **Login CSRF on the web sign-in.** The state check was skipped when this
  browser had no nonce stored, so a callback URL pasted from elsewhere
  would have signed the browser into whoever started it; and a callback was
  honoured even for someone already signed in. Both refused now, tested.
- **A guest reached Jev.** `/ai/route` passed the System One key for every
  caller, signed in or not. Gated on a session; a guest is routed locally.
  Tested with a Jev interceptor that must stay unused.
- **"Decided before" never opened.** A palette hit outside the inbox fell
  back to the first pending card without a word. A card the URL names now
  opens from the whole snapshot, and one older than the snapshot is fetched
  (`GET /cards/:id`, member-only, tested). A miss says so.
- **The card cache outlived the sign-out.** Two hundred cards stayed in
  `localStorage` after logout. Cleared on logout and on leaving a workspace.
- **The service worker could cache a 404 as the app.** A failed navigation
  during a bad deploy would have become the offline shell. Only an ok,
  unredirected page is kept.

### Reviewed and clean

Jev answers are validated against server-derived option sets and every
failure degrades to the previous path; the Notion/GitHub lookups run on the
caller's own token with no privilege to gain; the new routes check
membership and bind their parameters; the redirect allowlist is exact.

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
