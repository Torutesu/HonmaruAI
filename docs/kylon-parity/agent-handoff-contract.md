# Agent handoff implementation contract

Status: design only; KY-018/KY-019 remain incomplete. No handoff tool or leader selector is implemented by this document.

## Evidence and current behavior

Rechecked 2026-10-24:
- https://docs.kylon.io/concepts/rooms: explicit agent mentions can activate another agent; ordinary status messages do not create reply loops. There is no separate user-facing Orchestrator selector.
- https://docs.kylon.io/cli/workspace/thread: activation selects an eligible room member, replies can request routing or direct activation, and notify-only suppresses activation. Activation reports whether work actually started. A new isolated thread omits preceding-room context but is not a new security boundary.
- `customAgents.respondingAgents` supports human explicit mentions and limited new-request routing. `channelRoutes.runAgents` executes selected agents concurrently and posts outputs without routing those outputs to other agents. Thus an agent mentioning another agent currently does not implement a handoff.
- `AgentRunner` has idempotent enqueue receipts for human requests and room hooks. It has no ownership generation for a thread or per-handoff execution identity. Its ordinary jobs are removed before execution, so an interruption is not proof of completion.
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

The normal result tracker is now implemented locally, with full regression pending. It is not yet a user-facing run history. Add a bounded batch status endpoint scoped to the caller's currently readable canonical conversation. Validate every requested source message (including deletion and workspace/channel) before querying internal runner state; reject a mixed unauthorized batch without revealing which foreign IDs exist. Return metadata only.

Do not infer queued from an enqueue receipt alone: deployments before the tracker retain accepted receipts after removing completed jobs and have no terminal result. Prefer a persisted result; otherwise report queued only for an actually stored pending job. Legacy receipt-only state is unknown. Model answer count is separate from handler completion; finished with zero model answers does not prove task success.

The client should scope cached results to account/workspace/conversation/message IDs, discard late responses after scope changes, and use one bounded batch refresh rather than one polling request per message. Poll while queued/running; bound retries for initially unknown messages to cover the enqueue race. Use existing conversation styling and preserve Simple. Do not expose a Retry action until its external-effect/idempotency policy is implemented.
