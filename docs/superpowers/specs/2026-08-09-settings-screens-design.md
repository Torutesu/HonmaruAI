# Settings Screens: History, Context, API Key — Design

Date: 2026-08-09
Status: Approved design, pre-implementation
Sub-project 3 of the feature-development phase.

## Goal

Replace the dimmed "Coming soon" rows in `YouView` with features that actually
work. Three ship here — History, Context, and API key — and one row is deleted
rather than built, because the feature behind it no longer exists.

## What the rows really are (verified)

| Row | Reality found in the code |
|---|---|
| Rollback history | The backend logs every mutation (sub-project 2) and the relay accepts a `rollback` message — but **iOS never sends one**, so a rollback-only screen would be permanently empty. |
| Context | D1 has a `contexts` table, the relay handles `context_updated`, and AG-UI broadcasts `STATE_DELTA /context/{userId}` — but **iOS neither reads nor writes it, and routing ignores it**. |
| API key | `/ai/route` has **no session**, so a per-user key cannot be looked up server-side today. |
| Plan | Billing — an independent subsystem (IAP/RevenueCat). Deferred. |
| Notifications | APNs setup, device tokens, a send path. Deferred. |
| Set classic view as default | The Slack-style Classic view was **deleted in Phase 4C**. The row toggles nothing. |

## 1. History (and the Undo that makes it real)

**Screen.** A new `HistoryView`, pushed from a `History` row in `YouView`
(renamed from "Rollback history" — the log covers every mutation, and a screen
showing all activity is both honest and more useful).

It calls `GET /orgs/:owner/:repo/events?limit=50` with the `x-session-token`
header and renders newest-first. Each entry shows:

- what happened — `type` (created / updated / decided / rolled_back / deleted)
  plus `action` when present (approve, decline, …);
- which card — `snapshot.title`;
- who — `actorUserId` (the GitHub login);
- when — `createdAt`, relative.

The org id comes from the signed-in connection (`owner/repo`). States: loading,
empty ("Nothing has happened yet"), error, and **signed-out** — a guest has no
session, so the screen explains that history needs sign-in rather than showing a
failure.

**Undo.** A decided card gains an Undo action that sends the relay's existing
`rollback` message (`{type:"rollback", payload:{cardId}}`). The backend already
reverts the card to `pending`, broadcasts `decision_rolled_back`, and — since
sub-project 2 — logs a `rolled_back` event whose snapshot preserves the decision
that was undone. Without this, "rollback history" is a screen that can never
have content.

## 2. Context — what your AI should know about you

**Screen.** A new `ContextView` with a free-text editor: your role, priorities,
how you work. Saved on dismiss.

**Persistence.** Sent over the existing WebSocket as
`{type:"context_updated", payload:{context:{text: "…"}}}`. The relay already
persists it to D1 and broadcasts the delta, so nothing new is needed server-side
for storage.

**Making it matter.** Storage alone changes nothing, so the sender's context is
also threaded into routing: `POST /ai/route` gains an optional `senderContext`
string in its body, and `buildUserPrompt` includes it under a `Sender context:`
heading so the model weighs it when choosing a recipient and writing the card.

Server-side lookup was rejected: `/ai/route` is unauthenticated, so adding a
session there to fetch the context would be a much larger change for the same
result. The app holds the value and sends it.

## 3. API key — bring your own, we never store it

**Screen.** A new `APIKeyView`: paste an OpenAI key, see it masked, clear it.

**Storage.** The key lives **only in the device Keychain** (`SessionStore`). It
is sent per request in an `x-ai-key` header on `POST /ai/route`. **Nothing is
persisted on our servers** — no row, no secret, no key at rest, and the screen
says so plainly. That is both the simplest design and the one with the least
liability.

**Worker.** `providerConfig(env)` becomes `providerConfig(env, userKey)`: when a
caller supplies a key, routing uses OpenAI with that key; otherwise the existing
server key; otherwise the keyword fallback. The key is never logged. A bad key
fails the LLM call, which already degrades to keyword routing with
`routingError` — visible, not silent.

## 4. Delete the dead row

`Set classic view as default` is removed from `YouView`, along with its string
catalog entry. Building a toggle for a deleted surface would be worse than
leaving it dimmed.

## Out of scope

**Plan** (billing) and **Notifications** (APNs) stay "Coming soon" and get their
own sub-projects. No changes to the feed, org graph, or capture flow.

## Testing

- **Worker (vitest):** `/ai/route` includes `senderContext` in the prompt when
  supplied; a request carrying `x-ai-key` routes with that key (fetchMock
  asserts the outgoing `Authorization` header) and one without it uses the
  server key; neither path logs the key.
- **iOS:** builds; simulator screenshots of History (empty + signed-out), Context,
  and API key. Fetching real history and exercising Undo need a device with a
  GitHub session, so those are device checks.

## Success criteria

`YouView` has no dimmed row that a user can tap expecting something; History
shows real activity for a signed-in member and explains itself for a guest; a
decision can be undone and that undo appears in History; a saved context
demonstrably reaches the routing prompt; and a user-supplied API key is used for
their routing without ever being stored server-side.
