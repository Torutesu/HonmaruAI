# Candidate A: shared operations with a separate incoming OAuth authority

Read-only design at 59f58b2f. Goal: Claw, ShogunAI, Claude, Cursor, or any compatible client connects over HTTPS and works in Honmaru as the consenting user. Full Slack capability families are the target, not only the current six decision tools.

## Shape

Keep `/mcp` as the sole protocol endpoint. Make it an adapter over shared application operations. Both browser routes and MCP call the same operation that owns access, data-policy checks, durable persistence, and event delivery. Keep incoming OAuth separate from the outgoing `harness/remoteMcpOAuth.js` client.

Caller usage sketch:

    const principal = await authenticateMcp(request, env)
    const tool = registry.lookup(name)
    const args = tool.parse(arguments)
    await requireScopes(principal, tool.scopes(args))
    const result = await tool.run({ env, principal, request, defer }, args)
    return tool.present(result)

One registry entry owns name, schemas, parser, read/write/destructive/idempotent annotations, scope requirements, handler, and result size bound. Discovery and invocation use the same entries. Legacy decision and Harness entries retain their existing scope meanings. New chat scopes are never inferred from a default `read` fallback.

Principal is a discriminated identity, not a fabricated web session:

    { kind: 'user', orgId, userId, login, name, locale,
      authorization: { kind: 'session', sessionId, ssoBacked }
        | { kind: 'pat', tokenId, scopes, ssoBacked }
        | { kind: 'oauth', grantId, clientId, tokenId, scopes,
            membershipSince, resource, ssoBacked } }

The transport resolves this identity. Every operation derives the workspace and author from it, never from model arguments. Effective permission is user permission AND token scopes AND selected conversation restrictions. `membershipSince` uses the existing membership creation epoch already used by outgoing OAuth. Revocation and removal/rejoin cannot revive a grant.

## Module ownership

- `mcp.js`: JSON-RPC envelope, version negotiation, method routing and standardized results only.
- `mcpTools.js`: static registry; wrappers of existing decision/Harness definitions plus new conversation, people, file, canvas, and list definitions. No duplicate scope lists in UI.
- `mcpScopes.js`: scope metadata, labels, descriptions, prerequisites and permission comparison. Old PAT defaults unchanged.
- `mcpOAuth.js`: incoming registration, discovery, authorization request, consent completion, code/token exchange, refresh, revocation, grant listing. It never delegates to outgoing OAuth.
- `conversationOperations.js`: authorized read/search/send/schedule/canvas/reaction application operations; web routes migrate to these as each operation lands.
- Existing `channels.js`, `canvas.js`, `files.js`, `scheduled.js`, and `harness/tables.js`: persistence and domain mechanics remain here.

Avoid a generic RPC executor accepting route names, SQL, arbitrary user IDs, or session overrides. Avoid moving the whole 2500-line channel router at once. Extract one complete operation per verified slice.

## Shared send contract

`sendConversationMessage(context, { conversationId, body, threadId?, replyToMessageId?, fileIds?, requestId, invokeAgents? })` owns current access, reply/file ownership, DLP, durable message write, dedupe, events and push delivery. It returns persisted message metadata and optional accepted background work. It does not report delivery to recipients as complete.

At channelRoutes.js:1230-1370 the current route owns DLP, file checks, schedule, clientId, responder discovery, durable delivery, webhooks, agent runs, proxies, auto-build and mark-read. Preserve that behavior for the browser source. For MCP reads never mark read. For MCP sends mark-read policy is explicit and default off; external history access must not erase user's unread state.

Do not copy these route blocks into the MCP module. Extract current human send operation, keeping responder handling inside an explicit policy helper. MCP `invokeAgents` is false unless separately granted; never construct a fake session for durable agent dispatch. If agent invocation remains unsupported, return a deliberate refusal when requested rather than claiming parity there.

Retry identity is namespaced by OAuth client/PAT and user, then stored through existing clientId machinery. Same retry key with different normalized payload must return conflict. Preserve exactly-once message persistence and resume existing delivery tasks on replay. A generic HTTP retry must not produce a second message.

Reaction operations use explicit present/absent state. Existing channels.js:538 toggle is unsuitable for retries. Use insert-or-ignore/delete with unique identity, then return actual state and broadcast it. Canvas updates require `baseVersion`; use canvas.js:46 conflict semantics and test simultaneous saves.

## OAuth data model and flow

Use opaque random access and refresh tokens stored only as hashes. Do not mint one existing PAT for every refresh: PAT quota/expiry semantics differ.

Proposed tables:

- `mcp_oauth_clients`: client_id, display_name, redirect_uris JSON, created_at, disabled_at. Public clients use token auth `none` and mandatory S256 PKCE. Fixed registered clients and bounded dynamic registration are possible; DCR provides generic connector UX without operator env changes.
- `mcp_oauth_requests`: id, validated client_id/redirect_uri/resource/scope/state/code_challenge, expires_at. Server-issued request ID keeps the consent screen from reconstructing authorization params from untrusted UI fields.
- `mcp_oauth_grants`: id, client_id, org_id, user_id, membership_since, granted_scopes, resource, sso_backed, created_at, revoked_at.
- `mcp_oauth_codes`: code_hash, grant_id, request_id, code_challenge, redirect_uri, expires_at, used_at. Single use, short TTL.
- `mcp_oauth_tokens`: token_hash, grant_id, kind access/refresh, family_id, expires_at, consumed_at. Rotate refresh atomically; retain consumed refresh rows until family expiry to detect replay and revoke the family.

GET authorization endpoint validates client and exact redirect before any redirect. Require response_type=code, S256, bounded state, supported scope set, and canonical resource `/mcp`. Redirect to the existing Honmaru login/consent page using only request ID. The app obtains request details and lists user's actual workspaces via its existing authenticated session.

POST consent requires the genuine Honmaru session token, current non-guest membership, current workspace SSO/network policy, valid request, and an explicit grant choice that is a subset of requested scopes. The user may select a workspace; client/model must not select an unauthorized one. Consent never issues a token directly to UI. It issues a one-use authorization code and returns a validated redirect URL with original state. Denial returns `access_denied` only to an already-validated redirect.

POST token validates client, redirect, resource and S256 verifier against the code. Consume code with a conditional UPDATE/DELETE RETURNING and atomic issuance transaction. Recheck grant, membership epoch and policy. For refresh, conditional consume/rotate must have one winner; replay revokes token family. Access lifetime around one hour, refresh around 30 days is a proposed policy. No embedded plaintext credentials in URLs, DB logs, audit payloads, or errors.

Revocation marks grant revoked; all token resolution joins that grant, so revoke is immediately effective for subsequent calls without enumerating tokens. Account/workspace deletion and client disable also make resolution fail. UI exposes connected apps, scopes, creation/last-use, and disconnect, separate from legacy API keys.

Discovery includes both `/.well-known/oauth-protected-resource/mcp` and root alias, plus authorization-server metadata. Resource is the configured canonical HTTPS MCP endpoint, not blindly the request Host. 401 advertises protected resource metadata. Registered redirects use exact matching with HTTPS or explicit loopback HTTP for native apps; reject fragments, credentials, wildcards and scheme-relative redirects. Rate-limit registration, authorization, token and revocation independently. Bound all bodies and stored metadata.

## Scope and parity families

- Read scopes distinguish public/private/DM histories and discoverability. Metadata must not reveal conversations excluded from the grant. Search must filter grants in SQL before LIMIT/cursor.
- Send, schedule, reaction write, canvas write, files write, conversation creation, and list write are explicit independent capabilities.
- Users/profile email requires separate permission if exported; use opaque refs already supplied by listMembers.
- Lists map to existing Harness tables/rows with resourceAccess checks. Add create/update table schemas as required for Slack parity, but preserve Harness availability. Do not pretend a Simple workspace has a list product it lacks.
- Canvases map to existing per-conversation canvas read/save with CAS. Standalone shareable canvas creation is a separate product extension, since current model is one canvas per conversation.
- Files reuse existing upload ownership and claims. Two-step upload needs an opaque short-lived upload capability bound to grant, room, MIME, byte limit and file ID. Recheck grant/access when completing. Avoid exporting raw R2 keys. Existing Harness text files cannot satisfy arbitrary attachment upload parity alone.
- Message schedules must bind originating grant and recheck it and destination access at dispatch. A revoked external app must not keep sending scheduled messages.

## Why this shape

Compared with forwarding internal HTTP routes, this design requires deliberate extraction but leaves one owner for DLP, retries, visibility and delivery. It avoids fake session headers and accidental API exposure. It is the better long-term choice for Slack parity because the new integrations become a first-class caller, not a privileged browser impersonator.

Rejected: a second MCP server/service duplicating existing infrastructure; unrestricted REST proxy; mapping legacy read/write scopes to all new capabilities; treating outgoing OAuth as incoming consent; copying route send logic; a blanket `admin` scope to shortcut parity.

## Verification gates

1. Baseline existing MCP/PAT/harness tests unchanged.
2. OAuth flow from discovery through genuine-session consent to token and tool call; wrong verifier/client/resource/redirect rejected; code one-use; refresh concurrent winner; reuse and revoke; remove/rejoin epoch.
3. Tool scope matrix for old PAT, new read-only grant, public/private/DM, guest/removed user, cross-org IDs and hidden references.
4. Real Worker-backed conversation tests with DB and mocked external network, including pagination ties and write retry/DLP/push/live effects.
5. Browser consent screen and real MCP client handshake. A green Worker suite alone is not external-client runtime proof.

No source changes or runtime proof produced for this candidate.
