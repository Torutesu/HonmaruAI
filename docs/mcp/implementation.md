# Hosted Honmaru connector implementation

## Outcome

An external MCP client connects over HTTPS, obtains the user's consent for one workspace and named capabilities, searches and reads allowed Honmaru conversations, and performs authorized actions as that user. Revocation and membership changes stop access. Existing personal keys keep their original permissions.

Parity means equivalent user tasks to Slack MCP, not identical tool names or storage. Target conversation search/history/threads, people/channels/emoji discovery, message send/schedule/reactions, files, canvases, and lists. Preserve Honmaru decisions and Harness features.

## Completion checks

- Protocol tests exercise initialize, tools/list, and tools/call through the actual Worker entry point.
- User grants limit all tool calls, including guessed IDs and search results.
- An OAuth test client completes PKCE authorization and uses its token on /mcp. Replaying codes and revoked or wrong-audience credentials fail.
- Reads are bounded and preserve IDs, timestamps, ordering, and usable source links.
- Retried writes do not duplicate messages or undo reactions. Chat writes preserve DLP and delivery behavior.
- Feature parity is recorded per capability with its test, limitation, and deployed status. No untested client compatibility claim.

## Throughput checkpoint

- Blocking first steps: compare architecture alternatives, establish actor/scope contracts, capture existing MCP tests.
- Independent workstreams: chat operations, OAuth lifecycle and consent, and content/list tools after the shared contract is fixed.
- Shared mutable state: one implementation owner coordinates the registry and route integration. Delegates use isolated worktrees and owned modules. Test execution serializes if local Worker runtimes contend.
- Smallest safe decomposition: one owner integrates the coupled connector feature; delegates implement bounded modules. No production deployment or account configuration changes are part of this run.

## Architecture rubric

Compare shared application operations against a route adapter using explicit principals. Grade each 0-2 on reuse of authorization/DLP/delivery, absence of manufactured user sessions, resistance to grant bypass, testability, and amount of unrelated code disturbed. Select the simplest design that preserves every boundary. Cross-family review is unavailable because this environment exposes only GPT models; record that limitation.

## Work sequence

1. Existing subsystem investigation and two architecture sketches.
2. Scope registry, authenticated actor contract, protocol baseline.
3. Chat read and write tools with pagination and retry tests.
4. OAuth authorization server and browser consent/revocation UX.
5. Files, canvases, lists, channel and member operations using existing domain code.
6. Worker/client integration checks, independent review, corrections, and reviewable GitHub PR.

Each stage records its evidence in decisions.tsv. Acceptance requires evidence rather than a tool count.
