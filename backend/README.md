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
npm test           # vitest (17 tests)
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

- Rate limiting and request size caps at the edge
- Token encryption-at-rest for integration configs (currently plaintext in
  SQLite; documented tradeoff)
- GitHub webhook receiver for reverse sync (issue closed → card completed)
- Postgres migration path once a single SQLite writer becomes a bottleneck
  (the repo layer is already behind plain functions)
- Agent memory / context layer on top of the event log
