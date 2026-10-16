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
