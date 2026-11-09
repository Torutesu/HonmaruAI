# Message loading and send admission

Investigated from main `2f456b718a25f3fddf33c20402ea3ae4815f37d9` on November 9, 2026. This change removes verified work from the request path. It does not establish production p50/p95 latency or Discord/Slack parity.

## Confirmed bottlenecks

- `GET /channels` awaited provider discovery and AI translation of sidebar previews before returning members, DM references, and read positions. A model call has a 45-second timeout and translation may take multiple batches. The directory now returns cached translations immediately; uncached foreign previews include a sanitized `last` message for the web client's existing background translation path. Other clients may initially display the original preview. Source rows containing internal logins remain server-only.
- `present()` independently resolved avatar access for every agent message, even when all messages had the same author and viewer. The pending avatar lookup is now shared per agent within that presentation. A subsequent presentation rechecks access, so this introduces no persistent permission cache.
- Membership/user reads and business/deletion-fence reads were serialized although each pair is independent. The pairs now start together on paths used by both reading and sending. Membership, workspace policy, guest/private access, deletion fencing, DLP, durable message writes and delivery receipts remain enforced.

The sender already renders a pending message before the HTTP response. Sends in one conversation are queued in order, so slow acknowledgment of one message also delays later queued sends. This patch reduces admission dependencies; it does not remove ordering or prove that the whole production send delay is solved.

## Reproduction and query-count evidence

`worker/test/message-loading-latency.test.js` reproduces the bottlenecks with the real Worker and local D1 test runtime. Its query counter wraps bound D1 calls during message presentation. The fixture is a no-file/no-reply page from one team agent with an avatar, for one viewer. It counts database statements, not network round trips or end-to-end milliseconds.

| Messages in presentation | Original statements | Patched statements | Avatar profile reads, original/patched |
| --- | ---: | ---: | ---: |
| 1 | 7 | 7 | 1 / 1 |
| 50 | 154 | 7 | 50 / 1 |

Before the fix, the 50-message test failed with `expected ... length of 1 but got 50`. The directory test raced its response against a deliberately held provider-settings read; the provider read won before the fix. After the fix the directory response wins without entering provider discovery, and supplies the original preview plus translation source. These are dependency gates, not timing benchmarks. Independent-lookup gates also failed before the corresponding changes.

Run with pnpm from `worker`:

```sh
pnpm exec vitest run test/message-loading-latency.test.js test/backend-latency.test.js test/translate.test.js test/channels.test.js
```

Validation performed:

- 14 Worker suites, 135 tests passed, covering message delivery, translation, channel creation, private rooms, avatars, session policy, SSO, SCIM, guests, and the initial five targeted checks.
- Final targeted rerun: 15 tests passed across the six regression checks and translation suite, after adding history `Server-Timing` headers.
- Four web cache/activity/translation suites: 48 tests passed. Web source was not changed.
- No production messages were sent, production DB configuration changed, deployment performed, or native builds run.

## Production measurement still needed

A signed-in live page was inspected, but the browser automation's read-only evaluator did not expose Resource Timing. No authenticated HTTP trace or production send timings were obtained; browser tool round-trip duration would not be valid app latency evidence.

After deployment, capture actual history GET and ordinary send POST requests in browser Network tools, without publishing session headers or message bodies. Record multiple cold and warm samples of time to visible cached content, response completion, server acknowledgment, and receiver delivery. History responses now expose `caller`, `members`, `resolve`, `messages`, and `total` in `Server-Timing`; sends already expose policy/routing/write/read/present/total. Separate these server stages from DNS/TLS/network and UI rendering. Verify both a normal human channel and an agent-heavy channel, plus a thread, before attributing residual delay to the database engine or recommending a migration.
