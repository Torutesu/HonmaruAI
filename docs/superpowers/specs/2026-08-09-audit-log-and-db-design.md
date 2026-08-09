# Backend Audit Log + DB Hardening — Design

Date: 2026-08-09
Status: Approved design, pre-implementation
Sub-project 2 of the feature-development phase (after appearance + video capture).

## Goal

Make the backend remember what happened. Today every state change is
destructive: a decision overwrites the card row, a delete removes it, and a
rollback erases the decision it undid. Nothing can answer "who approved this,
when, and what did it look like before?" — which every user needs, and which the
"Rollback history" screen depends on.

This sub-project adds an append-only audit log, makes cards queryable, and gives
sessions an expiry.

## Problem (verified in the code)

- `worker/src/relay.js` persists decisions with `saveCard(...)`, which overwrites
  the row (`INSERT … ON CONFLICT DO UPDATE`).
- `card_deleted` and a `delete`/`mute` decision call `removeCard(...)`, which
  deletes the row outright.
- `applyRollback` reverts a card to `pending` and drops `decision` — the undone
  decision is gone.
- The D1 schema has 7 tables (`users`, `orgs`, `memberships`, `agents`, `cards`,
  `contexts`, `sessions`) and no history of any kind.
- `sessions.expires_at` exists but is never written or checked: sessions are
  valid forever.
- `cards` keeps the whole card as a JSON blob in `data`, extracting only
  `org_id`, `card_id`, `recipient_user_id`, `sender_user_id`, `created_at`. You
  cannot query by status or priority.

## 1. Audit log

New table, append-only — rows are never updated or deleted:

```sql
CREATE TABLE IF NOT EXISTS card_events (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  card_id        TEXT NOT NULL,
  type           TEXT NOT NULL,   -- created | updated | decided | rolled_back | deleted
  action         TEXT,            -- approve | decline | choose | reply | acknowledge | later | delete | mute
  actor_user_id  TEXT,            -- who did it; NULL for AI/system-originated changes
  note           TEXT,            -- decision note or reply text
  snapshot       TEXT NOT NULL,   -- the full card JSON at the time of the event
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_card ON card_events (org_id, card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_org ON card_events (org_id, created_at);
```

**Why a snapshot per event.** It makes deletion non-destructive without adding
soft-delete to `cards`, and it is the only way to answer "what did this card look
like before the rollback". A card JSON is a few KB, so an event log is cheap
next to the video storage.

**Where events are written.** `worker/src/relay.js` is the single choke point —
every mutation already flows through its `webSocketMessage` handlers. Append one
event per mutation:

| handler | event `type` | snapshot | actor |
|---|---|---|---|
| `card_created` | `created` | the new card | `senderUserID` |
| `card_updated` | `updated` | the updated card | connection's user |
| `tool_result` → `applyDecision` | `decided` | the card **after** the decision | `content.actorUserID` |
| `tool_result` with `delete`/`mute` | `deleted` | the card as it was | `content.actorUserID` |
| `card_deleted` | `deleted` | the card as it was (loaded before removal) | connection's user |
| `rollback` | `rolled_back` | the card **before** reverting (so the undone decision is preserved) | connection's user |

Writing the event must not break the mutation: wrap the append so a logging
failure is swallowed and the decision still lands and broadcasts.

**Read API** (both require `x-session-token`):

- `GET /orgs/:owner/:repo/cards/:cardId/events` — one card's timeline, oldest first.
- `GET /orgs/:owner/:repo/events?limit=50` — the org's recent activity (the
  Rollback-history screen's data source). `limit` defaults to 50, capped at 200.

Both return `{ events: [{ id, cardId, type, action, actorUserId, note, snapshot, createdAt }] }`.

**Two different id namespaces — do not mix them.** `actor_user_id` on an event is
the app-level user id, which is the **GitHub login** (`octocat`) — the same value
cards use for `recipientUserID` / `senderUserID` and the relay uses for `userId`.
`memberships.user_github_id` is the **numeric GitHub id** (`583231`), written by
the org-graph sync. So the membership check below resolves the session's
`github_id` (numeric) against `memberships`, while events store logins for
display. Never compare one to the other.

**Membership check (security).** These read from D1 directly, so unlike
`/orgs/:owner/:repo/graph` — where GitHub enforces access when we call its API —
nothing would stop a signed-in user from reading another org's history. Both
endpoints must verify the session's `github_id` has a row in `memberships` for
that `org_id`, and return **403** otherwise.

## 2. Card queryability

Add columns to `cards`, populated by `saveCard` from the card JSON (the JSON blob
stays the source of truth):

- `status` TEXT — `pending` / `approved` / `rejected` / `revised` / `delegated` / `completed`
- `priority` TEXT — `low` / `medium` / `high` / `urgent`
- `decided_at` TEXT — from `card.decision.decidedAt`, NULL while pending
- `updated_at` TEXT — set on every write

Plus `CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (org_id, status);`

The deployed D1 already has a `cards` table, so `schema.sql` (which uses
`CREATE TABLE IF NOT EXISTS`) will not add these to it. The live database gets
them via explicit one-time statements:

```
ALTER TABLE cards ADD COLUMN status TEXT;
ALTER TABLE cards ADD COLUMN priority TEXT;
ALTER TABLE cards ADD COLUMN decided_at TEXT;
ALTER TABLE cards ADD COLUMN updated_at TEXT;
```

(Re-running these on a database that already has the columns errors; that is
acceptable for a one-time migration and the error is ignorable.)

## 3. Session expiry

- `createSession` writes `expires_at` = now + 30 days.
- `getSession` returns null when `expires_at` is in the past.
- **Existing sessions have `expires_at = NULL` and stay valid** — treating NULL
  as "no expiry" avoids signing out the people currently testing. Only sessions
  minted from here on expire.

## Out of scope

The **UI** for history — the "Rollback history" and other settings screens — is
sub-project C and consumes this API. No iOS changes here. Also out: foreign-key
constraints, a card retention policy, and a migration framework (the full
hardening option was not chosen).

## Testing

`worker` vitest, extending the existing suite (30 tests today):

- an approve decision appends a `decided` event carrying actor, action, and a
  snapshot whose status is `approved`;
- a rollback appends `rolled_back` whose snapshot still shows the undone
  decision;
- a delete appends `deleted` and the card row is gone but the event remains;
- `GET …/cards/:id/events` returns the timeline oldest-first for a member;
- both read endpoints return **403** for a signed-in non-member and **401**
  without a session;
- `saveCard` populates `status` / `priority` / `decided_at` / `updated_at`;
- an expired session is rejected by `getSession`, a NULL-expiry session is not.

Then deploy and smoke: 401 without a token, 403 for a non-member org.

## Success criteria

Every card mutation leaves an immutable record; a member can fetch a card's full
timeline and the org's recent activity; other orgs' history is unreachable;
cards can be filtered by status in SQL; and new sessions expire after 30 days
without logging out existing testers.
