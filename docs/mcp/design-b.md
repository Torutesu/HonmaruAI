# Candidate B: an internal route adapter with an explicit principal

Goal: Claw, ShogunAI, and other internet clients connect through MCP and act as a consenting Honmaru user. This design examines route reuse instead of immediately extracting domain services. Source inspected at `59f58b2fd7615dcce0da83a35938c937e2d3017a`. No application code changed.

## Candidate shape

The MCP tool registry maps each tool to an allowlisted operation, its input parser, permission requirement, HTTP route adapter, and output projection. The adapter constructs a Request from validated tool arguments and calls the existing route handler in-process. It never forwards caller-controlled HTTP paths, credentials, org IDs, or headers. It never creates a web session.

Use an explicit actor union:

```ts
type Actor =
  | { kind: 'session'; userId: string; workspaceId: string; session: RealSession }
  | { kind: 'mcp'; userId: string; workspaceId: string; grantId: string;
      clientId: string; scopes: ReadonlySet<string>; membershipEpoch: string };

type RequestAuthority = {
  actor: Actor;
  user: CurrentUser;
  operation: OperationName;
};

handleChannels(request, env, url, { route, after, authority });
```

Only the token resolver constructs the MCP principal. A route must revalidate current membership, workspace status, grant revocation, and its operation's permission. `authority` cannot originate in parsed HTTP JSON. Existing session callers use the current path when authority is absent. Scope checks happen before calling a route and again at any resource boundary where private/DM access depends on the resolved target.

The route adapter is deliberately not a generic HTTP tool. It can dispatch only registry-listed operations. A token cannot invent `/channels/agents`, `/channels/share`, a workspace ID, or a permission override.

## Necessary code changes

1. Add `worker/src/mcp/registry.js` for explicit schemas, required scopes, annotations, handlers, and result projections. Old decision/Harness tools remain available under their existing scope contract. There is no default unknown-tool-to-read mapping for new tools.
2. Add `worker/src/mcp/principal.js` to resolve and revalidate PAT or OAuth credentials into the actor union. Leave browser-session validation in its existing owner. Common current-user/workspace checks can be shared, but browser idle/reauth policy is not represented by a fictional session.
3. Add a narrow `worker/src/mcp/channelAdapter.js`. It accepts an operation, validated arguments, and an MCP principal, constructs exact channel routes, and returns compact MCP results. It carries the real request context for workspace IP checks and audit attribution.
4. Modify `channelRoutes.js::caller` and `inChannel` to accept trusted authority. More than 40 existing session references mean this is not merely a single optional argument. Replace identity reads such as `who.session.github_id` with `who.actor.userId`. Retain an actual `who.session` only for web-only operations.
5. Update send orchestration to distinguish message acceptance from UI side effects. MCP reads and sends must not silently mark the user's chat as read. External sends must not launch session-bound agent automation without a separately defined grant.

## Advantages

- Existing DLP checks, file ownership, scheduling, live/push delivery, and established error handling remain on one route.
- Small surface-specific additions can reuse mature behavior without copying large functions.
- A whitelist makes MCP capability review possible without reading every application route.

## Costs and red flags

The route has UI semantics that are wrong for MCP. `channelRoutes.js:1365` marks a channel read on send. Lines 1293-1358 discover/respond to agents, call @AI, trigger proxies, and run autoBuild, sometimes with `who.session.token`. Lines 1230-1340 combine validation, side effects, HTTP shape, presentation, and orchestration. Injecting an actor is therefore not enough.

Search and discovery can return information outside a restricted grant unless the grant enters the underlying query before LIMIT. Filtering a route's final JSON is insufficient. The new scope predicate must reach `searchMessages` and channel discovery itself.

The route is a broad interface. External users can indirectly exercise code that future engineers assume is browser-session-only. A default adapter parameter or a global ambient principal would hide that risk. A WeakMap or AsyncLocalStorage actor override saves edits but makes the authorization contract less visible and is rejected for this candidate.

`toggleReaction` cannot implement retryable add/remove tools. Exact desired-state operations still need a domain change.

## Comparison with shared-operation extraction

| Criterion | Route adapter | Extracted shared operation |
| --- | --- | --- |
| Initial reuse | Reuses HTTP orchestration directly | Moves only the required acceptance logic |
| Session dependency | Requires actor threading and browser-only branches | Explicit actor passed to operation |
| UI side effects | Must suppress read receipts/automation in route | Kept outside shared operation |
| Grant filtering | Still requires changes below route | Natural operation input |
| Future maintenance | New browser route behavior can leak into MCP | Operation contract controls both callers |
| Files/lists/documents | Each route needs separate adaptation | Existing domain functions already usable |

Recommendation: use the shared-operation candidate for sends and reads, even though this alternative is viable. A route adapter earns its place only when the route is already thin, has no UI side effects, and its result contract matches the external tool. Do not build a general route proxy.

## OAuth architecture for either candidate

Keep incoming OAuth separate from `harness/remoteMcpOAuth.js`, which is an outgoing OAuth client. Mount one incoming module under `/mcp/oauth/*`, with metadata under the standard well-known paths. Existing `/mcp` dispatch receives the resulting principal.

Use a registered-client table with exact redirect URIs and client type. Public clients require S256 PKCE and no pretend client secret. Confidential clients require their registered authentication method as well as PKCE. Start with explicit client registration managed by an authenticated developer/admin flow; unrestricted dynamic registration is not needed for Slack-style parity.

Persistent records:

- `mcp_oauth_clients`: ID, display name, exact redirect URI list, authentication method, hashed confidential secret if supported, enabled/revoked state.
- `mcp_oauth_requests`: opaque request ID, validated client/redirect/resource/scope/challenge/state, creation and expiry. No grant yet.
- `mcp_oauth_grants`: user, workspace, client, exact granted scopes, membership creation epoch, SSO provenance, creation/expiry/revocation.
- `mcp_oauth_codes`: only code hash, grant/request binding, S256 challenge, exact redirect/resource, expiry, consumed state.
- `mcp_oauth_access_tokens` and `mcp_oauth_refresh_tokens`: only token hashes, grant/family IDs, expiry, revocation, refresh-use state. Access-token validation joins current grant and membership.

Flow:

1. `GET /mcp/oauth/authorize` validates client, exact redirect, `response_type=code`, resource audience, requested scopes, and S256 challenge. Invalid redirects never receive redirects.
2. Store a short-lived request and redirect to the existing Honmaru web app's consent route with only the opaque request ID. Login must preserve that request ID.
3. Logged-in app fetches a consent preview via its real session. Display verified client identity, selectable workspace, and human-readable scope groups. Never auto-approve from a page load.
4. Consent POST requires the user's actual session, fresh workspace policy checks, current membership, and a subset of the requested scopes. Grant and single-use code creation bind this exact user/workspace/client/redirect/resource/PKCE request.
5. Redirect to the registered client URI with the code and exact original state. No bearer token enters the browser URL.
6. Token exchange validates code, redirect, client method, audience, and verifier before atomic consumption. Use compare-and-swap or one transaction so concurrent exchanges yield one successful token set.
7. Refresh rotates tokens atomically. Reuse of an already-used refresh token revokes that token family. Grant revocation stops all associated tokens. Removal/rejoin must not reactivate the original grant because its membership epoch changed.

Do not implement refresh with a SELECT followed by an unguarded UPDATE. Do not pass browser `x-session-token` to an external redirect. Do not treat user-granted scopes as the user's current role. All tool calls apply both.

## Verification gates

- Baseline existing decision/Harness tests remain green; legacy read/write tokens see no chat tools.
- Tool arguments cannot alter actor, workspace, route, or scopes.
- Search/discovery/private refs respect grants before pagination.
- MCP send preserves DLP, exact-parent checks, deduplication and live/push delivery, but does not mark read or invoke session-based agents accidentally.
- Concurrent same-key send yields one persisted message. Add/remove reaction retries preserve desired state.
- OAuth malformed redirect, missing/wrong PKCE, cross-client code, wrong audience, expired request/code, duplicate exchange, refresh replay, revoked grant, removed/rejoined member, mixed-case guest, SSO-policy change, and unauthorized workspace all fail without data leaks.
- Real consent UI and an MCP client demonstrate initialize/list/read/send/revoke in an isolated workspace before deployment compatibility claims.

Configured model families were unavailable; this candidate used the inherited model. This report contains design reasoning and source evidence, not execution proof.
