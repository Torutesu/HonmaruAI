# Dynamic UI — Architecture

How AI-generated Decision Cards get their shape, and how we keep that
fast and cheap.

Companion to `design.md` (visual language) and `prd.md` (assignment brief).

---

## 1. Does this use CopilotKit?

No — and it can't, on the client. But the pattern it popularised is
exactly what we implement.

CopilotKit ships frontend SDKs for React/Next.js, Angular, Vue and React
Native, plus chat surfaces (Slack, Teams). There is **no native Swift
SDK**. Its generative UI mechanism — `useCopilotAction({ render })` — maps
an agent tool call to a *React component*. A JS runtime cannot select or
mount a SwiftUI `View`, so the mechanism does not cross the language
boundary. The assignment mandates native Swift/SwiftUI, so the frontend
half of CopilotKit is off the table by construction.

What *is* portable is the protocol underneath: **AG-UI**, the event-driven
agent↔UI protocol CopilotKit authored. It is transport-agnostic (SSE,
WebSocket, HTTP) and defines typed events like `TOOL_CALL_START`,
`TEXT_MESSAGE_CONTENT` and `STATE_DELTA` (with RFC-6902 JSON Patch for
incremental state). Only a community Swift port exists (AGUISwift), not an
official one.

**Decision:** adopt the *shape* of AG-UI over our existing WebSocket relay,
skip the dependency.

| | Take | Leave |
|---|---|---|
| Tool call → registered renderer | ✅ core of our design | |
| Streaming partial tool arguments → progressive render | ✅ | |
| Event-typed agent↔UI channel | ✅ 3 events, not 16 | |
| React component registry | | ❌ no Swift equivalent |
| CopilotRuntime hop in front of the model | | ❌ extra network hop, see §4 |
| Full AG-UI event taxonomy | | ❌ we have one generative surface |

Where CopilotKit *would* earn its place: a web admin console for the same
relay (org graph editor, card audit log). Same runtime, React frontend,
zero conflict with the iOS app. Out of scope for v1.

> The rule this section encodes: **the types are ours, the generation
> pattern is theirs.** We own a closed schema; the model only fills it.

---

## 2. The core decision: typed generative UI

The naive reading of "dynamic UI" is *let the model emit a UI tree* — JSON
layouts, nested containers, style props. We reject that. It is the most
expensive possible design on both axes we care about:

- **Cost:** a layout tree is 400–900 output tokens. The information content
  is maybe 60 tokens. We would be paying the model to re-derive our design
  system on every card.
- **Latency:** output tokens dominate wall-clock. 900 tokens at ~60 tok/s
  is 15s. Non-starter for a feed.
- **Risk:** a cheap model emitting free-form layout will eventually emit a
  broken one. On a full-screen single-card feed, one bad layout = one
  unusable screen.

Instead: **the model picks from a closed vocabulary and fills typed slots.
iOS owns every pixel.**

```
instruction (free text)
        ↓
  [ closed schema ]     ← model's entire output surface
        ↓
  CardBlock registry    ← SwiftUI views, compiled, themed, tested
        ↓
      pixels
```

This is `useCopilotAction`'s contract with the JS removed: a tool call
names a component, arguments fill its props, the client holds the renderer.

### 2.1 Block vocabulary

Today `DecisionCard` is a fixed shape: title / summary / context string /
priority. The `context` field is already a smuggled mini-format
(`"label: detail · label: detail"`, parsed by `ContextInsightView`). We
promote that hack into a real discriminated union.

```swift
enum CardBlock: Codable, Hashable {   // discriminated by `kind`
    case metrics([Metric])            // label, value, delta?, tone?
    case checklist([ChecklistItem])   // text, done
    case comparison(Comparison)       // optionA / optionB — for approvals
    case timeline([TimelineStep])     // label, state
    case codeRef(CodeRef)             // repo, pr/issue #, path?
    case quote(Quote)                 // verbatim excerpt of the instruction
}

struct DecisionCard {
    // ... existing fields ...
    var blocks: [CardBlock]           // default []
    var actions: [CardAction]         // default: derived from `type`
}
```

`CardAction` is likewise closed: `.approve .reject .revise .delegate
.openIssue .snooze`, each with an optional model-supplied label override.
The model chooses *which* actions and *what they're called*; it never
chooses what they do.

### 2.2 Forward-compatibility rule

Decoding is lenient in exactly one direction:

- **Unknown `kind`** → block dropped, card renders without it.
- **Unknown action** → dropped; if the set empties, fall back to the
  `type`-derived default set.
- **Missing blocks entirely** → renders as today's card. Byte-identical to
  the current UI.

This is the property that makes cheap models safe here: **the worst
possible model output is the card we already ship.** There is no failure
mode that produces a broken screen. That single guarantee is what licenses
every cost reduction in §4.

---

## 3. Latency architecture: three lanes

The user must never watch a spinner for a model. The design achieves this
by rendering *before* the model runs.

```
t=0ms     Lane 0   deterministic router → card appears, marked drafting
t~250ms   Lane 1   first streamed fields patch in (title, priority)
t~700ms   Lane 1   blocks + actions land, drafting flag clears
t~2s      Lane 2   escalation, only on low confidence (~5–10% of traffic)
```

### Lane 0 — Instant, free

`routeInstructionLocally()` already exists in `server/agentTools.js` and
already produces a valid, validated card from keyword + org-graph rules.
Today it is only a failure fallback. Promote it to the **first-class
opening move**: run it synchronously on submit, emit `card_draft`, done.

The user's card is on screen before the HTTP request to OpenRouter has
finished its TLS handshake. Perceived latency ≈ 0.

Lane 0 also fixes a correctness wart: `applyRoutingGuard()` already
overrides the model's recipient choice whenever a team/role/name rule
matches. So for a large share of traffic **we are paying the model to
choose a recipient and then discarding its answer.** Lane 0 makes that
explicit — routing is code, language is the model's job.

### Lane 1 — Cheap model, one shot, streamed

One request. `tool_choice` forced to `create_decision_card` (already done).
No agent loop, no second turn. `stream: true`, and the relay parses partial
tool-call argument JSON, emitting a `card_patch` per completed field.

Streaming is the single largest *perceived* latency lever after Lane 0:
title is ~15 tokens into the output, blocks are ~150. Non-streaming makes
the user wait for token 150 to see token 15.

### Lane 2 — Escalation, rare

Triggered by deterministic code, never by a model call. Conditions:

- instruction > 240 chars, or contains ≥ 2 sentences with distinct verbs
- Lane 1 output failed validation twice
- Lane 1 self-reported `confidence: "low"` (one enum field, ~3 tokens)

Never spend a model call deciding whether to spend a model call.

---

## 4. Cost levers

Current per-request input is roughly: system prompt (~200 tok) + tool
schema (~400 tok) + serialized org graph (13 nodes + 16 edges ≈ 350–450
tok) + instruction. Call it ~1,050–1,100 input tokens, 512 max output, for
a card whose real information content is under 100 tokens.

Ordered by impact:

**1. Stop sending the whole org graph.**
`organizationContext()` serializes all 13 nodes and 16 edges — including
agent nodes and `assignedTo` edges the model has no use for. Replace with a
**pre-filtered candidate list**: run the graph resolution in code, send the
top 3 candidates as `id · name · role · why`. ~400 tok → ~40 tok.

**2. Make the prompt prefix immutable.**
`buildUserPrompt()` currently puts the instruction *before* the org
context, so the varying part sits in the middle of the prompt and poisons
the cacheable prefix. Flip it: `[system][tools][org digest][instruction]`.
Now the first ~600 tokens are byte-identical across every request and
provider-side prompt caching applies.

**3. Response cache.**
Key on `sha256(normalized instruction + senderID + orgVersion)`, TTL 1h,
in-memory. Demo scripts replay the same instructions constantly — a
reviewer typing the same line twice should cost nothing and return in
~1ms.

**4. Blocks are opt-in, per card type.**
`notification` cards get no blocks. `approval`/`task` may request them.
The prompt instructs: emit blocks *only* when the instruction contains
numbers, enumerable items, or a PR/issue reference. Most instructions
don't — most cards should cost the same as today.

**5. Tighten `max_tokens`.**
512 today for a ~150-token answer. Budget 320 base, 200 extra only when
blocks are permitted for that card type.

**6. Kill the retry-by-reprompt.**
`routeInstructionWithOpenRouter()` retries the whole request on empty
content (`attempt < 1`) — doubling cost and latency for a case Lane 0
already covers for free. Replace with: merge onto the Lane 0 draft, mark
`degraded`, return.

**7. HTTP keep-alive to OpenRouter.**
Node's global fetch opens a fresh TLS connection per request. A pooled
agent removes a full handshake (~100–200ms on a cold path) from every
card, at zero cost. Free latency.

**8. Model fallback via OpenRouter's `models: []`, not our own loop.**
`inclusionai/ling-3.0-flash:free` is rate-limited with variable tail
latency. Passing an ordered `models` array lets OpenRouter fail over
server-side inside one request, instead of us paying a full round trip to
discover the free tier is throttled.

### Expected shape

| | Now | Target |
|---|---|---|
| Input tokens / card | ~1,050 | ~650 (~120 uncached after prefix caching) |
| Output tokens / card | ≤ 512 | ≤ 320 typical |
| Model calls / card | 1, ×2 on empty | 1 |
| Time to first pixel | full round trip | < 100ms (Lane 0) |
| Time to final card | 1 blocking response | streamed, ~700ms p50 |

Targets, not measurements — instrument before claiming them.

---

## 5. Wire protocol

Reuse the existing WebSocket relay and its `{ type, payload, eventId }`
envelope. Three new event types — AG-UI's idea at 1/5 the surface area,
because we have exactly one generative surface.

| Event | Direction | Payload | When |
|---|---|---|---|
| `card_draft` | relay → clients | full card, `state: "drafting"` | Lane 0, immediately |
| `card_patch` | relay → clients | `{ cardId, fields: {...} }` | per field completed in the stream |
| `card_finalized` | relay → clients | `{ cardId, state, degraded? }` | Lane 1/2 done |

`card_patch` carries a sparse field map rather than a JSON Patch — our
document is one flat card, so pointer syntax buys nothing. Existing
`card_created` / `card_updated` / `card_deleted` stay untouched;
`card_finalized` implies an `upsert` on receivers.

Patches are idempotent and last-write-wins per field. Out-of-order arrival
is possible under reconnect: drop any patch whose `eventId` sequence
precedes a `card_finalized` already applied for that card.

---

## 6. Implementation order

Each step ships independently and is separately demoable.

1. **Lane 0 promotion** — `routeInstructionLocally` runs first, always;
   emit `card_draft`. Biggest perceived win, no new schema.
2. **Prompt slimming** — candidate list instead of full graph, prefix
   reorder, `max_tokens` budget, drop the reprompt retry, keep-alive agent.
   Pure cost/latency, no UI change.
3. **`CardBlock` schema** — Swift enum + Codable + lenient decode, JSON
   Schema in the tool definition, `ContextInsightView` reimplemented as
   `.metrics`. Ship with the model *not yet* emitting blocks; verify the
   no-blocks path is byte-identical to today.
4. **Block renderers** — SwiftUI view per case, on `design.md` tokens.
   Flat, no gradients, accent once per card.
5. **Streaming + `card_patch`** — relay-side partial JSON parsing, iOS-side
   patch application with a 120–200ms crossfade per `design.md`.
6. **Response cache + Lane 2 escalation.**

Steps 1–2 are worth doing even if 3–6 never ship.

---

## 7. Non-goals

- **Model-authored layout.** No containers, no style props, no nesting.
  §2 is the whole argument.
- **Multi-turn agent loops for card creation.** One shot. Conversation
  happens through cards, not through a chat transcript.
- **A CopilotKit runtime in front of the model.** An extra hop on the
  hot path to gain an abstraction whose frontend half we cannot use.
- **Client-side model calls.** The relay owns the key and the cache; iOS
  never talks to OpenRouter.
- **Per-user prompt personalisation.** It would break the immutable prefix
  in §4.2, which is worth more than the personalisation.
