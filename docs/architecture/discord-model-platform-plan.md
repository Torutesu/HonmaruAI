# Platform plan: the Discord model

Status: **Accepted direction, PoC pending** · Owner: platform · Last updated: 2026-09-30

This document fixes the long-term technical shape of HonmaruAI across clients and
the data plane. It is written so that every decision can be checked against two
questions the product owner asked:

1. Does it stay cheap as we scale (1k → 100k active users and beyond)?
2. Does it avoid becoming debt (no rewrite needed at 10× or 100×)?

It ends with a PoC whose acceptance criteria decide go / no-go before any large
migration starts.

The path from today's system to this one — scale targets per stage, and the
security and scale gaps to close before selling to other companies — is in
[security-and-scale-hardening.md](security-and-scale-hardening.md).

---

## 1. Decision summary

| Area | Decision | Rejected alternatives |
| --- | --- | --- |
| Mobile (iOS + Android) | **Expo / React Native** (New Architecture, dev client, EAS Build) | Native Swift + Kotlin (Slack model: two codebases, two teams); Flutter (no sharing with our React web); Kotlin Multiplatform (no sharing with web) |
| Web | **React** (existing `web-react`, moved to `apps/web`) | react-native-web for the main UI (Discord shares logic, not views; web UX stays best-in-class) |
| Desktop | **Electron** shell around `apps/web` | Tauri 2 (no push notifications, webview differs per OS, WebRTC gaps on Linux) |
| Shared code | **`packages/core` (TypeScript)**: API client, relay client, stores, sync, i18n, routes, markdown, mentions | Copying logic per platform (what we do today: ~14 duplicated subsystems) |
| API contract | **`packages/protocol`**: zod schemas shared by Worker and clients | Hand-written types on each side; raw `fetch` (≈90 call sites on web today) |
| Workspace data | **One Durable Object (SQLite) per workspace** — messages, cards, reads, members snapshot, schedules | Single D1 (10 GB hard cap, single writer for all tenants); Postgres + sharding (Slack/Vitess model: ops burden) |
| Global data | **D1**: users, sessions, directory (user → workspaces), tokens/codes, billing | — |
| Blobs | **R2**, every key prefixed with `org/<orgId>/` | Unprefixed keys (today's `MEDIA`) |
| Async work | **Queues** (push, fan-out, projections) + **DO alarms** (per-workspace schedules) + **Workflows** (multi-step sagas: account deletion, exports) | Global cron scanning every tenant every minute (today) |
| Monorepo | **pnpm workspaces + Turborepo** | Nx (heavier), separate repos (contract drift) |

The guiding principle is the one Discord landed on: **share the logic, render
natively per platform, and partition data by the unit of collaboration** (a guild
for Discord, a workspace for us).

---

## 2. Where we are today

| Layer | Today | Problem at scale |
| --- | --- | --- |
| Worker | ~31k lines, ~230 endpoints, `env.DB` referenced 1,167 times | Every tenant shares one SQLite writer |
| D1 | 97 tables in one database | 10 GB hard cap; all tenants contend for one writer; noisy neighbours; tenant isolation depends on every query remembering `org_id` |
| Durable Objects | `OrgRelay` (hibernating WebSockets per org), `AgentRunner` (KV job queue). Both are SQLite classes but neither uses `storage.sql` | Fine; we already pay for the right primitive and don't use it |
| Crons | `*` (every minute) and `*/15` scan all tenants | Cost and latency grow with total tenants, not active ones |
| R2 | `MEDIA` keys not org-prefixed; `AUDIT_ARCHIVE` is | Cannot export / delete / residency-pin a tenant's blobs by prefix |
| Web | React/Vite, ~22.7k lines, almost no API layer | Logic trapped in components (`ClassicList.tsx` is 3,865 lines) |
| iOS | SwiftUI, ~22k lines, typed services | Duplicates web logic; no Android; no universal links, no Sign in with Apple, no notification extensions |
| Tables growing without bound | `card_events`, `cards`, `ai_calls`, `message_translations`, `channel_journal`, `ai_suggestions` | Storage cost and query time grow forever |
| Secrets in plaintext columns | `org_ai_settings` keys, `org_github.token`, `sessions.github_access_token`, `org_webhooks.secret` | Blast radius of a DB read bug or leaked export |

---

## 3. Target architecture

```
                      ┌──────────────── clients ────────────────┐
                      │ apps/mobile (Expo)  apps/web  apps/desktop│
                      │          └──── packages/core ────┘        │
                      │                packages/protocol          │
                      └──────────────┬───────────────┬────────────┘
                                HTTPS│               │WebSocket
                      ┌──────────────▼───────────────▼────────────┐
                      │  Edge Worker (router, auth, rate limits)   │
                      │  - verifies access token (no DB hit)       │
                      │  - derives orgId from verified membership  │
                      └──┬────────────┬──────────────┬────────────┘
                         │            │              │
               ┌─────────▼───┐  ┌─────▼────────┐  ┌──▼───────────────┐
               │ D1 (global) │  │ WorkspaceDO  │  │ RelayDO shards    │
               │ users       │  │ (1 per org)  │  │ hibernated WS     │
               │ sessions    │  │ SQLite:      │  │ fan-out           │
               │ directory   │  │  channels    │  └──────────────────┘
               │ tokens/codes│  │  messages    │
               │ billing     │  │  cards, reads│──outbox──► Queues ──► push (APNs/FCM/WebPush)
               └─────────────┘  │  members     │                 └──► D1 projections
                                │  schedules   │                 └──► Vectorize / AI jobs
                                │  FTS5 index  │
                                └──────┬───────┘
                                       │ alarms (per-workspace schedule)
                                       ▼
                                R2: org/<orgId>/…   (media, exports, cold archive, audit)
```

### 3.1 Request path

1. Client calls `https://api…/v2/w/<orgId>/…` with a short-lived **access token**
   (signed, 15 min TTL, claims: `sub`, `sid`, `exp`). The Worker verifies the
   signature locally — no D1 read on the hot path.
2. The Worker resolves `env.WORKSPACE.idFromName(orgId)` and forwards the request.
   The **DO checks membership itself** from its own `members` table (authoritative,
   see §4.3). A forged `orgId` therefore reaches a DO that says "not a member".
3. Refresh tokens live in D1 (`sessions`). Revocation: session end writes a
   revocation into D1 and publishes `session.revoked(sid)` to the user's workspace
   DOs via Queue; DOs keep a small revoked-sid set until the token TTL passes.
   Worst-case revocation latency: seconds (queue), bounded by 15 min (TTL).

### 3.2 IDs

- All new IDs are **UUIDv7** (time-sortable, generated by the writer, no global
  sequence). Existing IDs are kept as-is.
- Anything addressable from outside a workspace carries the `orgId` in its URL
  (`/w/<orgId>/files/<fileId>`), so no global "which workspace owns id X" table is
  needed. The few legacy global lookups (`/files/:id`, `users.inbound_token`) get a
  D1 directory row during migration and are retired afterwards.

---

## 4. Data plane

### 4.1 What lives where

| Store | Tables / data | Why |
| --- | --- | --- |
| **WorkspaceDO SQLite** | channels, channel_messages, message_reactions, threads, channel_reads, activity_reads, cards, card_events, businesses, routines, scheduled_messages, saved_items, drafts, canvas, bookmarks, emoji metadata, webhooks, members snapshot, invites (workspace side), audit hot buffer, FTS5 index, retention / legal-hold settings, outbox | Everything read and written together inside one workspace; single writer per tenant; isolation by construction |
| **D1 (global)** | users, sessions, session_workspaces, login_codes, sso_states / handoffs, api_tokens (hash → orgId), org_domains, directory (`memberships_dir`: user → org, role), orgs registry (name, plan, region, store=`d1`/`do`, schema version), device_tokens, push_subscriptions, entitlements, ai_usage rollups, connector_config, kv | Needed before you know the workspace (login, token lookup, "which workspaces am I in", billing) |
| **R2** | `org/<orgId>/media/…`, `org/<orgId>/exports/…`, `org/<orgId>/archive/<table>/<yyyy-mm>.jsonl.gz`, `audit/<org>/…` (unchanged) | Cheap, zero egress, prefix = tenant |
| **Vectorize** | one namespace per workspace | Tenant-isolated semantic search |
| **Analytics Engine** | per-workspace usage events (requests, rows, storage, AI tokens) | Cost per tenant, abuse detection, billing input |

Directory-style tables that are looked up **without** an org today
(`api_tokens`, `org_keys`, `org_domains`, `sso_*`, `invites`, `agent_invites`,
`ingested_items`, `connector_sync_state`, `app_connections`, `push_queue`) are
split: the **lookup key → orgId** row stays in D1; the payload moves to the DO.

### 4.2 WorkspaceDO internals

- Schema versioned with `PRAGMA user_version`; migrations run inside
  `blockConcurrencyWhile` on first access after deploy. Because a deploy updates
  every DO at once, **every migration is expand → migrate → contract** across at
  least two deploys (never drop / rename in the same deploy that stops using it).
- Every row that belongs to a channel carries `channel_id`, and every query is
  keyed by it. This is what makes channel-level sharding (§6.1) a mechanical move,
  not a redesign.
- In-memory caches (members, channel list, unread counters) are rebuilt from SQLite
  on wake; SQLite is always the source of truth.
- **Write coalescing**: read receipts (`channel_reads`) and presence are held in
  memory and flushed once per few seconds / on alarm. This is the single biggest
  rows-written saving (see §5).
- **Outbox**: any side effect (push, D1 projection, webhook, embedding job) is
  written to an `outbox` table in the same transaction as the change, then drained
  by alarm into Queues. Consumers are idempotent (keyed by outbox id). No lost or
  double side effects across crashes.

### 4.3 Membership authority and member snapshots

- The DO's `members` table is **authoritative** for membership, role and guest
  status inside the workspace (every request checks it anyway).
- D1 `memberships_dir` is a **projection** fed by the outbox (for "list my
  workspaces", login routing, account export/deletion fan-out).
- User profile fields used for display (name, avatar, locale) are **snapshotted**
  into `members`. A profile change in D1 enqueues `user.updated` to each of the
  user's workspaces. This replaces today's 44 `JOIN users`.

### 4.4 Scheduling without global scans

| Today (global cron) | Target |
| --- | --- |
| Every minute: due `scheduled_messages`, `saved_items` reminders, `sendDuePushes`, `deliverStreams` | Each DO keeps a `schedule` table; its single alarm is always set to `MIN(due_at)`. Pushes go through Queues (batched consumer) |
| Every 15 min: `runDueRoutines`, `moveDailyToDailyChannel`, `remindDailyDrafts`, `runScheduledSync`, `sweepAppConnections`, `checkSsoGrants` | Routines / daily reports / reminders: DO schedule rows. Connector sync: per-workspace schedule row that enqueues a sync job. SSO grants: D1-side job (global data) |
| Daily: `pruneAudit`, `pruneMessages`, `expireExports`, `warnExpiringKeys`, `recheckDomains` | Retention: DO schedule row (§7). Keys / domains: stay global cron (small, D1-only) |
| Hourly `sealPending`, weekly `weeklyVerify` | Stay global (audit chain) but iterate only workspaces with activity (`orgs.last_active_at`) |

A single global safety cron (hourly) wakes DOs whose `orgs.next_wake_at` is in the
past by more than 10 minutes (alarm lost / code bug). Alarms are durable and retried
by the platform; the safety cron is belt-and-braces and alerts when it fires.

### 4.5 Search

- **Keyword**: SQLite FTS5 table per workspace, maintained in the write
  transaction. Cold (archived) messages are searchable through a coarse monthly
  index in R2 only on explicit "search older" requests.
- **Semantic**: Vectorize, one namespace per workspace (tenant isolation by
  construction). Embedding jobs go through the outbox → Queue, batched.
- **Cross-workspace search** (a user in several workspaces) is a client-side or
  Worker-side fan-out to the user's DOs, capped (e.g. 10 workspaces, 20 hits each).

### 4.6 R2 layout

```
org/<orgId>/media/<fileId>            uploads, attachments
org/<orgId>/emoji/<name>              custom emoji
org/<orgId>/icon                      workspace icon
org/<orgId>/jam/<jamId>/…             Jam assets
org/<orgId>/exports/<exportId>.zip    compliance / admin exports (lifecycle: 7 days)
org/<orgId>/archive/<table>/<yyyy-mm>.jsonl.gz   cold tier
org/<orgId>/backup/<yyyy-mm-dd>.sqlite.gz        nightly logical backup
user/<userId>/avatar                  user-level (global) blobs
audit/<orgId>/YYYY/MM/DD/HH.jsonl.gz  (unchanged, AUDIT_ARCHIVE bucket)
```

Status: message files and compliance exports are written under `org/<orgId>/`
(`worker/src/files.js` `fileKey`); files stored before are still read from `file-<id>`.
Emoji, icons, avatars and Jam recordings keep their stored keys until the workspace
move.

Lifecycle rules: exports 7 days; backups 90 days (Infrequent Access after 30);
archives follow workspace retention.

---

## 5. Cost model

Prices (Workers Paid, Sept 2026): Workers $5/mo incl. 10M req + 30M CPU-ms, then
$0.30/M req and $0.02/M CPU-ms. DO: $0.15/M req (1M incl.), $12.50/M GB-s (400k
incl.), rows read $0.001/M (25B incl.), rows written $1.00/M (50M incl.), storage
$0.20/GB-mo (5 GB incl.). D1 storage $0.75/GB-mo. R2 $0.015/GB-mo, Class A $4.50/M,
Class B $0.36/M, zero egress. Queues $0.40/M ops (3 ops/message). WebSocket
messages *to* a DO are billed 20:1; hibernation means idle sockets cost nothing;
auto-response pings are free.

### 5.1 Per active user per month (assumptions)

| Driver | Assumption |
| --- | --- |
| API requests (Worker) | 3,000 (≈100/day) |
| DO requests | 3,000 + inbound WS messages / 20 |
| DO wall time | 20 ms × 128 MB per request → 0.0026 GB-s ⇒ ~8 GB-s |
| Rows written | 5,000 (≈50 writes/day × ~3 rows incl. indexes/FTS, with read-receipt coalescing) |
| Rows read | 300,000 |
| DO storage growth | +3 MB/month (messages + FTS + cards) |
| R2 media growth | +20 MB/month |
| Pushes | 50/day → 1,500 Queue messages |

### 5.2 Monthly totals (after 12 months of accumulated storage)

| Item | 1k active | 10k active | 100k active |
| --- | ---: | ---: | ---: |
| Workers base | $5 | $5 | $5 |
| Worker requests + CPU | $0 | $8 | $117 |
| DO requests | $0.30 | $4 | $45 |
| DO duration | $0 | $0 | $5 |
| DO rows written | $0 | $0 | $450 |
| DO rows read | $0 | $0 | $5 |
| DO storage (36 MB/user) | $6 | $71 | $719 |
| R2 media (240 MB/user) + ops | $4 | $40 | $400 |
| Queues (push, projections) | $2 | $18 | $180 |
| D1 global (small) | $0 | $1 | $10 |
| **Infra total** | **≈ $17** | **≈ $150** | **≈ $1,940** |
| **Per active user** | $0.017 | $0.015 | $0.019 |

For comparison, keeping everything in D1 is not an option past ~10k users (10 GB
cap), and D1 storage alone at 100k users would be ~$2,700/mo at $0.75/GB.

### 5.3 What actually dominates, and the guard rails

1. **AI inference** (OpenAI / OpenRouter / Gemini) will be 10–100× the infra line.
   Guard rails: per-workspace monthly budget in `entitlements`, metered in
   `ai_usage`, cheap-model routing for classify / summarize, cache
   `message_translations` by content hash, prompt caching.
2. **Rows written** is the dominant DO line. Guard rails: coalesce reads/presence,
   don't write per-event audit rows on the hot path (buffer + flush to R2), keep
   indexes minimal, measure rows-per-message in the PoC (target ≤ 6).
3. **Storage** grows forever unless pruned → §7 retention and cold tier to R2
   ($0.015 vs $0.20 per GB).
4. **Per-tenant cost visibility**: every DO emits usage to Analytics Engine so a
   single abusive workspace is visible within an hour.

Client-side fixed costs: EAS $19–$199/mo (or self-hosted builds on CI), Apple
Developer $99/yr, Google Play $25 once, Windows signing (Azure Trusted Signing
~$10/mo, or an EV certificate ~$300/yr).

---

## 6. Where it breaks, and the planned answer

| Limit | When we hit it | Planned answer (designed in now, built when needed) |
| --- | --- | --- |
| ~1,000 req/s per DO (single thread) | A workspace with ~5k simultaneously active members | §6.1 channel shards + relay shards; reads served from client cache + relay deltas |
| 10 GB per DO | ~10M messages incl. FTS in one workspace | Cold tier to R2 (§7); channel shards split storage |
| WebSocket fan-out from one object | Thousands of sockets per workspace | RelayDO shards by `hash(userId) % N`; workspace publishes one message per shard (Discord's relay pattern) |
| Large-workspace "everyone online" events | Presence storms | Discord's passive vs active sessions: only channels a client is viewing get full events; others get unread counters |
| D1 single writer (global) | Login storms, rate limits | Access tokens verified without D1; `rate_limits` table replaced by the Workers Rate Limiting binding; D1 read replicas (Sessions API) for directory reads |
| Cross-tenant analytics | Admin dashboards, growth metrics | Analytics Engine + R2 (Iceberg / R2 Data Catalog) — never scan DOs |
| Deploys drop every WebSocket | Every deploy | §9.3 resume protocol; gradual Worker rollouts |
| Cloudflare lock-in | Pricing or policy change | Store layer is an interface; each workspace is a portable SQLite database (export = file); escape hatch is schema-per-tenant Postgres |

### 6.1 Large-workspace sharding

```
WorkspaceDO(org)            members, channels, roles, settings, schedules, router
  └─ ChannelShardDO(org, c) messages, reactions, threads, FTS for hot channels
RelayDO(org, shard k)       sockets for users where hash(user) % N == k
```

Trigger: a workspace sustains > 300 req/s or > 5 GB. Channels are moved one at a
time (copy by `channel_id`, dual-read, flip routing row in WorkspaceDO). Because
every row and query is already channel-keyed (§4.2), this is a data move, not a
schema change. Until a workspace hits the trigger, everything lives in one DO.

---

## 7. Retention and pruning

| Table | Policy | Tier |
| --- | --- | --- |
| channel_messages | Workspace retention setting (default: keep). > 12 months → archive to R2, keep a stub row for threads/links | hot → cold |
| card_events | Kept: the record of who decided what (account deletion anonymizes, never deletes). Archived to cold only with the workspace move | hot → cold (M4) |
| cards | Never deleted automatically (business records); closed > 12 months archived | hot → cold |
| ai_calls | 400 days (spend charts read ≤ 90) — `worker/src/retention.js` | delete |
| message_translations | 60 days; a cache checked against the source hash | delete |
| channel_journal | 365 days of daily summaries | delete |
| ai_suggestions | 7 days (fresh for 6 hours) | delete |
| push_queue | 1 day (unchanged) → replaced by Queues | — |
| activity_reads | 35 days (unchanged) | delete |
| webhook_deliveries | last 50 per webhook (unchanged) | delete |
| workspace_activity | 30 days (unchanged) | delete |
| exports | 7 days (R2 lifecycle) | delete |

**Legal hold** (per workspace, channel or user) overrides every delete/archive rule
above; it is checked inside the DO's retention job, so it cannot be bypassed by a
global cron.

---

## 8. Security and compliance

### 8.1 Tenant isolation by construction

- Workspace data is physically in the workspace's DO. A bug that forgets
  `WHERE org_id = ?` can no longer read another tenant — the other tenant's rows are
  not in that database.
- The remaining risk moves to **routing**: the DO id must come from the URL and be
  checked against the DO's own `members` table, never trusted from a body field.
  One helper (`workspaceStub(env, orgId)`) is the only way to get a stub; a lint
  rule forbids `idFromName` elsewhere and forbids `env.DB` in workspace modules.
- Existing rules carry over unchanged into the DO: `isPersonal` / `visibleToSql` /
  `visibility: "team"`, `mayReadCard`, guest restrictions, per-workspace sign-out.
- Vectorize namespace and R2 prefix are both derived from the same `orgId`.

### 8.2 Secrets

- The plaintext columns listed in §2 move to envelope encryption: a master key in
  Workers Secrets (versioned), a per-workspace data key sealed by it, AES-GCM with
  the column name and orgId as associated data. Existing `seal` helpers (already
  used for SSO secrets and audit stream secrets) are generalized.
- Key rotation: new writes use the new key version; a background job re-seals.
- Implemented in `worker/src/secrets.js` (`DATA_KEY`, generated once by the deploy
  workflow). Rows written before it are read as they are and sealed by the
  15-minute cron.
- Access tokens and refresh tokens are stored as hashes only.

### 8.3 Data residency

Enterprise workspaces can be created in a DO jurisdiction (`eu`, `fedramp`) via
`env.WORKSPACE.jurisdiction("eu")`; the orgs registry records the jurisdiction so
routing picks the right namespace. R2 buckets with EU jurisdiction hold their blobs.
This is designed in now (registry column, stub helper) and turned on per customer.

### 8.4 Compliance operations

| Operation | How |
| --- | --- |
| Workspace export | DO streams its tables to `org/<orgId>/exports/…` in R2 |
| Account export (all workspaces) | Workflows saga: fan out to each workspace in `memberships_dir`, collect, zip |
| Account deletion | Workflows saga with durable steps: revoke sessions → each DO pseudonymizes the member (audit keeps a pseudonym, content per workspace policy) → D1 user row → R2 `user/<id>/` |
| Workspace deletion | DO `deleteAll()` + R2 prefix delete + D1 registry tombstone, after a 30-day grace |
| Audit | Unchanged hash chain + `AUDIT_ARCHIVE`; hot buffer lives in the DO |

---

## 9. Operations

### 9.1 Observability

- Workers Logs + Tail Worker for errors; request logs tagged with `orgId`,
  `route`, `do_ms`, `rows_read`, `rows_written`.
- Analytics Engine per workspace: requests, rows, storage, sockets, AI tokens.
- Alerts: DO "overloaded" errors, DO storage > 7 GB, alarm lag > 10 min (safety
  cron fired), outbox depth > 1,000, Queue DLQ non-empty, push failure rate > 5 %.

### 9.2 Backups and disaster recovery

| Data | Mechanism | RPO / RTO target |
| --- | --- | --- |
| WorkspaceDO | Built-in PITR (30 days, bookmarks) + nightly logical backup to R2 (90 days) | RPO ≈ seconds (PITR) / RTO < 15 min per workspace |
| D1 global | Time Travel (30 days) + nightly export to R2 | RPO ≈ seconds / RTO < 30 min |
| R2 | Versioning off; object lock on audit bucket; nightly inventory | — |

A restore drill (restore one staging workspace to a bookmark) is part of the PoC
acceptance and then runs monthly.

### 9.3 Deploys

- Worker: gradual deployments (versions, 10 % → 50 % → 100 %) with automatic
  rollback on error-rate increase.
- DO code updates everywhere at once and **drops every WebSocket**. Clients
  reconnect with jittered exponential backoff (0.5–5 s first attempt) and send
  per-channel `last_seq` cursors; the DO replies with deltas, not full state. No
  thundering refetch.
- Protocol compatibility: the Worker and DOs accept the previous `protocol`
  version for at least 30 days (mobile apps lag); clients send `X-Protocol`.
- Staging (`tiktokforwork-staging`) mirrors production bindings; E2E runs against
  it before each production deploy (existing `e2e/run.sh`).

---

## 10. Migration without downtime

The migration is per workspace, reversible, and verified by checksums.

| Phase | Work | Exit criteria |
| --- | --- | --- |
| **M0 — Store layer** | Introduce `WorkspaceStore` (interface) with a D1 implementation. Route every per-workspace query in `worker/src` through it. Lint: `env.DB` banned for workspace tables | All 1,167 `env.DB` uses classified; worker tests + E2E green; no behavior change |
| **M1 — DO store + dual write** | `WorkspaceDO` implements `WorkspaceStore` on SQLite. Registry column `orgs.store ∈ {d1, dual, do}`. In `dual`, D1 is primary and writes are mirrored to the DO (idempotent upserts) | Mirror error rate < 0.01 % |
| **M2 — Backfill** | Per workspace: start dual-write first, then copy history in id-ordered pages (idempotent, so overlap with dual-write is safe) | Row counts + per-table checksums (hash of ordered ids + updated_at) equal |
| **M3 — Shadow reads** | Sampled read endpoints are served from D1 and compared against the DO | Diff rate 0 over 7 days for that workspace |
| **M4 — Cutover** | Flip `orgs.store = do`: DO primary, D1 mirrored from DO (outbox) for 14 days | Rollback = flip back; D1 is current |
| **M5 — Contract** | After all workspaces are `do` for 30 days: stop mirror, drop workspace tables from D1 | D1 holds only global tables |

Status:
- **M0:** every write to `channel_messages` goes through `worker/src/channels.js`
  (post, edit, unsend, reactions, pins, reads) or retention (`governance.js`).
  Reads still query D1 directly. They move behind the store at cutover (M4).
- **M1 (built):** `worker/src/store/mirror.js` copies each written row, as D1
  has it after the write, to the workspace's object. It covers
  `WORKSPACE_DUAL` workspaces (`*` on staging, none in production yet).
  `reconcile` runs daily and repairs drift range by range, including rows D1
  removed behind the routes (e.g. account deletion). Reactions and read positions
  are not mirrored yet.

Order: our own workspace → small internal/test workspaces → small customers →
large customers. Each step can pause indefinitely; mixed fleets are normal.

---

## 11. Clients

### 11.1 Monorepo layout

```
apps/
  worker/     (moved from worker/)
  web/        (moved from web-react/)
  mobile/     Expo app (iOS + Android)
  desktop/    Electron shell loading apps/web
packages/
  protocol/   zod schemas + types for every endpoint and relay event
  core/       api client, relay client, stores, sync engine, read state, drafts,
              auth/session, push payload handling, quiet hours, billing state,
              display names, mentions, markdown AST, routes/deep links
  i18n/       one string catalog (merges web ja 1,689 keys + iOS 1,384 keys)
  tokens/     design tokens (colors, spacing, type) consumed by web + mobile
e2e/
```

pnpm workspaces + Turborepo (remote cache in CI). Expo Metro supports monorepos
natively (SDK ≥ 52); pnpm isolated installs are default since SDK 54 — use
`nodeLinker: hoisted` only if a native module requires it.

### 11.2 What `packages/core` owns

- Typed API client generated from `packages/protocol` (replaces ~90 raw `fetch`
  paths on web and the hand-written iOS services).
- Relay client with resume cursors and backoff (§9.3).
- Normalized stores + sync engine; persistence adapter per platform (expo-sqlite
  on mobile, IndexedDB on web/desktop) so the app opens instantly from cache.
- Pure logic moved out of components (e.g. `ClassicList.tsx` is split into core
  selectors/actions + thin views).
- Rule: **no React DOM or React Native imports in core**. Views stay per platform.
- Target: ≥ 70 % of non-view code in core.

### 11.3 Mobile (Expo) specifics

| Topic | Plan |
| --- | --- |
| SDK / architecture | Current Expo SDK (57, RN 0.86; 58 when stable), New Architecture, dev client, Continuous Native Generation — no hand edits under `ios/` or `android/`; everything via config plugins |
| Push | APNs (existing Worker code) for iOS, FCM HTTP v1 for Android. Notification Service Extension via a config plugin (expo-apple-targets) for communication notifications (sender avatar) and payload decryption. Keep `thread-id = orgId|channel` grouping. **Built:** native tokens registered with their `platform` (`device_tokens.platform`), FCM in `worker/src/fcm.js` (tag / `collapse_key` `orgId|channel`), tap → `/c/[channel]`. NSE and Android read-clearing not yet |
| Read clearing | Silent push (`content-available`) removes delivered notifications when read elsewhere — best-effort (iOS throttles), plus clearing on foreground |
| Deep links | Universal Links (`associatedDomains`) + Android App Links; `apple-app-site-association` and `assetlinks.json` served by the Worker; route table shared in core. **Built:** links are real paths on the web app — `https://app.honmaruai.com/c/<channel>?org=<orgId>`, `/join/<code>` (`packages/core/src/links.ts`); the Worker makes both files from `APPLE_TEAM_ID` / `ANDROID_CERT_SHA256` (`worker/src/wellKnown.js`) and a Pages Function serves them on the web app's domain; the web turns the path into its hash route; the app's `+native-intent` and `c/[channel]` screen open it, switching to the link's workspace |
| Sign in | Email code (existing), SSO (existing), **Sign in with Apple** (App Review 4.8 when third-party login is offered), Google on Android. **Built:** Sign in with Apple — `expo-apple-authentication` button on iOS, `POST /auth/apple` verifies Apple's RS256 token (keys cached, issuer, `APPLE_CLIENT_IDS` audience, expiry, SHA-256 nonce) and links Apple's `sub` in `apple_identities` (`worker/src/apple.js`). Google on Android not yet |
| Payments | RevenueCat `react-native-purchases`; server webhook → `entitlements` unchanged |
| Tokens | expo-secure-store; migrate the SwiftUI app's Keychain item (same service / access group) so users stay signed in across the update |
| Lists | FlashList v2 for chat; benchmark on a low-end Android (Discord found blanking on low-end devices and built their own list) — fallback Legend List |
| Jam (calls) | v1 keeps a WebView (as iOS does today); v2 `react-native-webrtc` (needs dev client) + Cloudflare TURN |
| OTA updates | EAS Update for bug fixes only. Features ship through store review (Apple DPLA §3.3.1(B), App Review 2.5.2). Runtime version = fingerprint policy |
| Replacing the SwiftUI app | Same bundle id; ships as a normal App Store update once parity (incl. iOS-only features: org graph, video capture, guest/demo mode) is reached. SwiftUI app gets fixes only from PoC go-decision on |

### 11.4 Desktop (Electron)

- Loads `apps/web` build; adds native notifications, dock/taskbar badge, tray,
  `honmaru://` protocol handler, global shortcut, auto-update (electron-updater).
- Security baseline: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, strict CSP, a minimal typed IPC surface, navigation
  allow-list.
- Signing: Apple Developer ID + notarization; Windows via Azure Trusted Signing
  (or an EV certificate). Built in CI.
- Priority: after mobile. The web app (PWA with Web Push, which already exists) covers
  desktop users until then.

---

## 12. PoC plan and acceptance criteria

Two PoCs run in parallel. Each has hard, measured criteria; failing any criterion
means we revisit that part of the decision before migrating.

### PoC-A: per-workspace data plane

Scope: `WorkspaceDO` with channels, messages, reactions, reads, members snapshot,
FTS5, outbox → Queue push, alarm schedule; `/v2/w/<orgId>/…` endpoints for list
channels, post, history, mark read, search; RelayDO fan-out with resume cursors.
Backfill one real staging workspace from D1.

| Criterion | Target |
| --- | --- |
| Post message latency (Worker → DO → ack) | p95 < 80 ms, p99 < 200 ms |
| Sustained writes on one DO | 500 writes/s for 10 min, zero overload errors |
| Fan-out to 5,000 hibernated sockets | p95 < 500 ms |
| Rows written per message (incl. indexes, FTS) | ≤ 6 (validates §5) |
| Backfill of a staging workspace | 100 % checksum match |
| Deploy under load | All clients resumed within 30 s, no full refetch |
| PITR restore drill | < 15 min |
| Isolation test | Requests with another workspace's `orgId` → 403 for every endpoint |

**Status (implemented, off in production):** `worker/src/workspace/do.js`
(`WorkspaceDO`: messages with a seq per channel, coalesced read positions,
FTS5 trigram search for English and Japanese, idempotent backfill, paged
checksum) and `worker/src/workspace/v2.js` (`/v2/w/<orgId>/…`, the same
`inChannel` / `caller` checks as the D1 routes). Enabled by `WORKSPACE_V2`
(`*` on staging and in tests, unset in production). Measured in tests: **5 rows
written per message** including the search index (target ≤ 6, asserted in
`worker/test/workspace-v2.test.js`). Latency and sustained-write numbers come from
`worker/scripts/poc-load.mjs` against a deployed Worker. Not yet built:
outbox → Queues, RelayDO shards, the deploy/resume drill.

### PoC-B: shared client core + Expo app

Scope: monorepo move (`apps/web`, `apps/worker`), `packages/protocol` +
`packages/core` extracted from web, Expo app with sign-in (email code), channel
list, chat (FlashList), post, APNs + FCM push with NSE, universal link into a
channel.

| Criterion | Target |
| --- | --- |
| Web after the move | Existing E2E (85 steps) green, no user-visible change |
| Shared code | ≥ 70 % of non-view client code in `packages/core` |
| Cold start | < 2 s iPhone 12, < 3 s Pixel 6a |
| Chat scroll (5,000 messages) | 60 fps, no blank cells > 1 frame on a low-end Android (Galaxy A14 class) |
| Push | Delivered and grouped per `orgId|channel` on both platforms; cleared on read elsewhere |
| Build | EAS / CI builds for iOS and Android from a clean checkout |

**Status (built):** `packages/protocol` (the `/v2` and sign-in shapes),
`packages/core` (`Api`, `ChannelSync` with open / older pages / catch-up after
the last seq / optimistic send, and the @mention rules — moved out of the web,
which now imports them), and `apps/mobile` (Expo SDK 57, Expo Router, sign-in by
emailed code, channel list with unread counts, a channel on FlashList v2). The
repository root is an npm workspace for `apps/*` and `packages/*`. `web-react/`
and `worker/` keep their own installs until they move under `apps/` (pnpm and
Turborepo come with that move). CI job "Shared core and mobile" runs the core
tests, both typechecks, and bundles the app for iOS and Android. Push: the app
registers the phone's native token (APNs or FCM) with its platform on sign-in,
removes it on sign-out, and opens the conversation a tapped notification names;
the Worker sends Android through FCM HTTP v1 (`worker/src/fcm.js`, secret
`FCM_SERVICE_ACCOUNT`), grouped per `orgId|channel` on both platforms. Links and
Sign in with Apple are built (§11.3): a link into a channel
(`https://app.honmaruai.com/c/…`) opens the app, or the web where the app is not
installed, in the link's workspace; invitation links (`/join/<code>`) redeem in
the app. They go live once the Worker has `APPLE_TEAM_ID` and
`ANDROID_CERT_SHA256` (docs/setup-secrets.md §4.7). Still to measure on devices:
cold start, scroll frame rate, and push delivery. Still to build: the
Notification Service Extension, clearing on read on Android.

### Go / no-go

A short ADR records the measured numbers and the decision. On "go", the roadmap
below starts; on "no-go" for a part, only that part is reconsidered (e.g. the list
library, or channel sharding earlier).

---

## 13. Roadmap

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| P0 | This plan; PoC-A and PoC-B | — |
| P1 | Monorepo + `packages/protocol` + `packages/core`; web moved onto core | PoC-B go |
| P2 | `WorkspaceStore` (M0), secrets envelope encryption, R2 org prefixes (new writes + copy of old keys), retention jobs (§7) | — (can start now; valuable regardless) |
| P3 | Expo app to parity with iOS SwiftUI (incl. org graph, video, guest mode, Jam WebView); Android launch | P1 |
| P4 | Data-plane migration M1–M5, workspace by workspace | PoC-A go, P2 |
| P5 | App Store update replaces SwiftUI app; Electron desktop | P3 |
| P6 (on demand) | Channel shards / relay shards for the first large workspace; EU jurisdiction for enterprise | Trigger in §6.1 |

P2 is deliberately independent of the PoCs: it removes debt (unbounded tables,
plaintext secrets, unprefixed blobs, unscoped queries) that we would have to pay
down under any architecture.

---

## References

- Discord: React Native on iOS (2015) and Android (2022); Electron desktop;
  Cassandra → ScyllaDB with (channel, time bucket) partitions; per-guild Elixir
  processes; passive sessions and relays for large guilds; custom list for
  low-end Android.
- Slack: native mobile, Electron desktop; Vitess sharded by workspace then
  channel; Flannel edge cache.
- Cloudflare docs: Durable Objects (SQLite storage, limits, pricing, PITR,
  hibernation, jurisdictions), D1 limits and pricing, R2 pricing, Queues,
  Workflows, Vectorize multitenancy, Workers Rate Limiting.
- Expo: SDK 57 release notes, monorepo guide, expo-notifications, EAS Update and
  Apple guidelines, config plugins.
