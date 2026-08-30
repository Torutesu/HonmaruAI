# Production release plan

What stands between the app that exists today and one that can be handed to a
paying stranger.

> **Status, 2026-08-15.** All seven stages are done, on
> `claude/production-release-plan-ssw2x1` (PR #4): every P0 and P1, and the P2
> polish list. The Worker suite went from 106 tests to 152, and the iOS target
> — which did not exist — covers the outbox, the cache and card state. Each
> item below keeps its full write-up; the reasoning is what makes a fix
> reviewable a year later.
>
> One item shipped as a compromise rather than a fix, and is flagged as such:
> **P2-1**, where the feed's one-card-per-page gesture and unbounded Dynamic
> Type cannot both be satisfied without rebuilding the gesture.

The product works: 106 Worker tests pass, the core loop (instruct → route →
decide → sync to GitHub) is real, and TestFlight internal builds ship. What
follows is not a feature wishlist. Every item is either something that is
**broken in a way a user or an attacker can reach**, or something whose absence
means the product does not actually deliver its own promise.

Each item states the defect, the blast radius, the fix, the files, and how we
know it worked.

---

## Severity model

| Tier | Meaning | Release gate |
|------|---------|--------------|
| **P0** | Exploitable, destructive, or an App Store rejection | Blocks any public release |
| **P1** | The product's promise does not land without it | Blocks the 1.0 we would want reviewed |
| **P2** | Polish that separates "works" from "good" | Ships in 1.0.x |

---

# P0 — release blockers

## P0-1 · The realtime relay has no authentication at all  ·  **Done**

**Defect.** `OrgRelay.fetch` (`worker/src/relay.js:20`) accepts any WebSocket
upgrade. `orgId` comes from a query string. The `join` handler
(`worker/src/relay.js:63`) treats `payload.sessionToken` as *optional* — when it
is absent it takes `payload.userId` at face value.

**Blast radius.** Anyone who knows a repository name can:

- connect to `wss://…/?orgId=owner/repo` and receive a full snapshot of every
  decision card in that org — salaries, contracts, client escalations;
- send `card_created` as any user, injecting a forged decision into a
  colleague's feed;
- send `card_updated` carrying a `decision`, which the relay records as a real
  decision *and* writes to that person's Notion database
  (`worker/src/relay.js:116`);
- send `clear_store` and delete every card the org has (see P0-2).

There is no exploit chain here. It is one `wscat` command.

**Fix.**

1. `join` requires `sessionToken`. No token → send an AG-UI `RUN_ERROR`, close
   with code `1008`, never attach.
2. The session's `github_id` must have a `memberships` row for the requested
   `orgId`. Not a member → same close.
3. `userId` is **decided by the server** from `users.login`. The client's
   claimed `userId` is ignored entirely, so forging a sender becomes impossible
   rather than merely discouraged.
4. Store `githubId` in the socket attachment so later messages
   (`card_created`, `rollback`, `context_updated`) can be authorized without a
   second DB round trip.
5. Every mutating message re-checks that the socket is authenticated. An
   unauthenticated socket that skipped `join` can currently still write.

**Files.** `worker/src/relay.js`, `worker/src/db.js` (add
`getUserByGithubId` reuse), `worker/test/relay-auth.test.js` (new).

**Acceptance.** A socket that joins without a token receives an error and is
closed. A socket that joins with a valid token for an org it does not belong to
is closed. A socket that joins validly but claims `userId: "someone-else"` is
attached as its *own* login. Existing relay tests still pass with tokens added.

---

## P0-2 · `clear_store` deletes an entire organization's data, and the app calls it on sign-out  ·  **Done**

**Defect.** `clear_store` (`worker/src/relay.js:175`) runs
`DELETE FROM cards WHERE org_id = ?`. iOS calls it from `AppState.signOut()`
(`TikTokForWork/App/AppState.swift:171`) and from `handleRepositoryChanged()`
(`:188`).

**Blast radius.** One person signing out wipes every pending decision for every
member of the org. This is not an attack — it is the normal sign-out path. It is
a guaranteed total data loss event the first day two people use the app.

**Fix.** Delete the message type. The relay ignores `clear_store` entirely (kept
as a no-op so an older TestFlight build cannot crash the DO), and iOS drops the
call: signing out resets *local* state only, which is all it ever meant.

**Files.** `worker/src/relay.js`, `TikTokForWork/App/AppState.swift`,
`TikTokForWork/Services/WebSocketService.swift`.

**Acceptance.** A test asserts that `clear_store` from an authenticated socket
leaves the store intact. Signing out and back in shows the same cards.

---

## P0-3 · OAuth has no `state` parameter  ·  **Done**

**Defect.** `requestAuthorizationCode` (`TikTokForWork/Services/GitHubService.swift:266`)
builds the authorize URL with `client_id`, `redirect_uri`, `scope` and nothing
else. `/oauth/github/token` (`worker/src/index.js:116`) exchanges whatever code
it is handed.

**Blast radius.** The redirect is a custom URL scheme (`tiktokforwork://`),
which iOS awards to *any* app that claims it. Combined with a missing `state`,
a malicious app that registers the same scheme can feed our app an
attacker-issued code and bind the victim's session to the attacker's GitHub
account (login CSRF). The endpoint is also an open oracle: it will exchange any
code anyone POSTs.

**Fix.**

1. `GET /oauth/github/state` mints a single-use, 10-minute nonce into a new
   `oauth_states` table and returns it.
2. iOS includes it as `state` on the authorize URL and verifies the value echoed
   back on the callback before doing anything with the code.
3. `POST /oauth/github/token` requires `state`, consumes the row atomically
   (delete-then-check), and rejects an unknown, used, or expired one with 400.

**Files.** `worker/src/index.js`, `worker/src/db.js`, `worker/schema.sql`,
`TikTokForWork/Services/GitHubService.swift`, `worker/test/oauth-state.test.js`
(new).

**Acceptance.** Token exchange without `state` → 400. Replaying a consumed
`state` → 400. An expired one → 400. The happy path still returns a session.

---

## P0-4 · No rate limiting anywhere  ·  **Done**

**Defect.** `/ai/route`, `/oauth/github/token`, `/connectors/sync` and `/media`
accept unlimited requests. The AI meter (`worker/src/gate.js`) only engages when
`REVENUECAT_SECRET_KEY` is set, and never applies to anonymous callers on the
happy path.

**Blast radius.** An unauthenticated loop against `/ai/route` bills our OpenAI
key until it is exhausted. `/media` fills the R2 bucket 12 MB at a time.
`/oauth/github/token` can be used to brute-force codes.

**Fix.** A shared fixed-window limiter in D1, keyed by session token when there
is one and by `CF-Connecting-IP` when there is not. Applied per route with
per-route budgets. Fails **open** on a DB error — a limiter outage must not take
the product down.

| Route | Budget |
|-------|--------|
| `POST /ai/route` | 30 / 5 min |
| `POST /oauth/github/token` | 10 / 5 min |
| `POST /connectors/*/sync` | 6 / 5 min |
| `POST /media` | 20 / hour |

**Files.** `worker/src/ratelimit.js` (new), `worker/src/index.js`,
`worker/schema.sql`, `worker/test/ratelimit.test.js` (new).

**Acceptance.** The 31st `/ai/route` inside five minutes returns 429 with
`Retry-After`. A different IP is unaffected. Rows expire.

---

## P0-5 · No account deletion  ·  **Done**

**Defect.** There is no way to delete an account or its data, from the app or
the API.

**Blast radius.** App Store Review Guideline **5.1.1(v)** requires any app that
supports account creation to support account deletion *in the app*. This is a
hard rejection, not a warning. It is also the only GDPR/APPI erasure path we
have.

**Fix.** `DELETE /account` removes, for the caller's `github_id`: sessions,
memberships, agents, connector config, entitlements, AI usage, ingested items,
their contexts, their cards, and their user row. Card *events* are kept but
anonymized (`actor_user_id` → `deleted-user`) because they are an audit log
others rely on — this is disclosed in the privacy policy.

iOS gets a destructive row in the account screen behind a typed confirmation.

**Files.** `worker/src/account.js` (new), `worker/src/index.js`,
`TikTokForWork/Features/Shell/YouView.swift`,
`worker/test/account-delete.test.js` (new), `docs/privacy-policy.md` (new).

**Acceptance.** After deletion the session token 401s, the user's cards are
gone, and a fresh sign-in starts empty.

---

## P0-6 · No privacy manifest, no privacy policy  ·  **Done**

**Defect.** No `PrivacyInfo.xcprivacy` in the bundle. No privacy policy URL.

**Blast radius.** Since spring 2024 Apple rejects uploads that use
required-reason APIs without a manifest. `UserDefaults` alone triggers it, and
we use it heavily (`AppConfig`, `AppState`, `FirstRunFlags`). Apps with accounts
also require a reachable privacy policy URL.

**Fix.** Ship `PrivacyInfo.xcprivacy` declaring `UserDefaults` (reason `CA92.1`),
file timestamps if used, plus the collected data types (identifiers, user
content — both linked to identity, neither used for tracking). Write
`docs/privacy-policy.md` and publish it.

**Files.** `TikTokForWork/PrivacyInfo.xcprivacy` (new), `project.yml`,
`docs/privacy-policy.md` (new).

---

## P0-7 · The client never reconnects  ·  **Done**

**Defect.** `WebSocketService.connect` sets `intentionalDisconnect = false`,
then immediately calls `disconnect(intentional: true)` to tear down any previous
socket — which sets the flag back to **true** and never clears it
(`TikTokForWork/Services/WebSocketService.swift:183-188`). `scheduleReconnect()`
returns early on that flag, so after the very first connect, **auto-reconnect is
dead**.

**Blast radius.** Every network blip, every backgrounding, every cell handover
silently ends realtime for the session. The green dot lies. In a realtime
product this is the defect.

**Fix.**

1. Clear the flag *after* the teardown, not before.
2. Exponential backoff with full jitter (1s → 30s cap) instead of a flat 2s.
3. Reconnect on `scenePhase == .active` and on `NWPathMonitor` regaining a path.
4. Publish a real `connectionState` (`connected` / `connecting` / `offline`) so
   the UI can stop claiming to be live when it is not.

**Files.** `TikTokForWork/Services/WebSocketService.swift`,
`TikTokForWork/Features/Feed/FeedView.swift`,
`TikTokForWork/TikTokForWorkApp.swift`.

---

# P1 — the product's promise

## P1-1 · No push notifications  ·  **Done**

A decision feed nobody is told about is a to-do list you have to remember to
open. The entire pitch — "open the app and the decision is already there" —
assumes the user knows to open it. This is the single largest product gap.

**Fix.** APNs token authentication driven from the Worker (ES256 JWT signed with
Web Crypto — no dependency needed), a `device_tokens` table, `POST /devices` to
register, and a send on every card that lands for someone other than its author.
The relay already knows the recipient; it fans out to their devices in
`waitUntil`, exactly like the Notion write.

Notification content is the card title and a routing line, with
`thread-id` = card id so a decided card's notification collapses.

iOS: request authorization *after* the first approval (not at launch — the
permission ask lands when its value is obvious), register in
`didRegisterForRemoteNotifications`, set the badge to the pending count, and
deep-link a tap to the card.

**Files.** `worker/src/apns.js` (new), `worker/src/push.js` (new),
`worker/src/relay.js`, `worker/src/index.js`, `worker/schema.sql`,
`TikTokForWork/Services/PushService.swift` (new),
`TikTokForWork/TikTokForWorkApp.swift`, `project.yml` (aps-environment
entitlement), `worker/test/apns.test.js` (new).

## P1-2 · Nothing survives a cold launch  ·  **Done**

`DecisionCardService` holds cards in a dictionary in memory. Launch the app on
the subway and the feed is blank until the socket connects — which, on a plane,
is never.

**Fix.** Write the store to Application Support as JSON on every mutation
(debounced), load it synchronously before the first render, and let the relay
snapshot replace it when it arrives. The existing "empty snapshot merges rather
than wipes" rule extends to this.

**Files.** `TikTokForWork/Services/CardCache.swift` (new),
`TikTokForWork/Services/DecisionCardService.swift`.

## P1-3 · Decisions made offline are silently thrown away  ·  **Done**

`publishUpdated` and friends are `try?` (`WebSocketService.swift:221-243`). With
no socket, `send` throws, the error is discarded, and the decision exists only on
that device. The user sees success. The teammate never hears.

**Fix.** An outbox: every outbound mutation is appended to a durable queue, and
flushed in order on reconnect. Entries carry the card id so a re-delivery is
idempotent against the relay's upsert.

**Files.** `TikTokForWork/Services/Outbox.swift` (new),
`TikTokForWork/Services/WebSocketService.swift`.

## P1-4 · Connectors only sync when the app is open  ·  **Done**

`/connectors/sync` is pull-only, triggered by the client. "Your AI triaged three
decisions overnight" cannot happen if the AI only runs while you are watching.

**Fix.** A Cron Trigger every 15 minutes walks users with a live session and at
least one connected account, runs `syncAll`, and pushes anything new. Reuses the
existing per-user metering so a cron sync costs the same allowance as a manual
one.

**Files.** `worker/src/scheduled.js` (new), `worker/src/index.js`,
`worker/wrangler.toml`, `worker/test/scheduled.test.js` (new).

## P1-5 · No iOS tests, no CI  ·  **Done**

There is no test target in `project.yml`. Nothing runs on push.

**Fix.** A `TikTokForWorkTests` unit target covering the pure logic that is
currently untested and most likely to break: card state transitions, the offline
router, `AGUIEventAssembler` decoding, the outbox, and the cache. Plus a GitHub
Actions workflow running the Worker suite on every push, and `xcodegen` +
`xcodebuild build-for-testing` on macOS for pull requests.

**Files.** `.github/workflows/ci.yml` (new), `project.yml`,
`TikTokForWorkTests/*` (new).

## P1-6 · Errors are invisible on the server, alerts on the client  ·  **Done**

No structured logging, no request ids, no way to answer "why did this user's
routing fail at 3pm". Client-side, every failure is an alert with a raw
`localizedDescription`.

**Fix.** A `logJSON` helper emitting one structured line per request
(`{req, route, status, ms, orgId, userId}` — never a token, never a body), a
request id echoed as `x-request-id`, and `/health` reporting DB reachability.
Client-side, typed errors with recovery copy and a retry affordance.

---

# P2 — polish

| # | Item | Outcome |
|---|------|---------|
| P2-1 | VoiceOver + Dynamic Type on the card | **Done, partly as a compromise.** Approve, decline, revise and delegate are rotor actions — VoiceOver owns horizontal swipes, so the product's primary gesture did not exist for anyone using it. Dynamic Type is *clamped* at `accessibility1`: one card fills one page and cannot scroll, so past that size the action row left the screen with no way back. Nesting a scroll view inside the paging one fights the gesture the feed is built on. The clamp is only tolerable because the rotor actions work at every size, including the clamped ones. The real fix is a card layout that scrolls within its page, and it is a redesign, not a patch. |
| P2-2 | Pending badge on the tab bar | **Done.** The count now has one owner (`DecisionCardService.pendingCount`) feeding both the tab and the app icon — it was computed in the feed view model, and a count computed twice is a count that eventually disagrees with itself. |
| P2-3 | Card SLA | **Done as a chip, not a nudge.** A pending card shows "Waiting 3d" from day two and turns red at five. The nudge-back-to-sender half was dropped on purpose: you only see cards routed *to* you, so there is no screen on which to nudge someone. That needs a sent-items view, which is a feature, not polish. |
| P2-4 | Search + filter over history | **Done.** Searchable over title, actor and note; filtered by all/decided/created/undone, because "did that get approved?" is the question people actually arrive with. "Nothing matches that" is distinct from "nothing has happened" — the difference between the query being wrong and the product being empty. |
| P2-5 | Empty and error states | **Done.** Three causes, three sentences. "No decisions yet. Tell your AI something" in front of someone whose socket was refused was the app blaming the user for its own state. |
| P2-6 | Localization sweep | **Done.** Every string added across this branch has ja, along with four that had been sitting untranslated next to translated ones. A check script over `String(localized:)` reports zero gaps. |
| P2-7 | Session refresh before the 30-day expiry | **Done.** Use extends the window, past halfway only — someone who opened the app every morning was still signed out on day 31, with no warning and nothing to distinguish it from a bug. Absence is what should expire a session; time alone should not. Failing to extend is explicitly not failing to authenticate. |

## Known compromises

Worth stating plainly rather than leaving to be discovered:

- **The OAuth scope is still `repo`.** The token no longer reaches the device —
  the app calls `/github`, which forwards only what it uses — but what we ask
  GitHub for is unchanged, because OAuth Apps have no issues-only scope: issues
  live under `repo` for private repositories and `public_repo` for public ones.
  Narrowing it means becoming a GitHub App, where `issues:write` plus
  `metadata:read` is expressible. That is an authentication migration — install
  flow, token refresh, and re-authentication for everyone already signed in —
  not a change of one string.

- **Dynamic Type is clamped on the feed card** (P2-1 above). Sizes above
  `accessibility1` are refused rather than rendered badly. VoiceOver users are
  unaffected; someone who reads with large text and does not use VoiceOver gets
  smaller text than they asked for.
- **The SLA chip has no nudge** (P2-3 above) — nowhere to put it until a
  sent-items view exists.
- **`triage` is not membership.** GitHub grants it for managing issues without
  any push permission, and it used to be accepted here — so the stated rule
  ("write access is what makes someone a member") and the code disagreed, with
  the code the more generous of the two. They agree now, which means a
  triage-only collaborator who could previously join no longer can.
- **Membership means write access.** A read-only collaborator on a private
  repository cannot join. `GET /repos` cannot tell them from a stranger reading
  a public repository, and treating `pull` as membership would make every public
  repository a joinable organization.
- **Audit history survives account deletion**, anonymized. Disclosed in the
  privacy policy, because an undisclosed retention is the worse answer.

---

# Order of work

Dependencies, not preference. Each stage lands as its own commit with tests.

| Stage | Contents | Rationale | |
|-------|----------|-----------|---|
| **1** | P0-1, P0-2 | The relay is the whole product's trust boundary. Nothing else matters if it is open.  ✅ |
| **2** | P0-3, P0-4 | Close the remaining externally reachable holes.  ✅ |
| **3** | P0-5, P0-6 | Both are hard App Store gates and both are self-contained.  ✅ |
| **4** | P0-7, P1-2, P1-3 | The client's reliability story: reconnect, persist, never lose a decision.  ✅ |
| **5** | P1-1, P1-4 | Push and cron together — one delivers what the other produces.  ✅ |
| **6** | P1-5, P1-6 | Now that behaviour is settled, lock it down and make it observable.  ✅ |
| **7** | P2 | Polish, in the order above.  — |

---

# Release checklist

Before `scripts/release.sh all`:

- [ ] `cd worker && npm test` green
- [ ] `xcodebuild test` green
- [ ] `scripts/smoke-release.sh` passes (Release build, launched, no fatal)
- [ ] Worker secrets set: `OPENAI_API_KEY`, `GITHUB_CLIENT_ID`,
      `GITHUB_CLIENT_SECRET`, `COMPOSIO_API_KEY`, `APNS_KEY_ID`,
      `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`
- [ ] `REVENUECAT_SECRET_KEY` set only when billing is meant to be live
- [ ] D1 migrated: `npx -y wrangler@4 d1 execute tiktokforwork --remote --file schema.sql`
- [ ] Privacy policy URL reachable and set in App Store Connect
- [ ] `PrivacyInfo.xcprivacy` present in the built `.ipa`
- [ ] Account deletion reachable within three taps of the account screen
- [ ] Screenshots and metadata committed under `metadata/` and `screenshots/`
- [ ] `asc review doctor` clean
