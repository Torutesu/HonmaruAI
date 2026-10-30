# Thread reply pages

Issue #505. Web inbox/thread-pane and Jam initial opens, plus prefetches, request the newest 50 replies. The title-conflict reload also requests a bounded page while using only its parent. Replies display oldest first; the parent is returned separately. Older pages remain available in both the thread pane and the Activity thread using the same keyboard-accessible control.

## API contract

- `GET /channels/thread?orgId=…&channel=…&messageId=…&limit=50` returns `{parent,replies,more,nextCursor}`. `limit` accepts integers 1–50. Each page returns at most that many replies; the SQL reads one additional sentinel before hydration.
- `before=<nextCursor>` requests older replies. Treat the base64url token as opaque. Its server-side timestamp/rowid boundary survives deletion of the message at that boundary. Both ordering columns define the boundary, so timestamp ties cannot disappear between pages.
- Omitting `limit` preserves the legacy complete `{parent,replies}` response. A cursor without a limit and malformed limits/cursors return 400. This avoids silently truncating old clients; native clients opt in separately.
- `reference=<replyId>` uses the same endpoint for a separate `{reference:ChannelMessage}` response. It checks channel access and a live parent plus a live same-channel/same-thread message, then hydrates only that message. Unknown/deleted/foreign references return 404. The browser displays unloaded quote/link targets in the existing accessible dialog with standard attachment rendering, without inserting an isolated message into the continuous history range.
- Channel/workspace authorization precedes every page or reference lookup. Deleted parents cannot be opened with page cursors; references to deleted rows return no old content.

## Cache and live behavior

The account/server/workspace-scoped cache shares prefetch, open, reopen and page requests. Older pages merge by stable IDs. The oldest loaded cursor stays available across visits and local state updates. Older-only reads retain the latest page's freshness timestamp, so reading history cannot hide newly arrived replies on reopen. Pending and failed sends remain owned by the existing outbox and are reconciled after page reads. Live edits, quote changes, arrivals and tombstones received during any request override the response.

A reconnect starts from the newest page and continues through the oldest loaded message. This fills gaps larger than 50 replies after sleep, refreshes edits/deletions inside loaded history and retains that history. Every request stays at 50 replies; the complete loaded range can require multiple requests. If its oldest message was deleted, revalidation continues past its timestamp, or through the end of a timestamp tie, rather than silently leaving an ambiguous gap. A refresh fails atomically: an offline error retains the prior snapshot and access denial discards it. Newer invalidation restarts a pending older read as a latest-range refresh.

Jam reuses the scoped cache and joins the main pane's debounced reconnect refresh. Older-page insertion captures and restores the current thread log offset. The common thread body supplies the control in both inbox and side pane. Unloaded Activity, message links and quoted replies request only the referenced message for a focus-managed context dialog.

## Index and remaining summary cost

`idx_channel_thread_page` is `(org_id,parent_id,created_at) WHERE deleted_at IS NULL`. SQLite includes rowid as the final index tie-breaker. The query uses reverse index order for newest-first pages. A cursor first seeks its equal timestamp with `rowid < boundary`, then fills any remainder using earlier timestamps; the partial index excludes arbitrarily dense soft-deleted tails. The migration creates the index after adding legacy thread/deletion columns. The benchmark applies the schema and relevant migration indexes in that order. No live migration was run.

Pagination bounds displayed reply hydration/signing and file/reaction lookup IDs to the parent plus 50 replies. This branch still uses the existing `hydrate()` reply-summary query for the parent: it reads all matching replies to calculate counts/participants. Its scan cost is separate and is addressed by the backend-summary work (#504/#506), not by the page limit. Do not interpret the reply SELECT benchmark as a measurement of the complete endpoint.

## Reproducible synthetic query benchmark

Run `python3 worker/scripts/benchmark-thread-pagination.py --output /tmp/thread-pages.json`. It extracts the actual `listThread` SQL and loads the repository schema into an in-memory SQLite database. No production credentials, requests or data. It tests 0, 1, 50, 1,000 and 10,000 visible replies, timestamp ties, 5% deleted replies and 10,000 unrelated messages.

Fixture run: Python 3.12.7, SQLite 3.45.3, macOS-15.8.1-arm64-arm-64bit. Three warmups, 15 sequential samples; p50 is median and p95 nearest-rank. Query timing covers execute/fetch/materialization only. Host scheduling is uncontrolled. JSON bytes are compact raw SQL-row JSON (including the sentinel/internal columns), not HTTP response bytes. SQLite VM instructions are counted separately from timing and are not D1 billed rows read.

| Visible replies | Full rows / SQL-row bytes | Page SQL rows / bytes | Full p50 / p95 ms | Page p50 / p95 ms | Page VM instructions |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 / 2 | 0 / 2 | 0.002 / 0.002 | 0.002 / 0.002 | 21 |
| 1 | 1 / 912 | 1 / 912 | 0.004 / 0.007 | 0.004 / 0.005 | 77 |
| 50 | 50 / 45,592 | 50 / 45,592 | 0.093 / 0.116 | 0.090 / 0.098 | 2,870 |
| 1,000 | 1,000 / 912,894 | 51 / 46,565 | 1.843 / 1.988 | 0.093 / 0.098 | 2,925 |
| 10,000 | 10,000 / 9,138,895 | 51 / 46,616 | 20.953 / 21.625 | 0.095 / 0.099 | 2,925 |

Every page plan uses the thread index without `USE TEMP B-TREE`. The 1,000 and 10,000 fixtures both execute 2,925 SQLite VM instructions for the page SELECT, return 51 SQL rows and present at most 50 replies. Tests also check the cursor query plan and a dense deleted tail. The benchmark additionally puts all 10,000 replies at one timestamp and checks near/deep rowid seeks. A tuple `(created_at,rowid) < (?,?)` alone would still scan the full tie; the two disjoint bounded seeks avoid that scan. File-query instrumentation checks that only the parent and returned 50 IDs are hydrated; returned attachments have signed addresses.

This is local synthetic SQL evidence only. It does not measure D1 billed reads or latency, Worker CPU/hydration/decryption, HTTP response size, network, browser rendering, native UI, devices or production thread distributions. No production speedup or end-to-end latency is claimed. Native and Expo verification is reported separately by their owning workstreams.
