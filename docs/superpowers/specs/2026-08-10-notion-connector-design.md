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

### "Assigned to me" was dropped — revised 2026-08-10 after Task 1

This design originally said inbound would surface rows **assigned to the user**.
Pinning the API against the live service showed that cannot be done reliably, so
inbound now pulls the **most recently edited rows** and lets triage decide, exactly
like Gmail and Slack:

- **There is no guaranteed assignee column.** An assignee is a `people`-type
  property, and Notion database schemas are arbitrary — the probe database had
  none. This is the same fact that makes the title-only write bet *work*: we cannot
  assume any property beyond the title exists. It cuts both ways.
- **There is no "current user".** Composio authorizes as a **bot**, so Notion has no
  human "me" to compare against. Resolving one means listing every user and guessing
  at the `person` entries — brittle the moment a workspace has more than one.

The cost of reading a whole database is real, so the pull is **bounded to a page of
recent rows** rather than the full table. `ingested_items` still records every row it
scans (with `card_id` NULL when triage says no), so nothing is judged twice and an
unbounded first sync cannot happen. Without that bound, connecting a large database
would spend one AI call per row and exhaust the free tier immediately — see
`docs/superpowers/specs/2026-08-10-subscription-design.md`.

The consequence to accept: in a **shared** database, other people's rows are
candidates too. Triage discards what is not a decision, but this is a weaker filter
than "assigned to me" would have been. Letting the user nominate a `people` property
in the picker is the natural refinement once real usage shows how many databases
actually have one.

## GitHub Issues is untouched

The existing client-side GitHub sync keeps working exactly as it does. Notion is
an **additional** destination that applies only to users who connected it and
chose a database. This is not a migration.

## Unknown, pinned before coding — DONE 2026-08-10

Notion's filter syntax, the exact shape of a row insert, and how databases come back
from search were **confirmed against the live API** and recorded in
`worker/README.md` (`### Notion (verified 2026-08-10)`) — the same discipline that
produced the Gmail and Slack contracts. Auth config `ac_qtoaZ6G__JEd`.

Three findings that would have been wrong if guessed:

1. A database's title is a **rich-text array** (`title[].plain_text`), not a string.
2. `NOTION_INSERT_ROW_DATABASE` takes properties as a **list of `{name, type, value}`**,
   not a map keyed by property name. Page body goes in `child_blocks`.
3. The title property is identified by **`type === "title"`**, never by its display
   name, which is user-defined.

The write path was verified by actually creating a row in a database whose schema we
do not control, title-only — so the central bet of this design is tested, not assumed.
The "assigned to me" filter was the finding that changed the design; see above.

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
