# Mac mini execution gateway

Status: initial offline JavaScript execution foundation, not full Kylon computer parity.
No new subscription is required. Existing Cloudflare quotas and local electricity/storage still apply.
Simple Honmaru remains independent of this opt-in Harness screen.

## Trust and deployment boundary

The Worker owns workspace authorization, per-node hashed credentials, job ownership,
queue state and leases. A gateway makes outbound HTTPS requests only; no port needs
opening on the Mac. One node handles one job at a time. Multiple nodes can belong to
a workspace; a token cannot claim another node's jobs. The machine operator can read
submitted code/input and must be trusted by the workspace.

Each job runs in a fresh Linux VM using Apple's container runtime. Fixed image digest,
non-root UID, read-only root, temporary /tmp, no network, no host mounts, one CPU,
512 MiB RAM, 60-second execution limit and 32 KiB combined output limit are enforced
by the local runner, not by the supplied code. Node credentials never enter the guest.

The idle loop polls every five seconds. Node traffic has a separate IP quota and
an authenticated per-node quota, so it does not consume the human team-operation
bucket. A lost heartbeat aborts the local execution. Server leases expire after 90 seconds,
with a two-minute absolute deadline. Cancellation/revocation invalidates the lease
immediately; the connected runner notices on the next heartbeat (10 seconds plus
network timeout). Queued jobs expire after one hour. An expired job is not silently
replayed, because arbitrary work may have side effects. A request ID prevents duplicate
submission retries. Results are visible only to the requesting member, even for admins.

## Local runtime verified on 2026-10-16

- Apple container 1.5.0, trusted/notarized Apple installer payload extracted without sudo.
- Runtime: `/Users/tt/.local/share/honmaru/container-1.5.0/bin/container`
- Dedicated runtime data: `/Users/tt/.local/share/honmaru/container-data`
- Image pinned in `gateway/runner.mjs` (official Node 22 Alpine image).
- Real VM smoke passed: result 42, Linux non-root UID, host home absent, root read-only,
  outbound network unavailable, runaway loop terminated, no containers left running.
- Production Select workspace: Mac mini registered and connected with explicit user approval on 2026-10-16.
- Token stored outside the repository in an owner-only directory/file (0700/0600).
- Production UI round trip passed at 20:54 JST: `return input * 2`, input `21`, status `succeeded`, output `42`; no containers remained afterward.
- On 2026-10-17, installed the user LaunchAgent `com.honmaru.gateway`; runtime and Node are snapshotted outside the checkout. Reboot/login persistence is configured; a physical reboot has not been performed.
- On 2026-10-26, production reconnection was rechecked from the signed-in Execution nodes screen: the same pure calculation returned `42`. The installed LaunchAgent was `running`; a controlled `launchctl kickstart -k` restarted it (run count 2, exit code 0), and the next node heartbeat updated in the production UI. The installed plist has `RunAtLoad=true`, `KeepAlive.SuccessfulExit=false`, and no token in launch arguments. The service configuration and token file are owner-only (`0600`). This verifies service restart and reauthentication, not a full macOS reboot; user login and an awake Mac are still required after boot.

Official runtime architecture: https://github.com/apple/container/blob/main/docs/technical-overview.md
Official release: https://github.com/apple/container/releases/tag/1.5.0

## Start a trusted node

Requires Node.js 22+, an Apple Silicon Mac supported by the container runtime, and
its running user service. Install/verify Apple's official runtime and pre-pull the
image pinned in the runner. The repository doesn't install privileged software.

In Harness → Execution nodes, an administrator registers a named node. Store the
one-time token securely. On the trusted Mac, set these environment variables in the
operator's local session (do not commit a token or paste it into chat):

- `HONMARU_API_URL`: the workspace Worker origin
- `HONMARU_GATEWAY_TOKEN`: the one-time node token
- `HONMARU_CONTAINER_BIN`: absolute runtime executable path, if not on PATH

Run `node gateway/cli.mjs`. `--once` processes at most one job for diagnostics.
A restart uses the same credential; revoke it in Honmaru if lost. Registration is
limited to five active nodes per workspace. Ctrl-C stops the loop and current job.
The gateway can be installed as a user LaunchAgent with `node gateway/install-service.mjs /absolute/path/to/config.json`. It reconnects after login following a reboot, retries network/runtime outages, and restarts after a crash. FileVault unlock and user login are required; it cannot receive work while the Mac is asleep. The installer snapshots the Node executable and gateway source outside the checkout. Authentication revocation stops the service until an operator intervenes.

## Local ACP agents (opt-in)

ACP agents run as the logged-in Mac user; they do not run in the isolated Apple
Container used for plain JavaScript jobs. Only configure an agent and project
directory that the workspace owner trusts. The gateway never accepts an
executable, arguments, environment or working directory from the Worker: an
ACP job names a key from the Mac's local allowlist. ACP permission requests are
rejected by default, and the client does not expose host filesystem or terminal
capabilities. An ACP agent may still use its own local credentials and tools.

On the Mac with a checkout of HonmaruAI, register a local command and project
directory. Use the agent vendor's actual ACP v1 stdio invocation and the exact
working directory the agent should be able to work in:

```sh
node gateway/acp-config.mjs add codex-local /absolute/path/to/acp-agent /absolute/path/to/project --arg=--stdio
```

This stores the allowlist in the owner-only gateway service config, snapshots
the ACP client runtime and restarts the existing LaunchAgent. The node then
advertises only the configured keys in Harness → Execution nodes. In Studio →
AI teammates, select that online node and key, then turn on the ACP teammate.
Remove a key with `node gateway/acp-config.mjs remove codex-local`.

The protocol client negotiates ACP v1 with host filesystem and terminal
capabilities disabled, creates or loads sessions, collects agent message
chunks, and sends prompt cancellation when the job is cancelled. Authentication
is owned by the local agent; Honmaru does not call ACP `authenticate`. Headless
terminal-login flows are not supported, so sign in to the local agent on the Mac
first. Workspace MCP tools and streamed tool/progress updates are not connected
to the ACP teammate yet. Agents that do not support session loading receive
recent thread context in a separate prompt block.

Run `node --test gateway/test/*.test.mjs` for client/argument tests, and
`node gateway/smoke.mjs` for the actual VM isolation checks. The latter requires the
runtime and pinned image; CI intentionally runs only portable tests.

## Before offering a hosted multi-tenant service

This is a foundation, not a hosted service readiness declaration. Outstanding:

- External security review, VM escape response, runtime/kernel patching and image upgrades.
- Fleet attestation, durable cleanup verification, resource pressure admission and health alerts.
- Per-customer storage, encrypted secrets, retention/deletion controls, audit/export and quotas.
- Controlled egress and file exchange; the initial runner deliberately offers neither.
- Workflow steps and richer browser/file workloads. MCP now exposes isolated JavaScript execution to clients with explicit `execute` scope.
- Physical reboot, Mac sleep and power-loss operational tests (login startup and process crash recovery are configured).
- Custom app hosting, browser sessions, commercial terms and provider licensing review.

Never place mutually untrusted customers on an operator-controlled node without a
reviewed tenancy model. Keep the control API compatible so nodes can later move from
a Mac mini to a dedicated fleet without coupling execution to Simple Honmaru.

## Agent execution

Harness-mode MCP clients can use `list_execution_nodes`, `run_javascript`, `get_execution`, and `cancel_execution`. Reads require `read`; enqueue/cancel require the new `execute` scope. Existing read/write keys do not gain execution access. Use a stable requestId for submission retries, then read the job until terminal; queued is not success. Results remain requester-only, including against administrators.

Built-in agents receive these tools only in an unthreaded personal DM when all responding agents belong to the asker and an active node exists. Shared rooms, other people's agents and Simple workspaces receive no execution tools. Current model-provider tool support still applies. A node operator can read submitted code/input; do not submit credentials.

Service config fields: `apiUrl`, `tokenFile`, `containerBinary`, `containerInstallRoot`, `containerAppRoot` (all file paths absolute). Keep tokenFile owner-only. On this Mac configuration lives under `~/.local/share/honmaru/gateway/`; launchd contains paths only, not the token. To stop: `launchctl bootout gui/$(id -u)/com.honmaru.gateway`. To restart an installed service: `launchctl kickstart gui/$(id -u)/com.honmaru.gateway`. Updating the service requires rerunning the installer.

## Published company app actions

An app's **実行基盤 → サーバー処理** panel generates an async JavaScript function body from a request using the existing AI allowance. Review and save the draft, then publish it. Execution always uses the saved published version; editing the draft does not change running or published code. Select an existing gateway and provide JSON input. The returned job must reach `succeeded` before its output is treated as a result. The source history can restore an earlier version into a draft without automatically publishing it.

Own-agent DMs and MCP also expose `list_app_actions`, `run_app_action`, and `get_app_execution`. `run_app_action` requires the MCP `execute` scope, current app access, a published version, a gateway ID and a stable request ID. An app/caller association is committed with each queue entry; access revocation prevents claim/result retrieval, including via retry paths. Node operators can see the supplied code and input. The sandbox still has no host files, credentials or network access and retains the 60-second runtime limit. These routes are covered by Worker tests; a live model-driven app action was not invoked during the 2026-10-26 restart check.

Generated UI can call `honmaru.run(name, input, gatewayId)` and then `honmaru.job(job.id)`. The host first shows the exact published code, version, input and node for approval. It does not accept replacement source from the frame. `honmaru.connect(name, body)` similarly uses only the current user's registered app connection; the host shows its fixed endpoint, HTTP method and body. Credentials stay in the server proxy. A write's request ID is consumed before its first outbound request. If the result is unknown, check the external service before deliberately sending another request.

App database migrations are additive and use stable entity/column IDs. Generated UI can read `honmaru.entity(key)` and use an optional entity key in `create(values, key)`, `update(id, values, key)` or `remove(id, key)`. Writes still use the host approval and strict row contract. A private preview DB is a separate snapshot: primary-table preview writes change only that snapshot, not production. Server actions, connections and additional-entity calls are disabled in the preview bridge. There is no automatic fork merge, relation constraint or destructive migration in this release.

## TypeScript module execution (implemented, rollout pending 2026-10-25)

The new optional `language: "typescript"` payload runs a TypeScript module whose default export is a function accepting the JSON input. Conversion and module evaluation occur only inside the existing non-root Linux VM. The module's returned value becomes the JSON result. No type checking is performed, and external packages/network access are not added. Legacy JavaScript function-body jobs retain their wire format and behavior.

The pinned guest was observed running Node v22.23.3 with `node:module.stripTypeScriptTypes`; it uses transform mode for enums as well as type annotations. API reference: https://nodejs.org/download/release/v22.14.0/docs/api/module.html . A typed/default-export/enum real VM fixture returned 42; a module without a default function failed. Existing VM isolation/timeout smoke passed.

Worker queue and execution UI now carry the explicit language; language changes affect idempotency identity. JavaScript and TypeScript editor drafts are retained independently. This is not a durable workflow SDK, and no state-service credentials are exposed to guest code. The installed LaunchAgent snapshot was updated on 2026-10-25 using the existing owner-only token/configuration. launchctl reported running, the plist validated, and the installed runner matched the tested source hash. No physical reboot was performed. Production API/UI rollout and an authenticated TypeScript round trip through the production queue remain pending.

On 2026-10-25 a later health check found the copied Node executable failing macOS code-signature validation and launchd retrying it (`OS_REASON_CODESIGNING`). The original installed Node still verified correctly; its hash differed from the service copy. The installer now copies to a new inode, compares SHA-256 with the source, verifies the existing code signature and tests `--version` before an atomic rename. It does not re-sign the executable or disable platform protections. Reinstallation restored a valid matching copy, stable launchd process and running container runtime. The original corruption's cause is not established; an initial `running` snapshot alone is not evidence of sustained service health.

### Whole-workflow TypeScript programs (release candidate)

The unreleased workflow editor adds **TypeScriptプログラム** beside form steps. A program is the entire workflow: choose an existing execution node, save source, then run it manually or use the existing schedule/webhook/row trigger. Switching editor formats retains both drafts; saving selects only the visible format. Runs freeze the saved source and keep it while later edits create new revisions. The module executes from the top; an exported default function is not invoked automatically.

The candidate supports the following state API inside the isolated VM:

```ts
import {state, ctx} from '@honmaru/workflow-sdk';
const previous = await state.get();
const count = (previous.state?.count ?? 0) + 1;
await state.set({count}, {validationStatus: 'passed', schemaVersion: 'v1'});
console.log({count, workspace: ctx.workspaceId});
```

Read before writing. The SDK carries the revision into compare-and-swap writes; a conflicting or expired activation fails instead of overwriting newer state. `state.get()` returns prior accepted business state by default. Use `{view:'checkpoint'}` to inspect latest progress or `{includeCurrentRun:true}` to include accepted state from this run. Pending progress and accepted business state are separate. An uncertain program is not automatically rerun: review its execution history before deliberately starting new work.

Current limits remain 60 seconds per VM, 48 KB saved source, a 64 KB combined execution payload, 128 KB state, 64 state operations and bounded logs. No outbound network, host files, host credentials, package installation, agent calls or external tool SDK are provided by this candidate. Node-to-state requests are handled by the trusted host broker with the assigned job lease. New services and billing are not required. Full Kylon SDK parity is still outstanding. This section describes the candidate, not a completed production rollout or a physical-reboot verification.
