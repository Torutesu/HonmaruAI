# Hosted Honmaru MCP connector

## Connect an external agent

The endpoint is the deployed Worker origin followed by `/mcp`. It uses Streamable HTTP with JSON responses and MCP protocol version `2025-11-25` (also negotiates `2025-06-18` and `2025-03-26`). It does not require custom headers: OAuth clients use `Authorization: Bearer <access-token>`. There is no persistent SSE session or server-initiated subscription.

1. In Honmaru, open Studio → API & Webhooks → MCP connections. Register your agent application's name and its exact OAuth callback URL. Copy the generated client ID into that application's MCP OAuth configuration. Registration requires a signed-in Honmaru account; arbitrary anonymous dynamic registration is not enabled.
2. Configure the agent's remote MCP URL and registered client ID. The agent discovers the authorization server, generates an S256 PKCE challenge and state, and opens the authorization URL in the browser.
3. Sign in to Honmaru if necessary. The pending request survives login in the same tab. Check the app name, callback domain, and client ID; choose a workspace and permissions. Only public conversation reading is initially selected when requested. Private channels, DMs, writes, files, and lists require explicit selection.
4. The client exchanges the returned code with its verifier, then calls `/mcp` with the access token. Store the refresh token securely and replace it after each refresh. Concurrent refreshes must be serialized: reuse of an already consumed refresh token revokes the connection.
5. Disconnect an app in the same settings panel. Revocation, workspace removal/rejoin, applicable SSO/SCIM policy, and client disabling prevent later calls. A queued send also requires the original authorization when its delivery runs.

Claw and ShogunAI can use this flow if their remote MCP integration accepts a registered OAuth client ID and authorization-code PKCE. Named-client interoperability has not yet been demonstrated. A client that only supports anonymous dynamic registration needs an adapter or future registration support; do not invent a client ID. Existing developer personal-token clients can continue using Bearer or `x-honmaru-token`; legacy `read`/`write` grants do not acquire conversation access.

## Deployment configuration

- Set `MCP_PUBLIC_URL` to the canonical HTTPS URL ending in `/mcp`, without query or fragment. Metadata and token audiences use it. The request origin is a local/test fallback.
- Set `APP_WEB_URL` to the web application URL used for login/consent and message source links.
- For an agent running inside a browser, explicitly allow its origin in `MCP_CORS_ORIGINS` (comma or whitespace separated) or the existing app CORS configuration. Token, revocation, MCP, upload and protected download endpoints reject unlisted browser origins. Server-side clients normally send no Origin.
- The normal deploy applies `schema.sql` and the idempotent statements in `migrations.sql`; both include connector storage. The standalone `mcp-oauth.sql`, `mcp-chat.sql`, and `mcp-content.sql` also support focused test fixtures. Do not deploy only the JavaScript without the schema.
- The existing scheduled handler sweeps expired OAuth records in bounded batches. Existing attachment cleanup handles abandoned unshared file objects. Retry receipts and cancelled schedule keys are retained so an old request cannot silently execute again.

## Capability mapping

All new tools use the same explicit scope metadata for discovery and execution. Tool arguments cannot set the user, workspace, or scopes.

| User task | Tools | Permission / boundary |
| --- | --- | --- |
| Discover/search conversations | `list_conversations`, `search_messages` | `chat:read`; user access and audience grants filter before pagination |
| Read messages and threads | `read_channel`, `read_thread`, `get_message` | `chat:read`; full timestamps and message links; no read receipts |
| Send and reply | `send_message` | `chat:write`; same DLP, ownership and durable live/push delivery operations as the web send path |
| Schedule/cancel sends | `schedule_message`, `list_scheduled_messages`, `cancel_scheduled_message` | `chat:schedule`; text and thread replies; no scheduled attachments or inline message references |
| Reactions | `get_reactions`, `add_reaction`, `remove_reaction` | `chat:read` for reads; `reactions:write` for changes; retries ensure desired state |
| Create channels or open conversations | `create_conversation` | `channels:write`; existing product permissions apply |
| People, profiles, membership, emoji | `search_users`, `get_user`, `list_channel_members`, `list_emoji` | `users:read`; opaque member references, no login email export |
| Files | `search_files`, `get_file`, `read_file`, `get_file_upload_url`, `complete_file_upload` | `files:read` / `files:write`; workspace filename search or one conversation; protected downloads |
| Canvas | `read_canvas`, `create_canvas`, `update_canvas` | `canvases:read` / `canvases:write`; one Markdown canvas per conversation, exact-version edits |
| Lists/records | `list_lists`, `read_list`, `create_list`, `update_list`, `add_list_record`, `update_list_record` | `lists:read` / `lists:write`; existing Harness tables and resource/build permissions |

`chat:private` and `chat:dm` are additional audience grants, not substitutes for membership. They apply to messages, files, canvases, and conversation membership reads. Read access includes permitted history from before the connector was added.

Uploads use a tool to reserve a URL, an authenticated raw-byte PUT (up to the existing 25 MiB limit), then completion. Completion does not share the file; pass its ID to `send_message` to share. Text reads are limited to UTF-8 text up to 128 KiB; other files use the authenticated content URL. The JSON-RPC body limit is 1 MiB. New tool results are bounded to 190,000 serialized bytes; request smaller pages if needed.

## Deliberate product differences

This covers Slack-like capability families using Honmaru product primitives, not identical Slack APIs. There are no standalone shareable canvases; lists require Harness mode and support its column types. Agent-only conversations are excluded. Sending `@AI` text does not launch a Honmaru agent or fabricate a browser session. Conversation discovery lists existing channel rows and DMs with message history; opening an empty DM returns its ID but it appears in discovery after a message exists. Channel creation and administrative permissions remain the user's existing ones. An AI client can draft and preview message text before calling send_message; there is no connector tool for server-persisted drafts. Administrative/destructive workspace management is outside this connector scope.

## Verification boundary

Implementation and tests use local Cloudflare Worker/D1/R2 and actual Worker entry points. OAuth consent, PKCE, rotation/replay, revocation, audience isolation, policy-failure denial, request validation, preflight/CORS, protected upload/download bytes, legacy-scope isolation, retry safety, and replayed deployment schemas are exercised. See `decisions.tsv` for exact runs. Source review or local SDK tests do not establish production deployment, internet reachability, push delivery to a physical phone, or compatibility with any named client. The independent parent validation records official SDK and browser checks separately.

Reproduce the official SDK check with `pnpm exec node worker/scripts/prove-mcp-client.mjs` after installing the existing Worker dependencies with pnpm. It installs pinned SDK 1.32.2 into its own temporary directory, generates two temporary tests under `worker/test`, and removes only those directories afterward. To reuse an installation, set `MCP_SDK_DIR` to the package directory containing the SDK's `dist/esm` directory. The tests drive the real SDK transport against `Worker.fetch` with local test credentials and storage; they never contact a production Honmaru workspace.
