# Notion Connector — Design

Date: 2026-08-10
Status: Approved design, pre-implementation
Sub-project A2 of connector expansion, following A1 (registry + Slack).

## Goal

Make Notion the third connector and the **first outbound destination**. One
database serves both directions: decisions you make are written into it, and
items in it assigned to you arrive as cards. Notion becomes the team's decision
ledger, and GitHub Issues stops being the only place a decision can land.

## One shared "Decisions" database

Both directions point at a single database the user picks once:

- **Outbound** — a decision (approve, decline, …) appends a row.
- **Inbound** — rows assigned to that user arrive as Decision Cards.

One setting, one mental model, and Notion reads as a ledger rather than two
disconnected integrations.

## Picking the database

The app lists the user's Notion databases and they tap one. Pasting a URL or an
id is a poor phone experience and invites typos.

- `GET /connectors/notion/databases` — session-authenticated, returns
  `{ databases: [{ id, title }] }` from Notion via Composio.
- `PUT /connectors/notion/config` — body `{ databaseId }`, stored per user.

Storage is a new, deliberately generic table, so the next connector that needs a
setting does not force a second one:

```sql
CREATE TABLE IF NOT EXISTS connector_config (
  user_github_id TEXT NOT NULL,
  connector      TEXT NOT NULL,
  config         TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_github_id, connector)
);
```

A user who has connected Notion but chosen no database syncs nothing and writes
nothing — no error, no half-state.

## Outbound: where the write happens

**In the relay Durable Object**, because it is already the one place that sees
every decision — it is where the audit event is written. Adding a second
side-effect there beats teaching another component about decisions.

**A Notion failure must never break a decision.** The write is wrapped exactly
like the audit log: try/catch, log, continue. Approving a card succeeds whether
or not Notion is reachable.

## What gets written — the honest constraint

Notion databases have **arbitrary user-defined schemas**. Guessing property
mappings across them is how integrations break silently.

- The **title property** gets the card title. Every database has exactly one
  title property, so this always works.
- Everything else — summary, the decision and who made it, when, and the source —
  goes in the **page body**.

That renders correctly in any database regardless of its columns. Mapping into
specific properties (Status, Assignee, Date) is a refinement to make once real
usage shows which ones people actually have; building it on speculation would be
fragile and unverifiable.

## Inbound

The Notion connector joins the A1 registry like Gmail and Slack, with one
difference: its `buildArgs` needs the user's configured `databaseId`, so the
registry contract gains an **optional per-user config** passed into `buildArgs`.
Connectors that ignore it (Gmail, Slack) are unchanged.

Items are pulled with `NOTION_QUERY_DATABASE_WITH_FILTER` and dedup is by Notion
page id. Each item still passes through the same triage — being in a database
does not make something a decision, and the triage may still return nothing.

## GitHub Issues is untouched

The existing client-side GitHub sync keeps working exactly as it does. Notion is
an **additional** destination that applies only to users who connected it and
chose a database. This is not a migration.

## Unknown, pinned before coding

Notion's filter syntax for "assigned to me", the exact shape of a row insert, and
how databases come back from search are **confirmed against the live API first**
and recorded in `worker/README.md` — the same discipline that produced the Gmail
and Slack contracts. Prerequisite: Notion connected in Composio (auth config
`ac_qtoaZ6G__JEd` created).

## Out of scope

Property-level mapping beyond the title, Linear/Jira destinations, choosing
per-card where a decision goes, and background polling. Inbound stays
client-triggered like Gmail and Slack.

## Testing

- **Worker (vitest):** databases list and config round-trip; a Notion inbound
  payload parses into the shared connector shape; a decision writes a row with
  the title mapped and the details in the body; **a Notion outage leaves the
  decision, its broadcast and its audit event intact**; a user with no configured
  database is a no-op in both directions.
- **Live:** connect Notion, pick a database, decide a card, and see the row
  appear — then confirm an item assigned in Notion arrives as a card.

## Success criteria

A user connects Notion, taps one database, and from then on their decisions
appear there as rows while work assigned to them there appears in the feed —
with GitHub Issues still working for everyone who never touches Notion, and a
Notion outage costing nothing but the row.
