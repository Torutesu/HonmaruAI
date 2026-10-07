# Channel message cache

The shared desktop/web chat used to fetch the latest 150 messages on every channel selection. This was a newest-page request, not the entire history, but switching away from the chat also discarded its in-memory state.

The client now keeps up to 30 channels × 300 confirmed messages per session cache, with at most four server/workspace/session scopes. Nothing is written to disk. Returning to the chat renders cached messages immediately. Logout clears all scopes; account/workspace/session changes remount the chat with the appropriate cache. Pending sends remain the existing outbox's responsibility.

Channel selection reuses a successfully fetched page for 60 seconds and coalesces simultaneous requests. New messages, edits, reactions and deletions continue to update the cached view through existing socket events. Reconnection invalidates every channel in the current scope, then refreshes the open one; other channels refresh when opened. Leaving the chat invalidates freshness because its event listener is no longer active. Explicit refreshes after card creation and forwarding remain supported.

Background revalidation fetches the newest page, not a new backend delta endpoint: edits, deletions and missed events must still be reconciled. An in-flight response cannot overwrite newer live changes or resurrect a live deletion. A complete empty response clears messages removed while offline. Older loaded pages are retained unless the newest page reveals a gap; pagination remains available after cache truncation.

Validation: 655 web unit tests, TypeScript/Vite build, and a CUA fixture using the real ClassicList with a 700 ms API delay. Alpha → Beta → Alpha left GET counts at 1/1; live arrival preserved those counts; reconnect changed them to 2/1; remount kept the messages visible while refreshing to 3/1. Fixtures do not establish native iOS/Android caching; this change targets Mac/Windows/shared web clients.
