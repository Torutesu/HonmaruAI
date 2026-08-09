# Gmail Inbound Connector — Design

Date: 2026-08-09
Status: Approved design, pre-implementation
Sub-project 4 of the feature-development phase; the first step of multi-connector work.

## Goal

Today a Decision Card can only come from a person typing an instruction to their
AI. The product's premise is that your AI triages *everything* that lands on you
— GitHub is just one source. This adds the first inbound source: **Gmail**, read
only, turning the mail that actually needs your decision into cards in your feed.

Gmail is first because the account is **already connected and ACTIVE in Composio**,
so the whole path can be exercised for real without new OAuth setup.

## The idea that makes this worth building

**Most email is not a decision.** An ingestion that turns every message into a
card is a worse email client. The value is the judgment: for each message, decide
*does this need a decision from this person, and what is the decision?* — and
create nothing when the answer is no.

That judgment is a new AI step, distinct from the existing router:

| | existing `routeInstruction` | new triage |
|---|---|---|
| input | an instruction the user typed | a message that arrived |
| question | *who should receive this?* | *does this need my decision at all?* |
| recipient | a teammate | always the connected user |
| may produce nothing | no | **yes — and usually should** |

## Architecture

```
iOS "Connect Gmail"  → POST /connectors/gmail/connect → Composio hosted OAuth
                       (ASWebAuthenticationSession, same pattern as GitHub)

feed appears / pull-to-refresh
  → POST /connectors/gmail/sync   (x-session-token)
      Worker → Composio REST: GMAIL_FETCH_EMAILS
                 query "is:unread newer_than:7d", small max_results,
                 verbose=false, include_payload=false
             → drop anything already in `ingested_items`
             → AI triage per message → card | nothing
             → saveCard (D1) + relay broadcast
      ← { created: N }
  → the feed updates live over the existing WebSocket
```

### Worker

- **Secret:** `COMPOSIO_API_KEY`.
- **User identity for Composio:** reuse the **numeric GitHub id** already in
  `sessions.github_id`. Introducing a second identifier for the same person is
  how id namespaces rot (this codebase already carries two — login vs numeric id
  — and a third would be worse).
- **Endpoints** (all session-authenticated with `x-session-token`):
  - `POST /connectors/gmail/connect` → asks Composio to initiate a connection for
    this user, returns `{ redirectUrl }`.
  - `GET /connectors` → `{ connectors: [{ id: "gmail", status: "active" | "none" }] }`.
  - `POST /connectors/gmail/sync` → runs the ingestion, returns `{ created, scanned }`.
- **Dedup table** (D1):

```sql
CREATE TABLE IF NOT EXISTS ingested_items (
  connector      TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  user_github_id TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  card_id        TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (connector, external_id, user_github_id)
);
```

  A row is written for **every** scanned message — including ones the triage
  rejected, with `card_id` NULL. Otherwise every sync re-reads and re-judges the
  same rejected mail forever, burning tokens to reach the same "no".

- **Fetch robustness.** Composio's own guidance flags three traps this must
  handle: output is sometimes wrapped as `results[i].response.data.messages`
  rather than `response.data.messages`; an empty `messages` array is a valid
  no-matches result, not an error; and `verbose=true` / `include_payload=true`
  can trigger 413 or truncation, so the list is fetched light and only the
  shortlist is hydrated.

### iOS

- A **Connectors** screen in settings: Gmail with Connect / Connected state,
  opening the Composio redirect in `ASWebAuthenticationSession` — the same
  mechanism GitHub sign-in already uses.
- The feed calls `sync` when it appears and on pull-to-refresh. **Failure is
  silent**: a connector that is down must never break the feed or block the UI.
  New cards arrive over the existing relay socket, so no new delivery path.
- Cards show provenance using the fields the model already has: `sourceApp`
  ("Gmail") and `sourceDetail` (sender · subject).

## Out of scope

Other apps (Slack, Linear, …), **background polling / Cron** (deferred by
choice — on-open plus manual refresh first), the outbound side (decisions still
sync to GitHub Issues), and anything that **writes** to Gmail. This connector is
strictly read-only.

## Honest risk

**The triage prompt is the feature.** It will not be right on the first try, and
tuning it needs real mail. The build gets one honest path working end to end;
quality comes from iterating on that path with real data, not from more code.

A second risk worth naming: reading a user's mail is sensitive. The Worker reads
only message metadata plus a short snippet, stores only what a card needs, and
never writes to the mailbox.

## Testing

- **Worker (vitest):** Composio mocked via `fetchMock` — a message that needs a
  decision produces a card; one that does not produces none but is still recorded
  in `ingested_items`; an already-ingested message is skipped without a second AI
  call; a Composio failure returns an error without corrupting the store; both
  response shapes (wrapped and unwrapped) parse.
- **Live:** the connected Gmail account makes a real end-to-end run possible —
  connect, sync, and confirm what appears in the feed and what was correctly
  ignored.
- **iOS:** builds; the Connectors screen renders; sync failure leaves the feed
  intact.

## Success criteria

A signed-in user connects Gmail once, opens the app, and finds cards only for
the mail that genuinely needs a decision — each showing where it came from —
with nothing duplicated across syncs and nothing written back to their mailbox.
