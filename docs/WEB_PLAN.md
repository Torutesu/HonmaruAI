# Web Client — Implementation Plan

Implementation-ready plan for `web/`. CROSS_PLATFORM.md says *what* the web client is architecturally; this says *what to build, in what order, and how we know it works*.

---

## 0. Gap analysis — verified against the current relay

Not assumptions. Each row was checked in `server/index.js`.

| # | Gap | Evidence | Impact |
|---|---|---|---|
| G1 | CORS preflight rejects `Authorization` | `index.js:505` — `Access-Control-Allow-Headers: "Content-Type"` only | **Every authenticated call fails** from a browser on another origin |
| G2 | One global OAuth redirect URI | `index.js:87` — `GITHUB_REDIRECT_URI` defaults to `tiktokforwork://oauth/callback` | Browser OAuth impossible: custom schemes don't exist on the web |
| G3 | No `state` / PKCE on OAuth | authorize URL built client-side (iOS `GitHubService`), relay only swaps `code` | CSRF-open; unacceptable for a browser redirect flow |
| G4 | GitHub access token returned to the client | `/oauth/github/token` responds `{accessToken}` | Token in browser JS = XSS-exfiltratable; iOS is fine (Keychain), web is not |
| G5 | GitHub API called directly by the client | iOS `GitHubService` → `api.github.com` | Browser: CORS-blocked on several endpoints + requires G4's token in JS |
| G6 | Push is APNs-only | `push.js` `createAPNS` | No Web Push; `/push/register` assumes a device token |
| G7 | Identity is "pick an org member" | WS `join {userId}` | Fine for a demo relay, wrong the moment the app is on a URL anyone can open |

### The decision that removes G1, G2, G4 in one move

**Serve the web app from the relay itself** (`GET /` → static `web/dist`), so the app and the API share an origin:

- **G1 disappears** — same-origin requests need no CORS at all
- **G2 becomes trivial** — redirect URI is `https://<relay>/oauth/callback`, a real URL the relay already owns
- **G4 disappears** — the GitHub token stays server-side in a session; the browser holds an `httpOnly` session cookie and never sees a token
- Deployment stays one artifact (the existing Dockerfile), one TLS certificate, one thing to run

Trade-off: the relay serves static files (a ~30-line handler, no framework). Worth it. A separate CDN origin stays possible later — it only re-opens G1 (fix: add `Authorization` + `Access-Control-Allow-Credentials` and an origin allowlist) and needs `SameSite=None` cookies.

---

## 1. Stack decisions (locked, with reasons)

| Choice | Decision | Why |
|---|---|---|
| Build | **Vite + React 18 + TypeScript** | No SSR need (the relay is the server); fastest dev loop; trivial static output |
| State | **zustand** stores mirroring the Swift services 1:1 (`cardStore`, `channelStore`, `orgStore`, `sessionStore`) | Same mental model as `DecisionCardService` etc.; no Redux ceremony |
| Styling | **CSS variables from the design tokens + CSS Modules** | `docs/demo.html` already proves the token set works in the DOM — port it verbatim; no Tailwind class-soup fighting a design system that already exists |
| A11y primitives | **Radix** (Dialog, Popover, Tabs) | Focus traps and ARIA for sheets/dialogs are not worth hand-rolling |
| Gestures | **framer-motion** `drag="x"` for card swipe | The demo does pointer-math by hand; motion gives spring-back + velocity for free |
| Realtime | Hand-written `RelaySocket` (reconnect + snapshot/delta), mirroring `WebSocketService` | ~120 lines; a library would hide the join/auth semantics we already own |
| Tests | **vitest** (stores, protocol) + **Playwright** (decision loop E2E) | Matches the relay's `node --test` discipline |

**The demo is the design prototype, not a throwaway.** `docs/demo.html` already contains the v2 token block, card markup, channel timeline, sheets, settings, and swipe behavior in DOM form. Porting it to React components is transcription, not design — this is the single biggest accelerator in the plan.

---

## 2. Directory layout

```
web/
  index.html
  vite.config.ts
  src/
    main.tsx                    app entry, theme bootstrap
    App.tsx                     routing + layout switch (mobile feed ↔ desktop workbench)
    core/                       ← the "@ttfw/core" layer, framework-agnostic
      types.ts                  DecisionCard, ChatChannel, ChatMessage, User, OrganizationGraph,
                                CardSource, RecommendationHint, InstructionDraft  (mirrors Swift)
      protocol.ts               WS envelope types + type guards for every server message
      socket.ts                 RelaySocket: connect/join/reconnect, typed event emitter
      api.ts                    RelayAPI: /ai/*, /org/*, /digest, /push, session
      stores/
        session.ts              me, relayUrl, appearance, auth state
        cards.ts                cardsByUser, snapshot/delta reducers, optimistic decide
        channels.ts             channels, messagesByChannel
        org.ts                  users, graph, language
      selectors.ts              myCards(), pendingCount(), sourcesFor(card)
    features/
      feed/                     FeedScreen, DecisionCard, SwipeLayer, RecommendationRow,
                                SourceChips, ActionBar, EmptyState
      compose/                  ComposeBar, ComposeSheet, DraftReviewSheet, Dictation
      reply/                    ReplySheet, AskAISheet, ResendSheet, RevisionSheet
      channels/                 ChannelList, ChannelTimeline, MessageRow, ChannelComposer
      org/                      OrgGraphView, UserSwitcher, AddMemberForm
      settings/                 SettingsScreen (appearance, language, connection, notifications)
      auth/                     SignInScreen, OAuthCallback
    ui/                         Button, Sheet, Chip, Toast, PrioritySlider, Segmented, Avatar
    styles/
      tokens.css                generated from design tokens (dark + light)
      base.css
    lib/
      speech.ts                 Web Speech wrapper (feature-detected)
      push.ts                   Web Push subscribe + register
```

`core/` never imports React. That boundary is what makes it portable and unit-testable, and it mirrors TTFWCore on the Swift side.

---

## 3. Relay work (Phase 0) — ✅ SHIPPED

Implemented and verified end-to-end (94 server tests green). Deviations from the original spec are noted inline.

- ✅ Static hosting (`static.js`): SPA fallback, hashed-asset immutable caching, GET+HEAD, path-traversal containment
- ✅ Sessions (`session.js`): single-use server-side `state`, httpOnly cookie, TTL + pruning, persistence
- ✅ Auth endpoints: `/auth/github/start|callback`, `/auth/me`, `/auth/session`, `/auth/signout`
- ✅ GitHub proxy (`githubProxy.js`): repos, repo selection, issue create/update/get — session token only
- ✅ Web Push (`push.js`): VAPID via `web-push`, registry now a tagged union (`ios` | `web`), shared quiet policy
- ✅ Authorization: relay token **or** session cookie, on HTTP and on WS `join`
- **Deviation — PKCE dropped**: it protects public clients; the relay is a confidential client holding the client secret and GitHub OAuth Apps don't support it. Server-side single-use `state` is the correct control here.
- **Bug found and fixed during verification**: the bearer gate sat in front of static hosting, so a browser could never load the app (it has no relay token before signing in). The gate now covers API prefixes only.

### Original specs

All server-side, all testable with `node --test` before a line of React exists.

### 3.1 Static hosting
`GET /` and unmatched non-API paths → serve `web/dist` (SPA fallback to `index.html`, correct MIME types, `Cache-Control: immutable` for hashed assets). Guard: never shadow existing API paths.
**Env**: `WEB_DIST_PATH` (default `../web/dist`), disabled if absent.

### 3.2 Session auth (G7, G4)
New in `server/session.js`:

| Endpoint | Behavior |
|---|---|
| `GET /auth/github/start` | Generates `state` + PKCE `code_verifier`, stores them in a short-lived signed cookie, 302 → GitHub authorize with `redirect_uri = <origin>/auth/github/callback` |
| `GET /auth/github/callback` | Verifies `state`, exchanges code (+ verifier), fetches `/user`, matches an org member by `githubUsername` (falls back to member picker), creates a session, sets `httpOnly; Secure; SameSite=Lax` cookie, 302 → `/` |
| `GET /auth/me` | `{ user, repository, pushEnabled }` or 401 |
| `POST /auth/signout` | Clears the session |

Sessions: `{ sessionId → { userId, githubToken, createdAt } }`, persisted like the other stores (`data/sessions.json`), TTL 30 days. **The GitHub token never leaves the relay.**

WS `join` accepts the session cookie as an alternative to `token` + `userId` (browsers can't set WS headers, but cookies ride along on same-origin connections) — the relay resolves the user from the session.

### 3.3 GitHub proxy (G5)
`POST /github/issues` (create), `PATCH /github/issues/:number`, `GET /github/issues/:number` — thin passthrough using the **session's** token and the session user's selected repo. Also `GET /github/repos` for the picker. iOS keeps calling GitHub directly (no change).

### 3.4 Web Push (G6)
- `push.js` gains `createWebPush({vapidPublicKey, vapidPrivateKey, subject})` — RFC 8291 encryption + VAPID JWT with `node:crypto` (same no-dependency approach as APNs; ~120 lines, or accept `web-push` as the one dependency if the encryption isn't worth hand-rolling — **decide at implementation time, default to the library here** since payload encryption has sharp edges)
- `/push/register` accepts `{platform: "web", subscription}` alongside device tokens; the registry keys by user, values become tagged unions
- `maybeNotify()` unchanged — **the quiet policy stays in one place** and applies to both platforms

### 3.5 CORS (only if a separate origin is ever used)
Preflight → `Access-Control-Allow-Headers: Content-Type, Authorization`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Origin: <allowlisted origin>` (never `*` with credentials).

**Phase 0 tests**: session lifecycle (start → callback → me → signout), state/PKCE rejection paths, proxy authorization (session A can't touch session B's repo), Web Push registration shape, static fallback doesn't shadow `/ai/*`. Target: **+15 tests, suite stays green** (97 total).

---

## 4. Client phases

### Phase 1 — Skeleton + realtime (foundation) — ✅ SHIPPED
Scaffold, `tokens.css`, `core/types.ts` + `protocol.ts`, `RelaySocket`, `cardStore`, and a read-only feed rendering real cards from a live relay.
**Done when**: two browser tabs signed in as different users see cards appear in real time; reconnect survives a relay restart.
**Verified**: the integration suite boots the real relay and drives it with the real client core — the built app is served at `/`, a card sent by one client lands in another's store, and a killed relay is followed by automatic reconnection and re-sync. Bundle: 50.7 KB gzip.
**Bug found and fixed**: reconnection was driven only by `onclose`, but Node/undici fires *only* `onerror` when a connection is refused — the retry loop stalled exactly while the relay was down. Both events now schedule reconnection (idempotent), with capped exponential backoff.

### Phase 2 — The decision loop (the product) — ✅ SHIPPED
Tap decide → optimistic update → GitHub Issue via proxy → result card. Reply (`/ai/reply`), Ask AI (`/ai/refine`), revise, acknowledge, one-tap recommendation. Compose bar → `/ai/ingest` → draft review → send.
**Done when**: a decision started in the browser closes in iOS and vice versa, Issue included.
**Verified**: the integration suite drives the real relay — a card created by one client is decided through `/cards/decide`, the original flips to approved for every client, and the sender receives the result card carrying the condition.

**Architectural change made here — decision resolution moved to the relay.** It lived only in `DecisionCardService.swift`: status transitions, note handling (Condition/Reason/Revision), the response card, delegation fan-out, GitHub sync. Re-implementing that in TypeScript would have created exactly the drift this plan warns about, so it now lives in `server/decisions.js` behind `POST /cards/decide`, and the web client calls it. GitHub sync happens relay-side using the session's token (the browser holds none). iOS keeps its local path and stays compatible — both converge on the same store and broadcasts — with migration as a follow-up.

**Bug caught in review**: `/cards/` wasn't in the relay's API prefix list, so the new endpoint would have bypassed the auth gate entirely. Added, with a test asserting an unauthenticated decide returns 401.

### Phase 3 — Channels + org + settings — ✅ SHIPPED
Channel list/timeline with agent styling and tool chips, `@ai` mentions, scroll-to-message provenance. User switcher, language, appearance (System/Dark/Light via `data-theme`), connection, sign out.
**Done when**: feature parity with the iOS app minus voice/push.
**Shipped**: channel store (snapshot/created/message with echo de-duplication), timeline that lands on the exact message a card's source chip points to, tab shell (Feed / Channels / ⚙), settings with appearance tiles, relay-synced language, member switching and sign out.
**Deferred to Phase 6**: org graph visualization and add-member form (both exist on iOS; the endpoints are already wired in `api.ts`).

### Phase 4 — Auth, push, PWA — ✅ SHIPPED
Sign-in screen on the session flow, Web Push subscribe + permission UX (mirroring the "we only ring for high/urgent" copy), manifest + service worker (installable, notification click → deep link to the card), Web Speech dictation where supported.
**Done when**: install to home screen, receive a push for an urgent card while the tab is closed, tap → the exact card.
**Shipped**: service worker (push → notification, click → focus the open tab and jump to the card, or cold-start via `?card=`), manifest + SVG icon, `enablePush()` with every permission state explained in Settings, and dictation on the composer and card replies — transcript editable before sending, exactly like iOS.
**Verified**: subscription registration and validation against a live relay with real VAPID keys; the integration suite asserts the manifest, service worker and icon are served with the MIME types browsers require (a wrong one silently breaks registration).
**Bug found**: `/health` reported `push` from APNs alone, so a relay with Web Push configured advertised "push off". It now reports `{apns, web}`.
**Not verifiable here**: actual push delivery needs a browser + a real push service.

### Phase 5 — Desktop workbench
≥1024px: three-column layout (sidebar / decision queue / **context panel showing the selected card's source conversation**), keyboard deciding (`J K` navigate, `⏎` approve, `⌫` decline, `R` reply, `?` shortcut sheet), `⌘K` command palette (jump to channel, switch user, run digest).
**Done when**: a full decision session is possible without touching the mouse.

### Phase 6 — Hardening
Offline read cache (IndexedDB snapshot), error/empty/loading states everywhere, `prefers-reduced-motion`, focus-visible, screen-reader labels on card actions, Lighthouse a11y ≥95, bundle < 250KB gzip, Playwright E2E in CI.

---

## 5. Estimates

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Relay: static, session/OAuth, GitHub proxy, Web Push | 1.5–2 days |
| 1 | Scaffold, core, socket, read-only feed | 1–1.5 days |
| 2 | Full decision loop | 2–2.5 days |
| 3 | Channels, org, settings | 1.5–2 days |
| 4 | Auth UI, push, PWA, speech | 1.5 days |
| 5 | Desktop workbench + keyboard | 1.5–2 days |
| 6 | Hardening, tests, a11y, CI | 1–1.5 days |
| | **Total** | **~10–13 days** — a usable web app (Phases 0–2) in **~5** |

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Type drift** between Swift and TS models | Phase 1 ships `protocol.ts` + fixture tests that decode the same JSON the relay's tests emit. Later: JSON Schema as the single source (CROSS_PLATFORM §2) |
| Web Push encryption is fiddly | Take the `web-push` dependency; the relay stays dependency-light everywhere else |
| Sessions change iOS behavior | Additive only — relay token + `userId` join keeps working; iOS untouched this cycle |
| Swipe UX on desktop | Buttons are always visible; swipe is an enhancement, never the only path (already true on iOS) |
| Scope creep into a redesign | The demo is the spec. Any visual question resolves to `docs/demo.html` + `design.md` |

## 7. Open decisions (needed before Phase 0)

1. **Hosting**: relay-served (recommended, above) vs separate CDN origin — changes auth cookie strategy
2. **Multi-user identity**: does GitHub sign-in *bind* to an org member (real accounts) or still allow demo user-switching? Recommend: bind if a `githubUsername` matches, otherwise show the picker — keeps the two-simulator demo alive
3. **Web Push**: hand-roll RFC 8291 or take `web-push` (recommend the library)
4. **Repo layout**: `web/` in this repo (recommended — one deploy, shared docs) vs a separate repo

---

## 8. Definition of done for "Web version shipped"

- A teammate opens `https://<relay>/`, signs in with GitHub, and their feed is there
- They decide a card; the iOS user who sent it sees the result within a second, and the GitHub Issue exists
- They ask their AI in Japanese; an English colleague gets the card in English
- Closing the tab still delivers an urgent decision by push; the click lands on that card
- Lighthouse ≥95 a11y, E2E green in CI, zero product logic added to the client
