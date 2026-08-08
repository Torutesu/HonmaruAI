# TikTok for Work — Real Product Rebuild (Cloudflare, mobile-first)

Date: 2026-08-08
Status: Approved design, pre-implementation

## Goal

Turn the current demo build into a real product running on real data. Today the
app relies on seeded Decision Cards, a demo org, a persona picker, and a
`127.0.0.1:8080` Node relay with in-memory/JSON state — none of which a real
device or TestFlight user can use. After this work, every card, org member, and
decision is real: produced by GitHub-authenticated users talking to their AI,
routed to real teammates, synced to real GitHub, and persisted in a hosted
Cloudflare backend.

Two hard requirements sit alongside the rebuild:

1. **English default UI, with an in-app Japanese toggle.**
2. **Cloudflare backend**, designed client-agnostically for future
   cross-platform clients but with **only the iOS client built now**.

## Decisions (locked)

- **Scope of change:** Productionize the existing codebase (not a from-scratch
  rewrite). Reuse iOS assets and the server's core routing logic.
- **Backend:** Cloudflare Workers + Durable Objects + D1. Port the existing
  Node `server/` core logic onto the Workers runtime; replace only the
  HTTP/WS/filesystem layers.
- **Identity:** GitHub OAuth is the sole login. No persona picker, no default
  user.
- **Org unit:** A GitHub **repository's collaborators** form the org (smaller and
  more certain than a whole GitHub org).
- **AI:** OpenAI unified for routing/card generation; keyword router kept as
  fallback only.
- **AI provider precedence:** `OPENAI_API_KEY` when set; otherwise keyword
  fallback. (OpenRouter path retired from the product; may remain as dev-only.)
- **Feature scope:** Core only — Decision Card feed, AI input, org graph, GitHub
  sync, AG-UI realtime. Remove the Slack-style Classic view and camera/video
  capture.
- **Clients:** iOS only now; backend stays client-agnostic for later web/Android.

## Architecture

```
iOS (SwiftUI) ──HTTPS/WSS──► Cloudflare Worker ┌─ Durable Object (one per org): WS fanout, live card state
   │ GitHub OAuth (token swap in Worker)        ├─ D1 (SQLite): users/orgs/memberships/agents/cards/sessions
   └ English default + Japanese toggle          ├─ OpenAI API (Secrets)
                                                └─ GitHub REST (Issues/Projects)
```

### Worker (fetch handler)

Client-agnostic HTTP/JSON API. Endpoints (ported/renamed from `server/index.js`):

- `GET  /health`
- `GET  /oauth/github/config` — client id + scope + redirect for the app.
- `POST /oauth/github/token` — code→token swap; client secret stays in the
  Worker. Issues an app session token bound to the GitHub user.
- `GET  /agui/tools` — AG-UI tool manifest (unchanged shape).
- `POST /ai/route` — instruction + org graph → intent, recipient, structured
  Decision Card. OpenAI first, keyword fallback.
- `GET  /orgs/:repo/members` — build the org graph from repo collaborators.
- `POST /orgs/:repo/join` — record membership + provision the user's agent.
- Card mutations (approve/reject/delegate/revise) flow over the WebSocket via
  the existing AG-UI `submit_decision` tool, not REST. The DO persists them to
  D1 and broadcasts the result. No separate REST mutation endpoint.

WebSocket upgrade requests (`Upgrade: websocket`) are forwarded to the org's
Durable Object.

### Durable Objects (relay, one per org)

- Keyed by org id (the repo full name). Holds the org's live WebSocket
  connections using `WebSocketPair` + the hibernation API (cheap on free tier).
- On `join {protocol: "agui/1"}`: authenticate the session, send a snapshot of
  the org's open cards + context (read from D1), register presence.
- Broadcasts AG-UI events (`upsert`, `decision`, `rollback`, `presence`,
  `context_updated`) to the org's members.
- Writes card state changes through to D1 so snapshots survive DO eviction.
- Reuses `server/agui/{tools,events,adapter}.js` logic; the adapter's in-memory
  store is replaced by D1-backed reads/writes.

### D1 schema (SQLite)

Replaces in-memory state and `server/data/*.json`.

- `users(github_id PK, login, name, avatar_url, locale, created_at)`
- `orgs(id PK = repo_full_name, name, created_at)`
- `memberships(org_id, user_github_id, role, created_at, PK(org_id,user))` —
  `role` seeded from repo permission (admin→approver), editable in-app.
- `agents(id PK, org_id, user_github_id, display_name)` — one agent per member.
- `decision_cards(id PK, org_id, from_user, to_user, type, priority, title,
  summary, context, status, decision, github_issue_number, created_at,
  decided_at)`
- `sessions(token PK, github_id, github_access_token, created_at, expires_at)` —
  the GitHub access token is stored server-side; the client holds only the app
  session token.

### AI routing (OpenAI)

`/ai/route` prompts OpenAI with the instruction and the org graph (real members
+ roles) and requires a structured result: `{ intent, recipient_github_id,
card: {type, priority, title, summary, context} }`. The recipient must be a real
member. Card text is generated in the reader's locale. If `OPENAI_API_KEY` is
unset or the call fails, fall back to the existing keyword router
(`server/agentTools.js`). The receiving side reshapes the card for the
recipient's role before delivery.

### GitHub sync (real)

On decision finalize, sync to the chosen repo's Issues (existing
`GitHubService` / Issues API): create/update an Issue for the decision;
delegate → reassign assignee; approve → label + comment; revise → comment.
`github_issue_number` is stored on the card.

## iOS changes

### Remove (scope trim)

- Slack-style Classic: `ClassicListView`, `ClassicChannelView`, `SlackPalette`,
  `HomeSegmentedControl`.
- Camera/video: `CameraViewfinder`, `CaptureView`, `VideoRecorder`,
  `MediaUploader`, `MediaStore`, `CardVideoView`, `Models/CaptureRequest`.
- Demo seeds: `Data/DemoData` persona/seed content, `FirstRunFlags.seededFeed`,
  the persona picker path, `AppConfig.defaultUser`/`DemoUser`.

### Change

- **Auth is the entry point.** No feed without GitHub login. After login →
  repo/org selection (reuse the repo picker) → the org graph loads from real
  collaborators.
- **`AppConfig.relayURL` default** → the hosted Workers `wss` URL. Keep the
  `-RelayURL` launch-arg and Info.plist override for dev.
- **Empty feed state**: "No decisions yet — tell your AI something, or wait for
  a teammate." Cards arrive only from real routing.
- **Onboarding** collapses: value → mechanism → GitHub sign-in (required) →
  repo/org select. The interactive swipe demo may stay as a gesture teach using
  a throwaway card, not seeded feed content.
- Keep: Decision Card feed, `AIInputSheet`, `OrgGraphView`, `ConnectGitHubSheet`,
  `DelegatePickerSheet`, `SourceSheet`, AG-UI decode path.

### Localization (English default + Japanese)

- `Localizable.xcstrings`: English as the base/source language; Japanese as a
  secondary translation. Audit for any Japanese-hardcoded strings introduced in
  the demo commits and move them into the catalog with English defaults.
- Settings gains a **language toggle**: System / English / Japanese, persisted
  and applied at runtime (locale override).
- Server-generated card text follows the reader's locale (already partially
  present); the app passes its effective locale to `/ai/route`.

## Deployment

- **Cloudflare**: `wrangler` project with `[[d1_databases]]` and
  `[[durable_objects]]` bindings. Secrets via `wrangler secret put`
  (`OPENAI_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). Public URL on
  `*.workers.dev` (custom domain optional). Free tier throughout.
- **GitHub OAuth app**: callback stays `tiktokforwork://oauth/callback`;
  homepage/redirect updated to the Workers URL.
- **iOS**: point `relayURL` at the Workers URL; ship to TestFlight.
- `web/index.html` reference client is dropped from the product (kept as a dev
  tool only, if at all).

## Implementation phases

Each phase is independently shippable and testable.

1. **Backend port** — Workers fetch handler + Durable Object relay + D1 schema.
   Port core logic from `server/`. Deploy; obtain the public URL. Verify health,
   OAuth config, and a WS join/snapshot round-trip.
2. **Auth & org (real)** — GitHub-only identity in D1; org graph from repo
   collaborators; membership/agent provisioning; remove persona/default user.
3. **AI (OpenAI)** — unified routing producing real cards from the real org
   graph; keyword fallback.
4. **iOS rebuild** — remove seeds + trimmed features; empty states; connect to
   hosted Workers URL; auth-first flow.
5. **Localization** — English base + Japanese; settings language toggle;
   locale passed to the API.
6. **Ship** — TestFlight build; update README/PROGRESS/design docs to reflect
   the real (non-demo) product.

## Out of scope (now)

- Web and Android clients (backend stays client-agnostic to allow them later).
- Email/invite signup (GitHub is the sole identity).
- GitHub Projects/Discussions/PR sync beyond Issues (Issues only for v1).
- Rich media on cards (camera/video removed).

## Success criteria

- Two real people sign in with GitHub on separate devices, land in the same
  repo-based org with a real org graph, and see no seeded content.
- Person A instructs their AI in natural language; OpenAI routes a real Decision
  Card to Person B; B decides; the result reflects back to A in realtime and
  syncs to a real GitHub Issue.
- State survives backend restarts (D1-backed), reachable from TestFlight over
  `wss`.
- UI is English by default; the Japanese toggle switches the app and card text.
