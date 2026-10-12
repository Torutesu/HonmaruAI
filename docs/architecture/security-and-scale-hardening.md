# Security and scale hardening: what has to be true before we sell to other companies

Status: **In progress** · Owner: platform · Last updated: 2026-10-11

[The platform plan](discord-model-platform-plan.md) fixes the long-term shape:
one Durable Object per workspace, D1 for global data only. This document is
the path from the system as it runs today to that shape. It has two parts:

- scale targets per stage;
- the gaps a review of the code found (October 2026), in the order to close
  them.

Each gap names the file it lives in, so it can be checked off against the code.

---

## 1. Scale targets

| Stage | Workspaces / people | Data plane | Infra per month (excl. AI) |
| --- | --- | --- | --- |
| **S1: now** | ≤ 100 workspaces, ≤ 3,000 people | One shared D1 on Workers Paid | $5 to $20 |
| **S2: after migration** | ≤ 1,000 workspaces, ≤ 100k people | WorkspaceDO per workspace (plan §4); D1 global only | ≈ $17 at 1k active, $150 at 10k, $1,940 at 100k (plan §5.2) |
| **S3: on demand** | Single workspaces > 5k concurrently active | Channel shards and relay shards (plan §6.1) | — |

**Why S1 stops near 10k people.** A D1 database is capped at 10 GB, and every
tenant shares one single-threaded writer.

**What S1 must not do.** It must not stop for a day again. On the Free plan,
D1 refuses every query once 100k rows have been written in a day (the
2026-10 outage). Workers Paid bills overage instead of refusing: 50M rows
written and 25B rows read per month are included.

**What dominates the bill.** AI inference, not infrastructure (plan §5.3).
Per-workspace AI budgets matter more than any line in the table above.

### Watch these numbers (Cloudflare dashboard → D1 → Metrics)

| Metric | Healthy at S1 | Act when |
| --- | --- | --- |
| Database size | < 3 GB | > 5 GB: start the S2 migration in earnest |
| Rows written / day | < 1.5M (≈ the monthly allowance spread over the month) | Sustained above it: find the writer, then plan §5.3 guard rails |
| Rows read / day | < 800M | A step change after a deploy: a missing index or a full scan |
| Query p95 | < 50 ms | > 200 ms: writer contention, so move the hot workspaces first |

---

## 2. Scale gaps in the jobs that run on a schedule

The crons are `* * * * *` and `*/15 * * * *` (`worker/wrangler.toml`), and
they run across every tenant. Plan §4.4 moves them to DO alarms. Until then,
these were growing with total data rather than with active use.

| Gap | Fix | Status |
| --- | --- | --- |
| `pruneMessages`, `pruneAudit` and `weeklyVerify` read `LIMIT 50` with no order. Workspaces past the 50th were never pruned or checked. | `worker/src/orgCursor.js`: in order, with a cursor kept between runs | **Done** |
| `sealPending` always started at the first workspace (20 per hour). With more busy workspaces than that, the later ones were never sealed, and so never pruned. | Same cursor | **Done** |
| Expired sessions were never deleted. `checkSsoGrants`, the sync `candidates()` query and `sealLegacySecrets` each read the whole table every 15 minutes. | Daily trim deletes sessions a day past expiry (`retention.js`). Partial index `idx_sessions_sso_check`. Sync starts from `connector_config`. Sealing pauses for a day once clean. | **Done** |
| Daily deletes in `pruneGrowth` scan their tables. | Kept as scans on purpose: an index costs a written row per insert, 1,000× the price of a read, and these run once a day | Decided |
| `audit_events` grows forever where `AUDIT_ARCHIVE` / `AUDIT_SIGNING_KEY` are unset: pruning needs a seal | The deploy workflow generates both. Verify they are set in production. | Check |
| `card_events` keeps a full card snapshot per event, never pruned (by design: the decision record) | Cold tier to R2 with the DO move (plan §7) | S2 |
| Account deletion updates `cards`, `card_events` and `channel_messages` by login with no index (full scans) | Moves to a Workflows saga per workspace (plan §8.4) | S2 |

---

## 3. Security gaps, in the order to close them

**Already closed in October 2026:**
- Private-channel content no longer reaches the live feed or the decision lookups of non-members.
- Guest permissions are narrowed.
- An admin key or SCIM can only sign people out of its own workspace.
- Wrong passwords and codes are limited per account.
- The claimed-but-unproven email takeover is closed.
- `javascript:` card links are refused.
- The web app has a CSP.

### P1: before the first outside customer (2–4 weeks)

| # | Gap | Where | Fix |
| --- | --- | --- | --- |
| 1 | ~~**Session tokens are stored in plaintext**, as the D1 primary key. A D1 read means takeover of any account.~~ **Done** | `db.js` `createSession`, `sessionKey` | The table keeps `h1:` + sha256(token); a session from before moves to its hash on first use. |
| 2 | **30-day sliding bearer token in `localStorage`, CORS `*`.** Any XSS, or any site holding a stolen token, has full access for a month. | `web-react`, `CORS_HEADERS` in `index.js` and ~15 modules | CORS allowlist (app origins plus native clients, which send no Origin). Then short-lived access tokens with refresh (plan §3.1). |
| 3 | **Unauthenticated media.** `GET /media/:uuid` and `/jam/:uuid` serve anything to anyone who has the UUID. | `media.js:142`, `jam.js:451` | Serve only through signed media URLs (`mediaToken.js`, already used for new uploads); turn the legacy route off (`MEDIA_LEGACY_VIDEO=off`) once clients are on signed URLs. |
| 4 | **File links outlive access.** `/files/:id` URLs are valid ~48 h, are bound to no org or person, and are signed with a key kept in D1 `kv`. | `files.js:61–74, 352` | Sign with a Worker secret; bind the org in the MAC; shorten to minutes, as media is. |
| 5 | **MCP agent tokens never expire** and skip `policyDenial`: the SSO requirement, IP allowlist and session rules do not apply to them. | `mcp.js:63–135` | Expiry (default 90 days, like org keys). Apply the workspace IP allowlist. Re-check the creator against SSO policy. |
| 6 | **Outbound fetch checks only the hostname**, follows redirects, and OIDC discovery is unchecked. | `links.js:38`, `preview.js:58`, `sso.js:76` | Re-check every redirect hop with `redirect: "manual"`; refuse non-public results; check the issuer URL. |
| 7 | **The membership gate is copied into ~6 modules;** two routes skip `policyDenial` (`POST /media`, `/channels/link-preview`). | `index.js`, `channelRoutes.js`, `automation.js`, `webhooks.js`, `audit.js` | One `requireWorkspace(env, request, orgId)` used everywhere; a test that walks every route with a foreign `orgId` and expects 403 (plan §12 isolation criterion). |
| 8 | **No workspace deletion; backups only on paper.** | `permissions.js:15` (`workspace.delete` unused); plan §9.2 | Owner-initiated deletion with a 30-day grace (D1 rows + R2 `org/<id>/` prefix + registry tombstone). Nightly D1 export to R2 and a monthly restore drill. |

### P2: tenant isolation by construction (2–3 weeks)

| # | Gap | Fix |
| --- | --- | --- |
| 9 | 838 hand-written queries, 478 `org_id = ?` predicates, nothing enforcing them | Plan M0: `WorkspaceStore` interface; workspace tables reachable only through it; lint bans `env.DB` on workspace tables |
| 10 | Encryption is optional: no `DATA_KEY` means plaintext, no audit keys means a clear-text audit log | Fail the deploy (and refuse to start) without them in production |
| 11 | One key for every tenant; `SSO_SECRET_KEY` seals without associated data | Per-workspace data keys wrapped by a master key (plan §8.2); add associated data on the next write |
| 12 | Audit writes fail open; ops endpoints share one `OPS_TOKEN`, compared with `!==` | Fail closed for security-relevant actions (role, SSO, keys, exports); constant-time compare; per-operator tokens |
| 13 | Repo-linked workspaces auto-join anyone with push access on GitHub | Owner setting: "GitHub push access joins automatically" (default off for team workspaces) |
| 14 | Connected apps (Gmail, Notion) are per person, shared by every workspace they are in | Key Composio by `orgId:githubId` for new connections; show which workspace an app is connected in |

### P3: physical isolation (1–3 months)

Plan §10, M1 to M5. Each workspace moves to its own WorkspaceDO, reversibly,
with checksums. After it, a query that forgets `org_id` cannot reach another
tenant: the other tenant's rows are not in that database. This is the answer
an enterprise security review wants. P1 and P2 still matter after it,
because tokens, media and outbound fetches are outside the data plane.

---

## 4. What a customer's security review will ask, and our answer after P1

| Question | Answer |
| --- | --- |
| How is our data separated from other customers'? | Today: by workspace ID on every query, enforced by one gate and an isolation test (P1 #7, P2 #9). After P3: a separate database per workspace. |
| Encryption at rest? | Cloudflare encrypts storage. Credentials and secrets are additionally sealed with AES-GCM, and session tokens are hashed (P1 #1). |
| SSO / SCIM / MFA? | OIDC and SAML SSO, SSO enforcement per domain, SCIM provisioning, per-workspace session rules and re-authentication. |
| Audit log? | Per-workspace hash chain, hourly signed archives to an object-locked bucket, SIEM streaming. |
| Can we delete our workspace and get an export? | Compliance export today; workspace deletion after P1 #8. |
| Backups and recovery? | D1 Time Travel (30 days) plus nightly export to R2 (P1 #8); restore drill monthly. |
| Data residency? | Designed in (plan §8.3); enabled per customer with the DO move. |
