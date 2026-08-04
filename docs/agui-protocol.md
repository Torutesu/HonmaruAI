# AG-UI Adoption — Protocol Design

We adopt [AG-UI](https://github.com/ag-ui-protocol/ag-ui) as the wire protocol
between agents (relay) and user-facing clients (iOS, Web). This codifies what
the product already believed: **the agent never renders UI — it emits typed
events; clients own the pixels.**

## Where each protocol sits

| Layer | Standard | In this product |
|---|---|---|
| Agent ⇄ tools | MCP | GitHub / Slack / Notion / Calendar integrations (onboarding scan) |
| Agent ⇄ agent | A2A | Dana's AI → Alice's AI routing |
| Agent ⇄ human UI | **AG-UI** | Decision feed, cards, composer (this document) |

## Core idea: a Decision Card is a frontend tool call

The agent calls `request_decision` with a typed card; the client renders the
native component that matches `card.format` and answers with a
`submit_decision` tool result.

| `format` | Component | Answer |
|---|---|---|
| `approve` | ✕ / ✎ / ✓ circles + swipe | `approve` / `decline` (+ optional `note`) |
| `choice` | Option buttons (A–D grid ≥3), AI-recommended marked | `choose` + `optionId` |
| `reply` | Draft chips + composer (text / voice) | `reply` + `replyText` |
| `fyi` | Got-it | `acknowledge` |

Schemas live in [`server/agui/tools.js`](../server/agui/tools.js) and are served
at `GET /agui/tools`. They are the product's API contract — adding a new answer
shape = one schema value + one native component. No generated HTML, ever.

## Event mapping

State on the wire is `{ cardsById: { [id]: card } }` — keyed by id so JSON
Patch paths never depend on array order.

| Happening | Legacy dialect (unchanged) | AG-UI dialect |
|---|---|---|
| join | `snapshot` | `RUN_STARTED` + `STATE_SNAPSHOT` |
| new card | `card_created` | `STATE_DELTA` (add) to all; recipient also gets `TOOL_CALL_START/ARGS/END` (`request_decision`, args streamed in chunks) |
| card updated | `card_updated` | `STATE_DELTA` (replace) |
| card removed | `card_deleted` | `STATE_DELTA` (remove) |
| store cleared | `snapshot {}` | `STATE_SNAPSHOT {}` |
| presence | `presence` | `CUSTOM {name:"presence"}` |
| human decides | client sends `card_updated` | client sends `tool_result`; relay applies it, echoes `TOOL_CALL_RESULT` to the org, then broadcasts the state patch |

Separating **state sync** (patches, to everyone) from **the ask** (tool call,
to the recipient only) is what makes multi-device free: a second device stays
in sync passively; only the device(s) of the decision owner get an actionable
tool call.

## Protocol negotiation

`join` gains an optional field: `{ userId, orgId, protocol: "agui/1" }`.
Without it the session speaks the legacy dialect — the shipped iOS client
keeps working untouched. Both dialects run side by side against the same
store (covered by an integration test).

## What this buys us

- **Undo / rollback**: the event stream is an append-only log; rollback is a
  compensating `STATE_DELTA` + `CUSTOM(decision_rolled_back)` notice to the
  sender's agent. (Phase 2)
- **Provenance ("Source")**: `card.source` carries the raw human input; the
  event log carries the full shaping chain per `toolCallId`.
- **profile.md sync**: context curation becomes `STATE_DELTA` patches on a
  `context` subtree — identical on every device. (Phase 2)
- **Client leverage**: Web client = CopilotKit (AG-UI native). iOS = thin
  Swift event decoder replacing `WebSocketService`'s message enum (events are
  plain JSON).
- **Backend freedom**: the routing agent can move to LangGraph / Pydantic AI /
  Claude Agent SDK without touching clients — AG-UI middleware absorbs it.

## Migration plan

1. ✅ Schemas (`request_decision` / `submit_decision`) + `GET /agui/tools`
2. ✅ Relay emits AG-UI events behind `protocol: "agui/1"` (legacy intact)
3. ✅ iOS inbound: `AGUIEventAssembler` (`Services/AGUIEvent.swift`) decodes
   snapshots, patches, and chunked `request_decision` calls into the existing
   `RealtimeEvent` stream; `WebSocketService` joins with `protocol: "agui/1"`
   and falls back to the legacy dialect against older relays. Outbound stays
   legacy `card_*` for now — switching decisions to `tool_result` waits for
   the `decision` field on `DecisionCard` (Phase 2), since today's revise/
   delegate semantics don't map 1:1 onto `submit_decision` actions.
4. Web: CopilotKit client consuming the same socket
5. Phase 2: `STATE_DELTA` for profile.md context; rollback as compensating
   events; move `/ai/route` streaming onto `TEXT_MESSAGE_*` events

## Notes / risks

- The protocol is young: pin `agui/1` in the join payload and version the
  manifest; breaking changes mean `agui/2`, never silent edits.
- Not everything needs AG-UI: org-graph reads and OAuth stay plain HTTP.
- Args streaming is chunked (512B) so clients must buffer `TOOL_CALL_ARGS`
  deltas until `TOOL_CALL_END` — this matches AG-UI's standard semantics.

## Test coverage

`server/test/agui.test.mjs` (run `npm test` in `server/`):
unit — chunked args reassembly, JSON Pointer escaping, patch shapes, decision
semantics (approve/choose/reply/delete, validation errors); integration — a
legacy client and an AG-UI client on one relay: join shapes, cross-dialect
card delivery, `tool_result` → legacy `card_updated` with `decision` attached.
