# Connector Registry + Slack Inbound — Design

Date: 2026-08-10
Status: Approved design, pre-implementation
Sub-project A1 of connector expansion. A2 (Notion, inbound + outbound) follows.

## Goal

Make inbound connectors plural. The Gmail connector proved the pattern — fetch,
dedup, triage, card — but the route, the parser and the prompt are all named
"gmail". This generalizes them into a registry any connector can join, and adds
**Slack** as the second source.

## Why Slack now and Notion later

Looking at the actual Composio tools changed the split:

| source | how work is found | needs setup? |
|---|---|---|
| Gmail | a query over your own mail | no |
| Slack | `SLACK_SEARCH_MESSAGES` over mentions/DMs | no |
| Notion | `NOTION_QUERY_DATABASE_WITH_FILTER` | **yes — which database?** |

Notion needs a target database, and it needs the *same* target for the outbound
side (writing decisions back). Splitting that configuration across two
sub-projects would build it twice, so all of Notion moves to A2 and A1 stays
config-free.

## Architecture

A connector is a small module with three things and no knowledge of cards:

```js
{
  id: "slack",
  label: "Slack",                       // becomes card.sourceApp
  toolSlug: "SLACK_SEARCH_MESSAGES",
  buildArgs(),                          // arguments for the Composio tool call
  parse(payload) -> [{ id, from, subject, snippet, date }]
}
```

`worker/src/connectors/index.js` exports the registry; `gmail.js` moves under it
unchanged in behaviour, and `slack.js` is new. The sync loop —
fetch → skip if already ingested → triage → card → record — becomes
connector-agnostic and lives in one place.

### Endpoint

`POST /connectors/sync` (session-authenticated) runs **every** connector, and
returns per-connector counts:

```json
{ "results": [ { "connector": "gmail", "scanned": 10, "created": 3 },
               { "connector": "slack", "scanned": 4,  "created": 1 } ] }
```

One call for the client, and adding a connector needs no client change.

**A failing connector must not stop the others.** Each runs in its own try/catch;
a Composio error for Slack still lets Gmail deliver. Failures come back as
`{ connector, error }` in the same array rather than failing the request.

### Backwards compatibility (this matters — build 28 is in testers' hands)

TestFlight build 28 calls `POST /connectors/gmail/sync`. That route **stays**,
delegating to the same loop filtered to Gmail, so shipping this does not break an
installed app. The client moves to `/connectors/sync` in the same release, but
the old route is not removed.

### Triage

The prompt is mail-shaped today ("You triage a person's incoming mail"). It
generalizes to incoming *messages* with the source named, so a Slack DM is judged
as a Slack DM. The rule that carries the feature is unchanged and must stay:
**most messages are not decisions, and returning nothing is correct.**

### Unknown, to be pinned before coding

Slack's search query syntax for "mentions and DMs addressed to me" is not
guessed. It is confirmed against the live API first — exactly as the Gmail
contract was — and recorded in `worker/README.md`. The connector's `buildArgs()`
is written against what that shows.

## Per-user connections — the part the Gmail build got wrong

The shipped connector uses a single Composio identity, `COMPOSIO_USER_ID =
honmaru-default`, set as a Worker secret. **That means every signed-in user's sync
reads the same mailbox** — the developer's. For a demo of triage quality it was
enough; for an app handed to other people it is a privacy defect, and it is live
right now. Fixing it is part of A1, not a later nicety.

The correct model is the one Composio is built for: **one auth config per toolkit
per project, one connected account per user underneath it.**

- The Composio `user_id` is the **numeric GitHub id** already in
  `sessions.github_id`. No new identifier — the codebase already carries two
  (login vs numeric id) and a third would rot.
- `COMPOSIO_USER_ID` is **deleted**. The Worker always derives the id from the
  caller's session, so a user can only ever reach their own connections.
- Auth configs stay project-level and are created once per toolkit, then reused
  (`ac_XcSzdgFl91Ds` for Gmail, `ac_qv8jozIjt29D` for Slack, already created).

### In-app connect flow (now mandatory)

- `POST /connectors/:connector/connect` — session-authenticated. The Worker calls
  `POST /v3/connected_accounts/link` with `user_id` = the caller's GitHub id and
  the toolkit's auth config, and returns `{ redirectUrl }`.
- `GET /connectors` — what this user has connected:
  `{ connectors: [{ id: "gmail", label: "Gmail", status: "active" | "none" }, …] }`,
  read from Composio's connected-accounts list filtered to that `user_id`.
- iOS gains a **Connectors** settings screen: each connector with its state and a
  Connect button that opens `redirectUrl` in `ASWebAuthenticationSession` — the
  same mechanism GitHub sign-in already uses — then re-checks status on return.

A user who has connected nothing simply syncs nothing; the feed is unaffected.

## Out of scope

Notion (all of it — A2), outbound destinations, background polling, and any
connector that writes. A1 is read-only and client-triggered, like Gmail.

## Testing

- **Worker (vitest):** Slack payloads parse into the shared shape; one sync runs
  both connectors and reports per-connector counts; a connector that throws is
  reported as an error while the other still creates its cards; the legacy
  `/connectors/gmail/sync` route still answers.
- **Live:** connect Slack, run a sync, and look at what became a card and what
  did not — the same judgement that validated Gmail (10 messages → 3 cards).

## Success criteria

Two people can install the app, each connect their own Gmail and Slack, and each
see cards built only from their own messages — with no shared identity anywhere
in the path. Adding a third connector means writing one small module and nothing
else; a single sync pulls from every connected source; one source failing does
not silence the others; and the app installed from build 28 keeps working.
