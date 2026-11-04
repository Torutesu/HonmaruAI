# Honmaru MCP scope and implementation proposal

Inspected `Torutesu/HonmaruAI` main at `59f58b2fd7615dcce0da83a35938c937e2d3017a` on 2026-11-04. This is an investigation and proposal. No application code changed.

## Recommendation

Let external agents search Honmaru conversations, read the relevant thread, and send an authorized reply without opening the app. Extend the existing `/mcp` server and its connection settings. The main missing feature is conversation tools. OAuth installation is a separate addition.

Confirmed on 2026-11-04: external agents act as the authorizing user, with the external client identified in audit records. This matches the existing personal token model. Claw, ShogunAI, and other MCP-capable applications connect over the internet as a connector/plugin, with workspace selection, explicit permissions, and revocation. The target is Slack MCP capability parity, including OAuth connection UX.

## What Slack exposes

Slack documents search across messages, files, people, and conversations; channel and thread history; sending and scheduling messages; reactions; conversation creation; canvases; files; and lists. Its hosted endpoint uses Streamable HTTP, user OAuth grants, and operation-specific scopes. Registered client applications provide admin approval and attribution. [Slack MCP overview](https://docs.slack.dev/ai/slack-mcp-server/).

The useful initial parity target is finding context and replying to it. Canvas editing, list operations, uploads, and channel creation can follow. Honmaru already has its own decision and Harness features to retain.

## What Honmaru already has

All source links below are pinned to the inspected commit.

| Component | Existing behavior | Evidence |
| --- | --- | --- |
| Incoming MCP | Stateless JSON responses at `/mcp`; initialize, ping, tool discovery, and tool calls. GET returns 405 because no event stream is offered. | [mcp.js](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/mcp.js#L398) |
| Simple workspace tools | Six tools: request/read/search decisions, list pending decisions, list members, read playbook. No chat tools. | [tool definitions](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/mcp.js#L203) |
| Harness tools | Another 23 built-in tools cover files, app/table operations, workflows, follow-ups, and execution. Enabled remote tools can also appear. | [Harness registry](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/harness/mcpTools.js#L19) |
| Personal tokens | Workspace/user-bound `hm_` tokens, stored as hashes, expiry, revocation, live membership checks, guest rejection, SSO and network restrictions. | [token implementation](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/mcp.js#L90) |
| Connection UI | Token creation/revocation, Claude Code command, generic HTTP MCP configuration. | [Tools.tsx](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/web-react/src/screens/Tools.tsx#L307) |
| Outgoing MCP | Honmaru connects to other MCP servers, including OAuth. This does not authorize external clients to access Honmaru. | [remoteMcpOAuth.js](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/harness/remoteMcpOAuth.js) |

The six Simple tools become 29 built-in tools in Harness before scope filtering and remote additions. This count does not imply that every token sees all tools. `schedule_followup` schedules an instruction, not an exact chat message.

## Proposed first release

Add these tools in both Simple and Harness workspaces. Names are proposed contracts, not existing exports.

| Tool | Contract |
| --- | --- |
| `list_conversations` | Discover authorized channels. Filter by name/type and return bounded pages. Private channels and DMs require separate grants. |
| `search_messages` | Search authorized history with text, author, channel, and date filters. Return message IDs, timestamps, thread IDs, context, and valid citation links. |
| `get_message` | Read a message by stable ID after checking its conversation and the current grant. |
| `read_channel` | Read a bounded page of channel messages with an opaque continuation cursor. |
| `read_thread` | Return the parent and a bounded reply page, preserving full dates and stable ordering. |
| `send_message` | Send to an exact conversation, optionally with `threadId` or `replyToMessageId`. Require a retry key. Return the persisted message and link. |
| `add_reaction` | Ensure the caller's specified reaction exists. Retrying must not remove it. |
| `remove_reaction` | Ensure the caller's specified reaction is absent. Retrying must not add it. |

Reuse `list_members` for people discovery initially. Rich profile fields, exact message scheduling, message edits/deletion, channel creation, and general attachment upload are later work. Existing decision, file, table, and workflow tools remain available under their existing rules.

Every read result needs a bounded size, stable IDs, an explicit continuation when more data exists, and source links that open the actual message. Return original text as source truth; any translation must be a separately labelled field. Reading through MCP should not mark chats as read.

## Permission contract

Effective access is the intersection of the token's workspace, the user's current permissions, and the granted MCP scopes. A tool argument must never substitute a different workspace or user.

Add explicit chat grants rather than expanding old `read` and `write` keys. Proposed grants distinguish public message reads, private message reads, DM reads, message sends, and reaction writes. Apply the same conversation grants to discovery, search, individual messages, thread parents, quoted references, and attachments. Filter by grants before pagination, rather than fetching unauthorized rows and filtering afterward.

Default initial chat consent to public-channel reads. Private conversations, DMs, and writes require deliberate selection. Keep execution and outgoing remote-tool proxies outside the default chat grant. Preserve current guest rejection initially.

The prior #660 discussion concerned agents installed inside Honmaru channels. Those installation rules are not automatically the policy for external clients acting as a user. DM opt-in and the unresolved private-source redistribution choice still need a product decision before a broader rollout.

## Reuse the existing chat path carefully

- [resolveChannel](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/channels.js#L66) resolves viewer-specific conversation IDs and enforces access. Preserve opaque member references rather than exposing stored DM login keys.
- [listMessages and listThread](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/channels.js#L375) already supply history and thread paging. MCP must use the bounded thread mode. The legacy unpaged mode still exists.
- [searchMessages](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/channels.js#L1231) supplies query filters and visibility checks. It currently caps results at 50 without a continuation cursor and uses SQL LIKE. Add stable pagination; measure representative large-workspace queries before choosing a new search backend.
- [message submission](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/channelRoutes.js#L1229) checks outgoing data rules, validates uploads and retry IDs, persists delivery tasks, and wakes live/push delivery. Calling `postMessage` alone would skip route-level behavior. Extract the minimum shared application operation for the web route and MCP adapter, with explicit authenticated actor context.
- [toggleReaction](https://github.com/Torutesu/HonmaruAI/blob/59f58b2fd7615dcce0da83a35938c937e2d3017a/worker/src/channels.js#L538) is a UI toggle. Add/remove tools need explicit desired state and concurrency-safe persistence.

Decide whether external messages may invoke `@AI` before enabling it. Current durable agent dispatch can depend on a web session token. Do not fabricate a browser session or accidentally trigger agent runs from copied text.

## Delivery sequence and acceptance

1. **Tool and permission foundation.** Use one explicit registry for schemas, handler, scope, and annotations. Remove the implicit unknown-tool-to-`read` fallback for new registration. Update connection consent. Test that existing keys retain exactly their former permissions.
2. **Conversation reads.** Implement discovery, search, message, channel, and thread tools using current access checks. Test public/private/DM isolation, cross-workspace IDs, revoked access, deleted parents, same-timestamp pagination, quoted messages, and bounded output. Historical access must not depend on when an external client connected.
3. **Message and reaction writes.** Share the validated send operation. Test DLP refusal, duplicate and concurrent retries, changed payload with reused retry key, reply target permissions, live delivery, notifications, and explicit reaction state. An accepted write must return its persisted ID, not claim that another user already saw it.
4. **OAuth and connection UX.** Add incoming protected-resource metadata, authorization-server metadata, authorization-code consent with PKCE, audience-bound tokens, expiry, refresh/revocation, and client registration policy. Start with registered clients; dynamic registration is optional. Preserve PAT setup for developer clients. Adapt existing connection UI and document each tested client's actual configuration. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
5. **Client acceptance and later parity.** Exercise a real client from discovery through read and authorized reply in a test workspace. Then add scheduling, richer files/profiles, and channel management as separate slices. Do not claim Claude, Cursor, or Codex compatibility solely from generic JSON configuration.

Protocol work belongs in the first slice. Test negotiated versions, Origin handling, request schemas, structured tool results, annotations, unsupported methods, and bounded errors. Current code advertises older versions, strips annotations in discovery, and truncates batches to 20. Define and test a supported transport contract. Stateless JSON responses are valid; a persistent SSE stream is not required. [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Audit calls by client/token, user, workspace, tool, target ID, outcome, and duration. Avoid recording private message bodies or credentials. Apply per-action rate limits so batching and retries cannot multiply writes beyond the intended limits.

## Historical investigation evidence and limits

- Fresh shallow checkout matched remote main at the SHA above. The maintained checkout was left unchanged.
- At the initial read-only investigation, existing MCP, scope-validation, and Harness tests were inspected but not run. Dependency installation failed with `ENOSPC`; temporary installed dependencies were removed.
- Unauthenticated HTTP probes to the documented Worker hostname returned Cloudflare error 1010. Those responses do not prove the deployed MCP or OAuth route behavior.
- No tokens were minted, production conversations read, messages sent, or application code changed.
- pstack Investigation/how workflow used two code explorers and a synthesis review. Its configured model families were unavailable in this environment; agents inherited the available parent model.
- Throughput checkpoint: n/a, read-only investigation.
- Applied pstack principles: Subtract Before You Add led to extending the existing endpoint and setup UI. Prove It Works kept source evidence separate from client/runtime acceptance.

Implementation and later verification supersede that initial investigation snapshot; see [connector.md](connector.md) and [decisions.tsv](decisions.tsv).
