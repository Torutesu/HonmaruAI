# App-owned automation contract

Status: design grounded in the current repository; KY-053 remains missing. This is not an implemented feature or a claim of live Kylon UI equivalence. The public app CLI URL was unavailable and a focused official-documentation search did not return usable evidence on 2026-10-24. Existing requirement acceptance remains the target until live reference behavior can be inspected.

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
