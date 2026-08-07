# HonmaruAI Backend

Production-oriented backend for the AI-native decision feed. This replaces the
localhost demo relay (`../server/`) with a real service designed for
cross-platform operation: one fat server, thin clients on iOS / web / desktop /
Android.

## Why this shape

The original architecture kept business logic (card creation, GitHub sync,
state transitions) inside the Swift client, with the Node relay only forwarding
messages. That works for one client but multiplies every feature by the number
of platforms. This backend inverts it:

- **Clients send intent** (`instruction`, `card_action`) and **render state**
  (snapshot + events). They never construct cards or talk to integrations.
- **The server owns all domain logic**: routing, the card state machine, the
  org graph, auth, and external sync.
- **The protocol is schema-first**: every entity, event, and message is a zod
  schema in `@honmaru/protocol` — the single source of truth that Swift/Kotlin
  types are ported from.
- **GitHub is a plugin, not the core.** Decisions live in the server's own
  store; the `github_issues` integration mirrors finalized decisions outward.
  Other targets (Linear, Notion, Slack…) are additional implementations of the
  same `Integration` interface.

## Packages

| Package | Purpose |
|---|---|
| `packages/protocol` | zod schemas: entities, org events, WebSocket messages, REST payloads |
| `packages/server` | Hono HTTP + `ws` realtime server with SQLite persistence |
| `packages/web` | React/TS web client on the real protocol (dev login → org create/join → feed → rally → notifications) |

## Server architecture

```
clients (iOS / web / desktop / Android)
   │  REST /v1/*  +  WebSocket (hello → welcome/snapshot → events)
   ▼
http.ts (REST)        realtime.ts (Hub)
   └────────┬──────────────┘
            ▼
 domain: orgs.ts · cards.ts · routing.ts · auth.ts
            │  every write appends to the per-org event log (events.ts)
            ▼
        SQLite (WAL)
            │  committed events fan out via app.ts emitEvents
            ├──► Hub broadcast (visibility-filtered per user)
            └──► IntegrationRegistry ──► github_issues (creates/closes issues)
```

**GitHub reverse sync**: point a repository webhook (issues events, JSON,
secret = `GITHUB_WEBHOOK_SECRET`) at `POST /v1/webhooks/github`. Closing a
linked issue completes the card; reopening it re-activates the card — both
parties are notified. Cards are matched by the issue URL recorded on the
external ref, so multiple repos and orgs coexist.

Key properties:

- **Auth**: GitHub OAuth (code exchange server-side) or dev login
  (`AUTH_DEV_MODE=1`) → opaque session token (SHA-256-hashed at rest) → used as
  `Bearer` on REST and in the WS `hello`.
- **Event log**: every state change appends exactly one event with a per-org
  monotonically increasing `seq`, inside the same SQLite transaction as the
  change. Clients resume after a disconnect with `hello.sinceSeq` and receive a
  replay instead of a full snapshot. This is the only sync mechanism.
- **Visibility**: a card is delivered only to its sender and recipient; the
  event fan-out filters per connection.
- **Routing**: OpenRouter tool-call first, deterministic fallback second. Both
  are driven by org data (member names, job titles, teams, manager edges) —
  the demo-user hardcoding is gone.
- **Integrations**: run after commit, are idempotent, and can never fail a
  user-facing write. Sync policy for `github_issues`: approved → create issue,
  completed → close (completed), rejected-after-sync → close (not planned).
  Tokens are stored server-side and redacted on read.

## Rally layer (Slack-grade message frequency)

Cards are the decision container; **thread messages** are the high-frequency
back-and-forth around them (`card_message` over WS, `/v1/cards/:id/messages`
over REST). The rally path is deliberately synchronous and AI-free so a reply
lands on the other participant's screen in one round-trip. A card's sender,
recipient, and watchers can post and read its thread.

**Classic chat mode (channels + DMs)**: alongside the decision feed, the
same backend powers a traditional Slack-style layer — org-wide channels
(`#general` is created automatically), idempotent 1:1 DMs, and one-level
thread replies — on the same event log and realtime pipeline, so both
modes stay in sync. Notification semantics follow Slack: DMs always
notify, channel messages notify on @mention or thread participation. The
web client switches modes with the Feed / Chat tabs; iOS ships the same
split as a TabView.

**Chat → decision bridges**: the chat composer's ⚡ button hands the typed
text to your AI as a decision card, and ✨ Digest
(`POST /v1/channels/:id/summarize`) has the AI read the recent
conversation and deliver a digest card (decisions, action items, open
questions) to your feed — LLM-backed with a deterministic fallback.

**@Mentions + watchers**: writing `@Name` in a thread pulls that org member
into the card as a **watcher** — they gain visibility (feed + thread), get a
dedicated `card_mention` notification, and the watcher-add is an ordinary
`card_updated` event so their feed updates live. Mentions are parsed
server-side against the org roster (first or full name, case-insensitive,
author excluded).

## Two-phase AI pipeline (fast path + async refinement)

Model latency is kept out of the request path:

1. **Fast path (a few ms, sync)** — deterministic routing creates the card and
   acks immediately; the recipient sees it in real time.
2. **Refinement (async job)** — the LLM re-routes/rewrites on the `JobQueue`
   (bounded retries, exponential backoff). If it disagrees and the card is
   still untouched (pending, no thread activity), a `card_updated` event
   upgrades it in place; a re-route carries `previousRecipientUserId` so the
   old recipient's feed drops the card and the new recipient is notified.
   Refinement never overwrites a card a human has already acted on.

## Notifications

The `NotificationEngine` consumes committed events and derives per-user
notifications (assigned / status change / thread reply / re-route; never for
the actor themselves). Delivery:

- **In-app**: persisted unread inbox (`/v1/orgs/:id/notifications`,
  `/v1/notifications/read`) + instant `notification` WS frame.
- **Webhook bridge** (`NOTIFY_WEBHOOK_URL`): every notification is POSTed to a
  configured URL — the integration point for APNs/FCM relays, ntfy, or Slack
  webhooks without baking a provider into the core.
- **Device registry** (`POST /v1/devices`): APNs/FCM tokens are stored,
  ready for a direct push channel.

## Feed ranking + analytics

- `GET /v1/orgs/:id/cards` and the WS snapshot are served in **feed order**:
  pending before decided, then priority weight + waiting-time escalation +
  a boost for cards sent by your manager (`analytics.ts#cardScore`).
- `GET /v1/orgs/:id/analytics` computes decision latency (avg per org and per
  member), pending queue depth, oldest-pending age, and a **bottleneck
  ranking** (pending volume weighted by staleness) — all derived from primary
  state, recomputable at any time.

## SLA + escalation

Every card gets a decide-by deadline from its priority (urgent 2h · high 8h ·
medium 24h · low 72h; the clock follows the priority AI refinement settles
on). A periodic sweep (`SLA_SWEEP_SECONDS`, default 60) escalates overdue
pending cards exactly once: priority bumps to urgent (top of the feed), the
recipient gets a `card_overdue` notification, and the recipient's manager is
looped in via the org graph's `manages` edge.

## Web client (`packages/web`)

React client wired to the real protocol. Slack-style three-pane layout,
light-first (dark follows the OS): a sidebar with Inbox / Sent / Watching /
All views, the member roster with presence, and invites; a compact ranked
card list with inline approve/decline/changes/delegate and due/overdue
chips; and a right-hand thread panel with quick replies and one-tap
@mention buttons (mentions are highlighted and pull members in as
watchers). Notification popover with unread badge; WS auto-reconnect with
cursor resume.

```bash
npm run dev -w @honmaru/server   # API on :8081 (AUTH_DEV_MODE=1)
npm run dev -w @honmaru/web      # Vite on :5173 (proxies to :8081 by origin)
```

Browser end-to-end check (starts server + built client, drives two Chromium
sessions through org setup → instruction → rally → approval):

```bash
npm run build && npx tsx packages/web/scripts/e2e.mts
```

## Card state machine

```
pending ──approve──► approved ──complete──► completed
   ├──reject──► rejected (deletable by sender/recipient)
   ├──request_revision──► revised
   └──delegate──► delegated (spawns a new pending card for the delegatee,
                             linked via parentCardId)
```

Only the recipient can act on a card; only sender/recipient can delete.

## Run

```bash
cd backend
npm install
cp packages/server/.env.example packages/server/.env   # then edit
npm run dev        # tsx watch
npm test           # vitest (25 tests)
npm run smoke -w @honmaru/server   # boots server, drives 2 WS clients end-to-end
npm run build && npm start
```

With no env at all it boots in a useful state: dev login enabled, deterministic
routing, SQLite at `data/honmaru.db`.

## Quick demo (two users, curl)

```bash
TOKEN_A=$(curl -s localhost:8081/v1/auth/dev -d '{"name":"Alice"}' | jq -r .token)
ORG=$(curl -s localhost:8081/v1/orgs -H "Authorization: Bearer $TOKEN_A" \
  -d '{"name":"Acme","title":"PM"}' | jq -r .org.id)
CODE=$(curl -s localhost:8081/v1/orgs/$ORG/invites -X POST \
  -H "Authorization: Bearer $TOKEN_A" -d '{}' | jq -r .code)
TOKEN_B=$(curl -s localhost:8081/v1/auth/dev -d '{"name":"Bob"}' | jq -r .token)
curl -s localhost:8081/v1/invites/accept -H "Authorization: Bearer $TOKEN_B" \
  -d "{\"code\":\"$CODE\",\"title\":\"Engineer\"}"
curl -s localhost:8081/v1/orgs/$ORG/instructions -H "Authorization: Bearer $TOKEN_A" \
  -d '{"text":"tell Bob to fix the login bug urgently"}'
```

## Deploy

Single-image deployment: the server also serves the built web client (SPA
fallback included), so one container = API + WebSocket + web app.

```bash
cd backend
docker build -t honmaru .
docker run -p 8080:8080 -v honmaru-data:/data -e AUTH_DEV_MODE=1 honmaru
```

Fly.io: copy `fly.toml.example` to `fly.toml`, then `fly launch --no-deploy`,
create the `honmaru_data` volume, set secrets, `fly deploy`. SQLite lives on
the mounted volume; keep `min_machines_running = 1` so WebSocket sessions and
the SLA sweeper stay alive. Point the iOS app at the deployed host via
`AppConfig.backendHTTP`/`backendWS`.

Local equivalent (no Docker): `npm run build && npm start` — if
`packages/web/dist` exists it is served automatically.

## Client migration plan

The legacy relay (`../server/`) still runs the current iOS app unchanged.
Migration order:

1. **iOS**: point `WebSocketService` at the new WS protocol (`hello` with the
   session token from `/v1/auth/*`), delete client-side card construction and
   `GitHubService`'s issue-writing path (read-only display of
   `externalRefs` remains), and port `@honmaru/protocol` shapes to `Codable`
   structs. Status strings are unchanged on purpose.
2. **Web**: new React/TypeScript client imports `@honmaru/protocol` directly —
   zero drift by construction. Desktop wraps it with Tauri/Electron.
3. **Android**: Kotlin data classes ported from the same protocol package.
4. Retire `../server/` once iOS is migrated.

## Deliberate next steps (not yet built)

- Direct APNs/FCM channel on top of the device registry (webhook bridge
  covers push today)
- Table-backed job queue if a job ever becomes the source of truth
  (in-process queue loses jobs on restart; refinement is recoverable)
- Rate limiting and request size caps at the edge
- Token encryption-at-rest for integration configs (currently plaintext in
  SQLite; documented tradeoff)
- GitHub webhook receiver for reverse sync (issue closed → card completed)
- Postgres migration path once a single SQLite writer becomes a bottleneck
  (the repo layer is already behind plain functions)
- Agent memory / context layer on top of the event log
