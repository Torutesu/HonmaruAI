# App-owned automation contract

Current status: KY-053 is partially implemented with declaration storage, atomic releases, lifecycle guards, generation and editor UI. Live Kylon UI equivalence and production behavior remain unverified. Historical entries below describe the implementation stages. The public app CLI URL was unavailable and a focused official-documentation search did not return usable evidence on 2026-10-24. Existing requirement acceptance remains the target until live reference behavior can be inspected.

## Current gaps

- `apps.normalizeDefinition` currently retains views only. It must not silently discard automation declarations when apps are generated, edited, restored or merged.
- `customApps.saveCustomRelease` publishes HTML with an app-version compare-and-swap and a version snapshot. It does not reconcile workflow state.
- `workflows.createWorkflow` creates enabled workflows by default. Calling it while saving an app draft could start work before publication.
- `updateWorkflow` can independently change trigger, steps and enabled state. Bundled definitions therefore need drift detection and a conflict decision, not blind overwrite.
- Workflow triggering is distributed across scheduled, row, webhook, held-event replay and manual paths. Merely hiding controls or disabling one trigger path is insufficient.

## Required behavior

1. Each app declaration has a stable local key, display name, normalized trigger/steps, desired enabled state and schema version. Store draft and published declarations separately. Reject invalid definitions, duplicate keys, cross-workspace references and excessive declaration count rather than silently truncating them.
2. Draft creation/edit/restore must not create enabled workflows, secrets or outbound effects. Editing a published app's next draft must preserve the currently published automations until publication or explicit unpublish.
3. Track managed workflow identity by workspace, app and declaration key. Do not adopt an unrelated existing workflow by its name or user-supplied ID. Bindings retain the last applied normalized definition and release identity. Hook secrets and live results never enter declaration/version/template exports.
4. Publication validates current app-edit and workflow-management rights plus every referenced conversation, table and agent. Existing workflow validators remain authoritative. Generation from natural language is only a proposal and does not authorize new external connections.
5. Publish app snapshot, workflow reconciliation and binding baseline atomically. A stale app version or independently changed bound workflow rejects the whole publication before any workflow is enabled. Use an explicit successful-publication identity to guard every dependent statement; chained `changes()` checks alone are not a cross-statement success identity.
6. Before the atomic batch, read bounded live workflow snapshots. The app CAS must verify those exact snapshots are still current; checking them only before the transaction leaves a race. Preserve existing webhook secrets, history and in-flight run snapshots for unchanged managed identities.
7. Classify each declaration as unchanged, added, changed, removed, missing live workflow or drifted. Show both proposed and live differences. Drift requires an explicit choice to keep the live change in the draft or replace it; neither choice silently grants new permissions. Display only metadata the viewer can read.
8. Unpublish disables managed workflows in the same transaction. Removing a declaration disables its managed workflow and retains history. App deletion must disable all managed workflows before the app becomes unavailable. Do not delete ordinary user workflows.
9. Every fresh run claim must recheck that an app-managed workflow belongs to a currently published release and remains enabled. Apply the guard to scheduled, row, webhook, manual and held-event replay entry points. A queued event captured before unpublish cannot begin new work afterward. Already-started external operations cannot be undone; explicitly distinguish this from blocking future steps.
10. Repeated publication of the same observed release is idempotent: no duplicate workflows, rotated secrets, duplicate schedule slots or duplicate external runs. A lost response can retrieve the applied release identity. Do not retry uncertain external work as a publication repair.
11. Simple behavior and standalone workflows remain unchanged. Existing contracts/services are reused; no provisioning or new billing is needed for app-owned workflow metadata.

## UI and verification

Add the automation section to the existing app detail/release flow: declared automations, live status, draft/published distinction, concise diff, conflict resolution and a link to retained workflow history. Use existing icons and light/dark tokens. Do not invent a Kylon-specific layout without reference evidence.

Verify draft inertness, existing published behavior during draft edits, atomic publication rollback, concurrent app/workflow edits, idempotent lost-response recovery, secret preservation, cross-workspace reference rejection, revocation before publication, unpublish racing every trigger path, removal/history retention, app deletion and Simple/standalone regressions. Test with local fake providers and disposable records. Authenticated production and Kylon visual comparisons remain separate acceptance gates.

## Declaration foundation (local isolated worktree)

`appAutomationDefinition.js` now validates bounded versioned declarations, explicit enabled state, unique stable keys, trigger/step fields and schedule ranges. It rejects live identities/credential fields and oversized content rather than truncating executable instructions. A pure diff classifies added/changed/removed/unchanged/missing/drifted definitions and excludes live hook secrets/run metadata. Six tests pass in `/tmp/honmaru-app-automation-definition-final.log`.

This foundation is not yet connected to app storage, publication, workflow triggers or UI. KY-053 remains missing until the lifecycle is implemented and verified. Development is isolated at `/Users/tt/.codex/worktrees/app-automations/Honmaru`; app attachment failed because the thread has more than 100 attachments, but the checkout exists. The main workspace's frozen Worker test is unaffected.

## Draft persistence (local isolated worktree)

Added workspace/app-scoped automation state separate from ordinary app definitions, so draft instructions do not leak through normal app reads and ordinary view edits do not discard them. Editor-only GET/PUT automation endpoints use app-version and draft-revision checks in the same D1 write. Competing first saves have one winner. Draft edits retain published state and create no workflows, secrets or execution effects. Ordered single-line table creation is included in schema and migrations.

Validation: **4 files / 53 tests passed**, 10.80s (`/tmp/honmaru-app-automation-draft.log`), including concurrent save conflict, stale app version rejection, invalid declaration rollback, editor visibility, zero workflows after an enabled draft save, existing app tests, migrations and query-scope audit. Publication, live binding/drift reconciliation, lifecycle guards and UI remain incomplete; the draft endpoint does not expose a publish action yet.

Separately, main `cc983d53` contains the fully tested execution-control changes (Worker 1823/Web 1077 pass). CI `40068730977`, Web `40068730976`, Worker `40068730972` are in progress. These draft changes are not on main and must not replace those active jobs.

## Editor-scoped live plan (local isolated worktree)

Added workspace/app/key-to-workflow binding persistence and a read-only reconciliation plan to the editor endpoint. Definitions are compared against the last applied baseline. Existing independent workflow changes report drift instead of being silently overwritten; missing identities remain explicit. Before exposing any live definition, current workflow resource visibility is checked, including a workflow that moved to an inaccessible table. Hook secrets and run metadata are excluded.

Validation: **4 files / 54 tests passed**, 10.61s (`/tmp/honmaru-app-automation-plan.log`), including added/unchanged/drifted plans, secret omission, access loss after independent modification, draft persistence, migrations and query isolation. Bindings/publication state in that test are fixture data; no production publishing API has been added yet. Atomic publish/unpublish, all trigger guards and UI remain required before this feature can be released.

## Atomic release primitive (local, not routed)

Added an internal publish/unpublish transaction that checks app version, draft revision, current membership, workflow capacity and exact live workflow snapshots before changing state. Every dependent write uses a fresh successful-release identity, so losing the initial CAS cannot create workflows or history. Publication updates app version/history, managed workflows, binding baselines and a replay receipt in the same D1 batch. Webhook credentials are retained when the trigger stays webhook; unchanged schedule configuration preserves its current next-run timestamp. Unpublish disables managed workflows and retains identity/history/draft. Existing drift or missing bindings require review rather than replacement. Retired bindings are included in plans to avoid silently overwriting independently modified retired workflows.

Validation: **4 files / 59 tests passed**, 9.70s (`/tmp/honmaru-app-automation-release-final.log`). Covers transaction rollback after forced workflow-insert failure; receipt replay; payload-conflict rejection; disabling/reusing the same workflow identity; live drift; a live edit between plan and commit; and membership revocation immediately before the batch.

The primitive is deliberately not connected to a public publish endpoint yet. Required next: managed ownership guards in every run claim/continuation and app unpublish/delete, integration with custom-code publication, missing-binding repair and reviewed drift resolution, then the app UI. No app automation release has been deployed or enabled in production.

## Managed execution guards (local)

New run claims atomically require the managed binding's current published release, enabled declaration/workflow and an existing published custom app where applicable. Frozen run definitions retain the release identity; later steps and model/tool boundaries recheck it, preventing an old run from continuing after stop/republication. Standalone workflows retain their existing eligibility. Already-started external effects cannot be undone. Bindings must remain as tombstones when apps are deleted so managed runs cannot become standalone accidentally.

Validation: 4 files / 89 tests passed, 13.65s (`/tmp/honmaru-automation-guard-final.log`). Includes stopped new claims, stale release denial after republication, continuation failure after stop, model-request denial, late model tool suppression and sibling tool suppression. An initial model test run exposed persistent mock endpoint interference; isolated test endpoints resolve it. App delete/unpublish integration, stale workflow-definition versus newly read release races, explicit drift reconciliation and the UI remain required before exposing publication. Not deployed.

Native UI inventory still reports Mac locked despite the user's confirmation that it is operable. Authenticated UI verification remains incomplete; do not ask the user to repeat an already-confirmed unlock as though it verified anything.

## App lifecycle and stale definition claims (local)

Deleting an app now disables its managed workflows and clears scheduled dates in the deletion transaction. Ownership bindings remain as tombstones, so old events cannot become standalone work after deletion. Custom source unpublication atomically stops published automation state, advances the release identity/revision, disables workflows and updates the disabled baseline; a losing source-version CAS cannot stop the winning editor's work. Republishing source alone does not silently reactivate automation. A managed run claim also compares the supplied name, trigger, steps and owner against the current workflow in its insert transaction, closing the old-definition/new-release race.

Validation: 3 files / 85 tests passed, 11.84s (`/tmp/honmaru-automation-lifecycle-final.log`). Covers deleted-app tombstones and denied claims; old-definition rejection with current-definition success after release changes; custom source stale unpublish CAS; atomic stop/draft retention; source-only republication remaining inactive; existing workflows and query audit. Complete combined source/automation publication, reviewed drift/missing-binding recovery, public lifecycle routes and UI remain incomplete. These changes are still isolated locally and not on production.

## Combined custom source release (local)

The internal release primitive accepts explicit `includeSource: true` to publish or unpublish custom HTML in the same transaction/version as the automation snapshot, workflows, bindings and receipt. It validates saved source and refuses automation-only publication for an unpublished custom app. Receipts include the source-inclusion choice, so reusing a request ID with different publication intent conflicts. Ordinary table apps continue without custom source.

Validation: 3 files / 87 tests passed, 12.17s (`/tmp/honmaru-automation-combined.log`). Combined publication/unpublication, receipt replay and altered-intent conflict pass; a forced workflow insertion failure rolls back source, version and automation state together. The public route/UI are not yet enabled. Required next: stopping despite live drift/missing bindings, explicit reviewed recovery of those cases, then editor UI and full verification/deployment. The preceding main deployment has successful Web and Worker jobs; CI remains in progress as last observed.

## Stop despite independently changed work (local)

Unpublication now reads the app's automation state without requiring visibility of independently edited workflow definitions. It disables only the workflows bound to that app, preserves their other live fields, retains missing bindings, and does not create replacement work. Publication still requires live visibility and review. Stop is not prevented by an over-capacity workspace. App ownership/permissions, app/draft CAS, membership and receipt checks still apply.

Validation: 3 files / 89 tests passed, 10.42s (`/tmp/honmaru-automation-stop-drift.log`). Tests prove stop succeeds after an inaccessible live edit without disclosing or overwriting it, and after independent deletion without recreating the workflow. Main `cc983d53` CI 40068730977, Web 40068730976 and Worker 40068730972 are now all confirmed successful. This isolated automation feature is still not deployed. UI must offer stop using app state even if live-plan visibility fails; reviewed drift recovery and missing-binding recreation remain required.

## Explicit drift replacement review (local)

Publication can now accept per-key replacement reviews containing the exact observed live definition and workflow identity. Every drifted binding needs a matching review; stale/unrelated/duplicate reviews cannot authorize overwrites. The existing transaction snapshot comparison still rejects edits after review and before commit. Reviews are part of idempotency intent. Schedule preservation now compares against the observed live trigger/enabled state, preventing a reviewed schedule-to-manual replacement from keeping a stale scheduled date.

Validation: 2 files / 54 tests passed, 7.58s (`/tmp/honmaru-automation-review-final.log`). Explicit reviewed replacement and replay succeed; wrong observed content, wrong key and a concurrent later edit fail; restoring manual execution clears the independently changed schedule. Missing workflow repair and UI review controls remain incomplete. These are internal primitives only, not deployed features.

## Reviewed recreation and lifecycle API (local)

Missing workflows can be explicitly recreated from the current draft by reviewing their key and prior identity with `action: recreate, live: null`. The transaction checks that these identities are still absent; it counts replacements against capacity and restores stable IDs with fresh webhook credentials where applicable. It never retries historical runs. A missing binding identity, or a missing declaration to restore, still needs a separate reconciliation path and is not silently invented.

Editor-only POST `/apps/:id/automations` now exposes release operations, with audit records for new successful releases and receipt replay without duplicate audit. Editor-only GET with `stateOnly=1` provides app/draft release state for stopping even when an independently modified live workflow is inaccessible; it does not return that inaccessible definition.

Validation: 4 files / 105 tests passed, 12.52s (`/tmp/honmaru-automation-api.log`). Includes explicit recreation/replay, absent review rejection, identity reappearance race, route permission checks, state-only non-disclosure and stop through the API, plus workflows, migration and query-scope checks. UI, broader tests, reconciliation edge cases and production deployment are still pending.

## App editor lifecycle UI foundation (local)

Added a typed client and an editor-only Automations tab under the existing app runtime panel. It copies authorized existing workflow definitions into disabled app drafts without credentials/identity metadata, edits names/enabled state, saves drafts, renders live-versus-proposed changes, requires per-conflict review, supports combined custom-source publication, and retains stop through state-only fallback when live definitions become inaccessible. Retrying the same uncertain release reuses its request identity. Existing design tokens style both themes and the diff collapses to one column on narrow screens.

Validation: TypeScript build passed after adding the existing web-react dependency-directory symlink to this isolated worktree (initial attempt resolved wrong root dependencies). Two files / five UI tests pass (`/tmp/honmaru-automation-ui.log`), covering exact review payload, stop fallback, uncertain-release retry identity, and existing CompanyApp checks. No visual fidelity claim: authenticated Kylon/production visual comparison has not succeeded. Direct step/trigger editing, natural-language creation integration, richer human-readable diffs, further async-state tests, full suite/build and deployment remain. This UI is not yet deployed.

## Human-readable publication review (local)

Replaced JSON-only live/proposed previews with structured summaries of enabled state, schedule/timezone, row trigger filters, step ordering, room targets, approvers, agent/table identifiers, messages and row values. Raw definitions remain in a collapsed details section. Review output is escaped React text, and existing theme tokens/mobile layout apply. Resource identifiers still need friendly-name resolution and the editor still needs direct step/trigger controls.

Validation: two UI files / five tests passed (`/tmp/honmaru-automation-summary.log`) and TypeScript passed. Coverage includes weekly schedules/timezones, side-effect targets, disabled row filters and HTML escaping; publication review behavior remains covered. No screenshot or Kylon visual parity evidence yet; these changes remain local.

## Shared direct step editing (local)

Extracted the existing workflow step form as a shared component and embedded it in app automation drafts. App editors can add/remove and edit supported steps, using authorized tables and agent choices. Edits stay local until draft save and disable publication while dirty; ordinary workflow editing uses the same component. Direct trigger editing and ordering controls remain to be added, and the existing follow-up hour granularity still warrants improvement.

Validation: TypeScript passed; two UI files / 23 tests passed (`/tmp/honmaru-automation-step-final.log`), including existing workflow behavior and a new test that editing changes the local step, enables draft save, blocks publication and makes no release call. No deployment or visual-comparison claim.

## Direct trigger editing and blank creation (local)

Added trigger controls for manual/webhook, schedules (cadence, weekday/monthday, time, timezone), row event/table/watched column and select-value conditions. Switching trigger kind removes incompatible properties; switching tables removes old watched-column/filter references. A blank automation starts as a disabled local draft with a manual trigger and editable step.

Validation: TypeScript passed for the trigger component/integration; two UI files / eight tests passed after the blank-creation addition (`/tmp/honmaru-automation-trigger-final.log`). Covers trigger-kind/table reset, explicit weekly weekday, existing draft/review behavior and local creation without release. Natural-language app automation generation, ordering, resource naming, broader validation and live visual verification still remain before deployment.

## Natural-language automation proposals (local)

Added editor-only generation using the existing metered workflow proposal pipeline and resource visibility checks. The app-specific wrapper validates the portable declaration, assigns a stable key and forces disabled state. It writes no workflow, secret, app draft or release. The UI appends the proposal to the local editable draft for explicit save/review/publication. No new provider or subscription is introduced; unavailable allowance returns an error with manual editing still available.

Validation: Worker two files / 58 tests passed (`/tmp/honmaru-app-automation-generation.log`); UI one file / six tests passed (`/tmp/honmaru-app-automation-generation-ui-final.log`); TypeScript passed. Tests cover disabled inert output, no database state creation, editor permissions, unavailable-model response and proposal addition without publication. Real model quality, visual review, full regression/build and deployment remain unverified.

## Whole-suite verification and deferred-work audit

At frozen runtime/test commit `0d225fab`, Web full suite passed 158 files / 1088 tests (`/tmp/honmaru-0d225fab-full-web.log`); production Vite build succeeded (`/tmp/honmaru-0d225fab-build.log`, asset index-TOesLW98.js). Existing large-chunk/ineffective-dynamic-import warnings remain. Version checker passes at 1.3.13; inventory checker passes but does not prove parity. Worker full suite is still running under terminal session 83476; do not restart merely because output is quiet. Web/build session 44271 is terminal success.

Read-only lifecycle audit found a required pre-deploy fix: workflow follow-up steps currently call `scheduleFollowup` without app release provenance. `runDueFollowups` later executes independently, so app unpublication/republication does not currently fence a previously scheduled follow-up. Add durable origin workflow/release metadata atomically with follow-up creation, guard due execution/model tools/final posting, and verify standalone follow-ups remain unchanged. Keep runtime/tests fixed until the current full suite finishes, then implement and rerun appropriate checks. Do not claim comprehensive stop semantics or deploy this feature before resolving the gap.

## Step ordering (local UI only during Worker verification)

Added accessible up/down controls for app automation steps. Reordering changes local draft order without mutating loaded state or publishing. The UI explains that numeric step references should be checked after reordering. Related UI tests (7) and TypeScript passed (`/tmp/honmaru-automation-order.log`). Worker runtime/tests/schema remain unchanged from the frozen full-suite run; the earlier full Web/build evidence predates this UI-only addition and must be refreshed before deployment.

Prepared, but not yet applied while Worker tests run: `/tmp/honmaru-followup-origin.patch`, `/tmp/honmaru-followup-origin-tests.js`, `/tmp/honmaru-followup-migration-test.js`. Patch application check passes; actual behavior is not yet tested. Once session 83476 terminates, inspect full result, apply patch and append tests to harness-apps/migration respectively, then validate. Patch generation script: `/tmp/prepare-honmaru-followup-fix.py`.

## Full Worker result and managed follow-up fencing

Frozen Worker runtime/test commit `0d225fab` completed successfully: 225 files / 1854 tests, 505.03s (`/tmp/honmaru-0d225fab-full-worker.log`, session 83476 terminal exit 0). Only frontend/docs changed while it ran.

Then applied the deferred-follow-up fix: managed workflow steps persist origin workflow/release columns with the reservation in one guarded insert. Due follow-ups check that release before work, through the existing model tool authorization callback, and before posting. Stale reservations fail without posting after stop/republication; standalone reservations have null origin and retain existing behavior. Ordered ALTER migrations preserve existing reservations and tolerate repeated deployment.

Post-fix targeted verification: 4 files / 108 tests passed, 14.68s (`/tmp/honmaru-followup-origin.log`), including actual managed workflow scheduling, stored origin, stopped scheduling rejection, no old reservation execution after republication, legacy workflows and preservation/replay of pre-migration reservations. Full Worker evidence predates this focused fix; no new whole-suite result is claimed. UI whole-suite/build refresh, visual verification, integration into main and deployment remain pending.

## Resource names in review (primary branch, pending next deployment)

Publication summaries now resolve table, column and agent identifiers through the editor's already-authorized resource lists, with original identifiers retained when names cannot be resolved. This applies to row conditions, watched columns and step values as well as targets. Two UI files / 10 tests and TypeScript passed (`/tmp/honmaru-automation-resource-labels.log`). This follow-up is later than deployed candidate `cfece088`; do not push over its active runs (Web 40071366835, CI 40071366860, Worker 40071366840).

## Exact follow-up delay editing (pending next deployment)

The shared step form now displays and edits follow-up delay directly in minutes, preserving existing values such as 15 or 90 instead of rounding to hours. Added bounds matching the app declaration range and an accessible Japanese-translated label. Related 3 UI files / 27 tests and TypeScript passed (`/tmp/honmaru-followup-minute-ui.log`). Candidate cfece088's CI/Web/Worker jobs remain active; this follow-up is local until they terminate.

## Execution history inside app automation review (pending next deployment)

Added lazy authorized workflow-run history under each existing managed automation. It shows run time/status, step results/errors and run identity, with explicit refresh/retry. Failed retrieval clears old results instead of showing stale success. Related two UI files / nine tests and TypeScript passed (`/tmp/honmaru-automation-history-ui.log`). This UI-only follow-up is not part of currently deploying cfece088. Live screenshots and production validation remain pending.

## Unsaved draft preservation across app version changes

An external app-version refresh no longer silently replaces dirty automation edits. The panel preserves them, explains the conflict, disables saving/publication against the old app version, and provides an explicit discard/reload action. If edits are reverted locally, reload remains available. Targeted eight UI tests pass (`/tmp/honmaru-automation-unsaved-final.log`); TypeScript passed before the final button eligibility adjustment, so the next full build must cover that adjustment. This remains a local follow-up while cfece088 deployment jobs are active.

## Continuation entry state and remaining checkpoint contract

Added an early continuation-state guard: only running executions advance. Waiting approvals require their existing settlement CAS first, while completed/failed/declined runs retain their results. Two Worker files / 96 tests passed (`/tmp/honmaru-workflow-continuation-state.log`), including explicit non-advancement of waiting/terminal runs and existing approval flow tests.

This does not implement KY-059 or KY-067. Current workflow logs/next_step are still persisted at the end of the continuation loop, without a per-step ownership/intent ledger. A complete checkpoint design must atomically claim each step with an execution generation, persist intent before effects, record completion/output once, use idempotency for same-database mutations, and treat uncertain external effects as interrupted (never automatically replay). Budget reservation must atomically enforce daily/weekly/monthly and concurrency limits, distinguish reserved/consumed/released usage, and define explicit pause/resume behavior. These requirements remain missing until implemented and tested under crash/concurrent-claim scenarios.

## Refreshed official reference, 2026-10-24

Public source now accessible: https://kylon.io/product/workflows (official marketing specification, not authenticated screen evidence). It describes agent-led setup, seven-day run overview with duration/credit data, automatic pause after three consecutive failures with creator notification, skipping overlapping triggers, and daily/weekly/monthly budget warn/pause behavior. It also describes TypeScript automations with persistent state, timed/interval triggers, record deletion triggers and automation-thread changes. These remain explicit parity targets; the newly implemented app editor and history do not satisfy all of them.

The public app gallery https://kylon.io/apps shows six business templates and a fork-oriented flow. This is useful reference for KY-054 but does not prove runtime sharing/import behavior. Preserve the distinction between public claims, local implementation tests and live product verification. Next runtime design should incorporate the documented overlap-skip and three-consecutive-failure policy alongside budget/checkpoint work.

## Consecutive failure pause integration audit

The current continuation has three separate failure exits: unreadable persisted input, revoked source-table access, and step failure; oversized input fails directly in startRun. Approval decline is a distinct terminal outcome. A failure policy must settle all these paths exactly once, with a recorded run outcome identity, rather than incrementing a counter on reads or retries. A successful run resets the streak; approval waiting and skipped overlap do not count as failures. Decline semantics must be explicit.

Keep operational pause state separate from published automation definitions. Setting enabled=false alone would appear as manual drift in app publication review. The run admission guard and each trigger dispatcher must enforce the operational pause; explicit resume must reset the failure streak and distinguish a new generation so a late result from the old generation cannot re-pause it. Persist notification intent with the pause transition, then deliver once to the creator's authorized automation thread. Existing workflows do not all have a thread binding, so thread association and permission-checked delivery must be implemented rather than sending failures to arbitrary step channels. Oversized or revoked inputs must never be copied into notification payloads. These are implementation requirements, not completed behavior.

## Failure policy persistence foundation (not yet active)

workflowSafety.js and three scoped tables now provide independent operational state, once-only persisted run outcomes, and a unique notification intent per pause generation. Settlement statements are designed to be appended to the same batch that makes a run terminal. They read the frozen safetyGeneration from its stored definition, never trust a caller-supplied status, and count a terminal outcome only once. Three failed outcomes pause the generation; done/declined/cancelled reset the streak; waiting is ignored. CAS resume changes generation, protecting against stale results/resume requests. Notices contain creator/run identity only, no input/error payload.

Three suites / 17 tests passed in 6.39s (`/tmp/honmaru-workflow-safety-foundation.log`), including concurrent duplicate settlement, three-failure pause, reset, workspace boundaries, stale generation and transaction rollback plus migration/query checks. This is an internal foundation only: startRun generation capture/admission enforcement, all terminal settlement call sites, authorized resume route/UI, and permission-checked notification delivery remain unconnected. Do not claim operational automatic stopping until those integrations and end-to-end tests are complete. No push while cb32be63's CI 40073736042 / Worker 40073735968 / Web 40073736102 are active.

## Failure policy runtime integration (local, UI/delivery pending)

startRun now creates/loads operational state, freezes its generation in the run definition and checks the generation/unpaused state atomically at admission. Oversized-input and all continuation terminal paths append settlement to the run-state transaction; approval decline resets the streak. Paused admission creates no run. Manual requests return a review/resume conflict; MCP returns structured paused status; webhook delivery retains the input using the existing bounded seven-day held-event mechanism. Schedule counts now exclude skipped/paused admissions. Published enabled/steps are untouched, so safety pauses do not manufacture definition drift.

Workflow detail exposes scoped safety state. POST /workflows/:id/resume is maker/admin-only and requires the observed generation; it resets operational state without enabling a disabled definition or replaying held events. UI resume, list presentation and actual creator-thread notification delivery remain pending, so this must not yet be represented as full Kylon failure handling.

Five suites / 110 tests passed in 15.48s (`/tmp/honmaru-workflow-safety-runtime-final.log`), including three actual no-model failures, unchanged enabled definition, blocked fourth run, held webhook delivery, stale resume conflict and resumed execution without replay. The first added integration fixture named a missing agent, correctly making the workflow unreadable (404); replaced it with a visible team agent without a model to test execution failure instead. This is after the last whole-Worker run; rerun final whole suite once the remaining integration is ready.

## Failure pause presentation and authorized resume

Workflow lists now return visibility-scoped safety state and show a pause badge. The detail screen explains the three-failure pause, suppresses a misleading next-run time, disables manual execution and held replay while paused, and provides maker/admin-only resume with the observed generation. Failed resume leaves the pause visible; ordinary disabled state is kept separate. Japanese translations added. Worker access/list validation: 2 suites / 46 tests, 11.36s (`/tmp/honmaru-safety-resume-access.log`). UI: 21 tests passed (`/tmp/honmaru-safety-ui.log`); TypeScript and build passed (`/tmp/honmaru-safety-ui-build.log`) including the subsequent next-run visibility condition. No authenticated visual verification yet. Creator-thread notification delivery and integration into the app's embedded automation panel still remain.

## Embedded app safety controls

App automation execution history now consumes the authorized workflow detail's safety/canEdit fields, shows the pause explanation, and allows makers/admins to resume using the observed generation. Reloading/switching identities clears old permission/state; stale requests cannot update the current view. Read-only viewers see the reason without a resume button. Resume refreshes the authoritative workflow result rather than assuming success from a button click. Two UI suites / 30 tests passed (`/tmp/honmaru-embedded-safety.log`), plus TypeScript and production build (`/tmp/honmaru-embedded-safety-build.log`). Creator-thread notification delivery and authenticated screen verification remain pending. cb32be63's three deploy/CI jobs remain active; no subsequent push yet.

## Creator-scoped stop notices

Added GET/POST /workflows/notices over persisted pause intents. Only the original recipient in the workspace may see/acknowledge a notice, and current workflow resource permissions are checked before disclosure. Read acknowledgement uses COALESCE for stable retry behavior; reads do not mark notices read. Old-generation notices remain historical with paused=false after resume. Three Worker suites / 58 tests passed, 15.57s (`/tmp/honmaru-workflow-notices.log`), covering cross-recipient rejection, idempotent acknowledgement and resource-access revocation plus migrations/query audit. This endpoint is not yet connected to a notification indicator or automation conversation; no actual thread notification delivery is claimed. It preserves the existing app-only notification schema and requires no external provider.

## Stop notification UI

Workflow list now includes a notification section with unread count, current/past pause state, target navigation, refresh and explicit read acknowledgement. Opening a workflow does not mark the notice read. Account/API changes fence delayed responses; retrieval failures remove stale names/details, and loading/failure shows an unknown count rather than zero unread. Two UI suites / 23 tests passed (`/tmp/honmaru-notice-ui.log`); Initial TypeScript failed on a duplicate existing “Mark as read” translation; removed the duplicate and reran validation after the unknown-count adjustment. This is an in-product workflow notification list, not push/email delivery or an automation thread. Those reference-product communication requirements remain incomplete; no new paid service was introduced.

Translation correction validation: TypeScript and production build completed successfully (`/tmp/honmaru-notice-ui-build.log`).

## Workflow source-thread binding (isolated follow-up)

Existing clean codex/app-automations checkout was fast-forwarded to 2f2af3fd, preserving primary's frozen full Worker run. Added workflowSource and GET/POST /workflows/:id/source with a separate scoped metadata table. Only the creator can bind a current, accessible root message; the binding is immutable/idempotent. Reads recheck workflow and conversation access, including deleted roots. Three suites / 59 tests passed (`/tmp/honmaru-workflow-source.log`); final focused test additionally verifies cross-workspace root rejection (`/tmp/honmaru-workflow-source-final.log`, one passed). Binding is not yet exposed in the UI or automatically captured during generation, and notices are not yet posted to the thread. This follow-up is isolated and not in primary until explicitly merged after its current full suite terminates.

## Source-thread notice delivery helper (isolated, not scheduled)

Added deliverWorkflowNotices for a stored workflow/organization. It resolves current paused-generation intent, original recipient/creator and explicit source, checks current workflow/conversation access and membership, and posts a localized AI notice without copying failure payloads. A SHA-256-derived client ID under the reserved system author uses existing channel post deduplication, including recovery after the message lands but delivery acknowledgement is lost. Notification-list read state remains separate from delivery. Two suites / 49 tests passed (`/tmp/honmaru-notice-delivery.log`), including concurrent delivery, lost acknowledgement and membership removal.

This helper is not yet invoked by terminal settlement or a retry sweep. Before enabling automatic delivery, add insertion-time fencing of current pause generation/recipient/source membership to avoid a pause-resume or revocation race between preflight and insertion; current checks only establish preflight authorization. Source capture UI/generation and full regression validation remain pending. Keep this work isolated until the primary full Worker run is terminal.

## Insertion-time notice fence

The internal postMessage path now accepts a narrowly validated workflowNotice identity only for system AI replies without files/agent dispatch/other execution grants. Its INSERT checks current pause generation, notice recipient/current workflow creator, stored source, nonguest membership and source-conversation access (business/private, group, direct, agent). Parent liveness remains in the existing INSERT guard. Existing ordinary/agent messages keep their paths. Preflight still checks all workflow resources; the added atomic guard covers notice/source authority, not a general transactional snapshot of every resource used by the workflow.

Five suites / 89 tests passed in 23.16s (`/tmp/honmaru-notice-fence.log`), including direct insertion after unpause, private-room removal and workspace removal, concurrent notice retry, channels/threads and existing room-hook grant tests. Automatic terminal/sweep invocation, source capture UI and final integrated full-suite validation remain pending. Primary's full Worker run is still live; no merge yet. External cb32be63 Worker/Web runs 40073735968 / 40073736102 have completed success, as has CI 40073736042; their asset logs still need inspection.

## Automatic notice delivery and retry sweep

Terminal workflow paths now attempt stored notice delivery after committing the run outcome; a delivery error is caught and leaves intent pending rather than changing the execution result. Scheduled processing retries a bounded set of pending current-generation notices with explicit source bindings. last_attempt_at ordering rotates inaccessible/failed targets so later pending work is not permanently starved. Retry does not run workflow steps or replay held webhook events. Four suites / 64 tests passed, 12.20s (`/tmp/honmaru-notice-automatic.log`), including actual third-failure automatic thread posting and recovery via the retry sweep with no duplicate reply, plus migration/safety/query checks. Source-selection UI/generation capture remains pending.

Primary frozen Worker at f85ab7df completed: 226 files / 1868 tests, 760.98s (`/tmp/honmaru-safety-full-worker.log`, session 95952 terminal exit 0). Separate-checkout development above was excluded from that full run. Integration may now proceed, but the source-thread follow-up requires its own final whole-suite validation; do not claim the 1868-test result covers it.

## Source thread picker

Workflow details now expose a source-thread picker: creator-only accessible root candidates, text/date preview, explicit radio selection/save, immutable binding explanation, and bound-thread summary. Candidates paginate through older roots in bounded pages; access checks precede returning text, and noncreators receive no candidate list. Delivery helper reads do not enumerate candidates. Error/identity changes clear old selections; frontend requests are generation-fenced. Candidate labels currently show body/date rather than resolved conversation names, so context presentation can still improve.

Worker source/access/query suites: 2 files / 49 tests passed (`/tmp/honmaru-source-picker-worker.log`). UI source/workflow suites: 2 files / 23 tests passed (`/tmp/honmaru-source-picker-web-final.log`); existing tests were changed from assuming one details element to selecting the actual run-detail class after the new picker was added. TypeScript/build passed (`/tmp/honmaru-source-picker-build.log`). Full integrated run and rendered picker verification remain pending. Natural-language generation does not yet automatically capture the originating thread; manual selection is functional but not full reference parity.


## Automatic workflow origin capture

Workflow generation now uses a request-scoped job keyed by workspace/user/request ID, a fingerprint of the requested behavior, and a lease token. Chat generation sends a stable retry ID and captureSource=true; the original prompt is stored once with an author-scoped deterministic message ID, without invoking a second channel AI responder. Generated definitions are cached for retries. Publication commits the lease completion, paused workflow and immutable source binding in one DB batch. The source insert checks root liveness, original body and current nonguest membership; conversation/resource access is rechecked after model work. This is not a general transactional snapshot of every referenced permission.

Completed retries recheck workflow/source access and return the existing workflow. Concurrent owners and changed-payload reuse return conflicts; expired owners cannot replace a completed newer generation. The source can remain as the visible original request after failed generation, allowing a retry without duplicate prompts. ClassicList reuses the request identity while retrying the current draft; identity is in memory, not durable across a browser restart. The workflow screen's standalone builder still does not synthesize a source conversation. Creation-result thread replies/navigation remain follow-up work; failure notices use the stored origin through the already-deployed delivery path.

Targeted creation/workflow/migration validation passed 3 files / 66 tests (`/tmp/honmaru-workflow-origin-final.log`), including concurrent requests, lease takeover, revocation during generation, deleted source and atomic rollback. A subsequent source commit guard also checks unchanged text/nonguest membership; the final creation/tenant check is running (`/tmp/honmaru-workflow-origin-fence.log`). Web passed 162 files / 1108 tests (`/tmp/honmaru-workflow-origin-full-web.log`); TypeScript/build passed (`/tmp/honmaru-workflow-origin-web-build.log`). Version/inventory checks passed. No new service or Simple-specific changes. Full Worker validation and deployment are still pending.

Final source/tenant validation after the commit-guard refinement passed 2 files / 11 tests, 63.24s (`/tmp/honmaru-workflow-origin-fence.log`). The tenant suite exercises foreign-workspace denial across routes and checks no victim records changed.
