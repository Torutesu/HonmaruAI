# Agent handoff implementation contract

Status: assignment persistence and current-origin/target grant helpers are implemented locally with targeted tests. Runtime integration, delivery, control tool and chain UI remain incomplete; KY-018/KY-019 remain incomplete. No handoff tool or leader selector is exposed.

## Evidence and current behavior

Rechecked 2026-10-24:
- https://docs.kylon.io/concepts/rooms: explicit agent mentions can activate another agent; ordinary status messages do not create reply loops. There is no separate user-facing Orchestrator selector.
- https://docs.kylon.io/cli/workspace/thread: activation selects an eligible room member, replies can request routing or direct activation, and notify-only suppresses activation. Activation reports whether work actually started. A new isolated thread omits preceding-room context but is not a new security boundary.
- `customAgents.respondingAgents` supports human explicit mentions and limited new-request routing. `channelRoutes.runAgents` executes selected agents concurrently and posts outputs without routing those outputs to other agents. Thus an agent mentioning another agent currently does not implement a handoff.
- `AgentRunner` has idempotent enqueue receipts for human requests and room hooks. It has no ownership generation for a thread or per-handoff execution identity. Normal jobs now persist execution results before removal; a recovered running result becomes interrupted without rerunning external work. This is separate from assignment ownership.
- `roomHookDispatch` provides a useful durable outbox pattern: bounded leases, retry of delivery only, and acceptance only on an explicit queue response. Do not conflate accepted delivery with successful execution.

## Required runtime contract

1. Preserve Simple's existing routing. Harness handoff must be an explicit runtime operation, not regex-triggered routing of every generated answer. An ordinary agent status reply remains inert.
2. Bind handoff to a persisted origin human request, source agent, canonical room/thread, target agent, and immutable brief. Validate current workspace/session, room participation, agent access and target room membership before acceptance, dispatch and each execution stage. Agent instructions do not confer the target owner's private connections or broader rights.
3. The invoking run must own the current assignment generation. Commit its relinquishment, the target assignment, a visible handoff message and the pending outbox entry in one transaction. A failed transaction leaves the original assignment intact. No new room membership or access grant is implicit.
4. One immutable operation ID identifies a handoff. Replay with the same payload returns the original operation; reuse with different target/brief/scope is rejected. Concurrent handoffs from the same source generation have at most one winner. Queue delivery can retry; an uncertain external execution must not automatically retry.
5. Fence the old run by its assignment generation. It must stop starting tools, model rounds and final replies after a successful handoff. A tool-triggered handoff must terminate that research turn through a trusted runtime signal, rather than hoping the model obeys a text instruction. Already-started external work cannot be retroactively undone; show this limitation in execution status.
6. Retain chain provenance and a finite hop limit. Reject self-handoff, cycles and exhausted limits before work starts. Limits and any deliberate fan-out must be visible in run metadata. Do not silently serialize explicitly requested independent agent tasks into one disappearing assignment.
7. Execution states distinguish pending delivery, accepted/queued, running, succeeded, failed, cancelled and interrupted. On source deletion, access loss or cancellation, stop future work and preserve an audit record without retaining unnecessary private content. Automatic failure takeover requires an explicit safe retry policy; never report a replacement as successful merely because it was queued.
8. UI shows current assignee, handoff target, status and retry eligibility beside the existing thread. Do not invent a Kylon Orchestrator selection control. Users can inspect the chain and stop work without deleting the conversation.

## Integration sequence

- Add assignment-generation and handoff/outbox persistence plus transaction tests. Do not expose an action until persisted authorization and replay handling exist.
- Add a grant resolver separate from normal human-message routing. `agentExecutionGrant` intentionally requires the original human author and selects responders from the original request; a delegated target must not bypass that resolver by impersonating that author or rewriting the original message.
- Extend AgentRunner with an explicit handoff kind and receipt/result identity. Reuse bounded outbox delivery and the minute drain, while separating delivery retries from execution retries.
- Connect the controlled handoff tool and generation checks through research, ordinary completions and external teammate execution. Keep current grant checks in addition to generation fencing.
- Add thread status UI and compare against live Kylon behavior before claiming visual parity.

## Required verification

Cover duplicate requests and lost acceptance responses; concurrent target choices; rollback at every transaction boundary; old-run output/tool fencing; agent/room/workspace access revocation between stages; session sign-out; source edit/delete; invalid target room membership; self/cyclic/exhausted chains; interrupted external execution; cancellation racing acceptance; parallel independent requests; and Simple regressions. Use mocked providers and disposable local fixtures without new charges. Production verification must distinguish rendering/status checks from an actual controlled multi-agent handoff.

## Next: expose normal execution state to conversation readers

The normal result tracker was deployed in8f09705e, with CI40061007684 and Worker40061007668 successful. A bounded batch status endpoint and Harness conversation/thread status panel are included in main1646634f, with CI and deployment still pending verification. The endpoint is scoped to the caller's currently readable canonical conversation. Validate every requested source message (including deletion and workspace/channel) before querying internal runner state; reject a mixed unauthorized batch without revealing which foreign IDs exist. Return metadata only.

Do not infer queued from an enqueue receipt alone: deployments before the tracker retain accepted receipts after removing completed jobs and have no terminal result. Prefer a persisted result; otherwise report queued only for an actually stored pending job. Legacy receipt-only state is unknown. Model answer count is separate from handler completion; finished with zero model answers does not prove task success.

The client should scope cached results to account/workspace/conversation/message IDs, discard late responses after scope changes, and use one bounded batch refresh rather than one polling request per message. Poll while queued/running; bound retries for initially unknown messages to cover the enqueue race. Use existing conversation styling and preserve Simple. Do not expose a Retry action until its external-effect/idempotency policy is implemented.


## Local persistence and grant implementation (2026-10-24)

`agentAssignments.js` stores one assignment per original human message and initial agent, preserving deliberately independent parallel requests. Its generation check transfers ownership, immutable handoff details, an inert agent message and an outbox row in one D1 transaction. Replays cannot change the target, brief or visible event; only one claimant can start a pending target. Self/cyclic/exhausted handoffs are rejected, and a stale owner cannot finish or reclaim the new generation. A failed outbox insertion rolls back the entire transition. Initial assignment records retain a hashed session key and source fingerprint, not a raw session token or duplicated source body.

`agentAssignmentGrant.js` resolves the original human request without changing its author/body, then separately checks the assigned target's current room placement and invocation rights. It requires Harness mode and a currently readable business room. Source edits and sign-out invalidate the grant; an unavailable target is not silently granted membership. Normal human responder selection continues through `agentExecutionGrant`. These internal helpers are not yet invoked by the production execution path.

Remaining integration: create/claim assignments in Harness runs, add handoff-specific outbox draining and AgentRunner job identity, terminate the source research turn via a trusted runtime signal, fence tool/model/reply stages by generation, record interrupted/cancelled ownership, then expose the chain and stop control. Test actual source-to-target execution and compare its UI against the live reference before changing parity status.

## Runtime control and prerequisites

The research loop now recognizes only private runtime-branded handoff signals from explicitly registered control tools. It serializes those tools before ordinary siblings and terminates immediately on a successful handoff. A remote JSON object or model final text cannot forge this outcome. askAgent/runAgents preserve it without a fallback reply; the production tool is not registered yet.

Before enabling assignment execution, replace uncertain normal enqueue-to-inline fallback with an atomic source-message/delivery-outbox path. Retrying delivery must reuse the same queue identity; a lost terminal ownership write must remain recoverable without executing model/tools again. Do not mark handler completion while leaving the assignment running, or let the old inline fallback reply after a durable owner handed work off. External teammates also need persisted generation fencing in their callback/continuation path before joining the handoff protocol. These are remaining implementation requirements, not verified capabilities.
