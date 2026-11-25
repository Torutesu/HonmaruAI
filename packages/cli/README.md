# Honmaru workspace CLI

`@honmaru/cli` is a small Node.js command line client for the same scoped workspace tools used by Honmaru's MCP endpoint. It reads only the tools allowed to its agent token, then lets an operator call those tools with JSON arguments.

## Set up

Use Node.js 22 or later. Create an agent token in **Studio → API**, then set the API origin and token in the shell that runs the CLI:

```sh
export HONMARU_API_URL="https://your-honmaru-api-origin"
export HONMARU_API_TOKEN="hm_…"
```

The token stays in the environment and is not written to a config file or printed by the CLI. The server checks token expiry, workspace membership, IP and SSO policy, scopes, and whether Harness tools are enabled for that workspace. Simple workspaces continue to expose their existing tools.

Agent wake grant listing and revocation use a signed-in human session from `HONMARU_SESSION_TOKEN`; the grant creator can revoke active, non-once grants. Revocation requires `--confirm` and is never retried after an ambiguous response.

Agent connection listing and permission changes also use `HONMARU_SESSION_TOKEN`, never an Agent API token. Changes require `--confirm`; workspace native-source grants are additionally authorized by the Worker for workspace owners and admins. If a change request has an ambiguous network result, inspect the connection list before retrying.

Agent collaboration commands use the same signed-in human session. Human member roles, managed Agent peer assignments, and ownership transfer are protected by the Worker's live access checks and expected-version compare-and-set; changes require `--confirm`. Ownership can transfer only to another active human Agent admin.

## Use

```sh
npm install
npm exec --workspace @honmaru/cli -- honmaru workspace tools
npm exec --workspace @honmaru/cli -- honmaru workspace tools --json
npm exec --workspace @honmaru/cli -- honmaru workspace call list_apps
npm exec --workspace @honmaru/cli -- honmaru workspace skill list
npm exec --workspace @honmaru/cli -- honmaru workspace skill get skill_…
npm exec --workspace @honmaru/cli -- honmaru workspace agent wake grants
npm exec --workspace @honmaru/cli -- honmaru workspace agent wake revoke grant_… --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace agent connections list agent_… --workflow
npm exec --workspace @honmaru/cli -- honmaru workspace agent connections app grant agent_… --server github --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace agent connections native grant agent_… --source notion --scope workspace --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace agent connections remote-tool grant agent_… --server-id mcp_… --tool search --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace agent connections custom-api revoke agent_… --app-id app_… --connection contacts --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace agent members list agent_…
npm exec --workspace @honmaru/cli -- honmaru workspace agent members set agent_… member_… --role admin --version 4 --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace agent peers list agent_…
npm exec --workspace @honmaru/cli -- honmaru workspace agent peers set agent_… reviewer_agent --role member --version 2 --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace agent ownership transfer agent_… member_… --version 5 --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace skill create --from ./skills/release --visibility private
npm exec --workspace @honmaru/cli -- honmaru workspace skill update skill_… --from ./skills/release --expected-updated-at 2026-11-14T00:00:00.000Z
npm exec --workspace @honmaru/cli -- honmaru workspace skill publish skill_… --version 1 --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace skill unpublish skill_… --version 2
npm exec --workspace @honmaru/cli -- honmaru workspace skill shares list skill_…
npm exec --workspace @honmaru/cli -- honmaru workspace skill shares revoke skill_… sshare_… --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace skill installed --agent agent_…
npm exec --workspace @honmaru/cli -- honmaru workspace skill shareable --agent agent_…
npm exec --workspace @honmaru/cli -- honmaru workspace skill install skill_… --agent agent_…
npm exec --workspace @honmaru/cli -- honmaru workspace skill uninstall skill_… --agent agent_…
npm exec --workspace @honmaru/cli -- honmaru workspace skill share skill_…,skill_… --to-agent agent_…,agent_… --confirm
npm exec --workspace @honmaru/cli -- honmaru workspace room list --query "ops" --type channel
npm exec --workspace @honmaru/cli -- honmaru workspace room discover --query "planning" --limit 25
npm exec --workspace @honmaru/cli -- honmaru workspace room join b:planning
npm exec --workspace @honmaru/cli -- honmaru workspace room leave b:planning
npm exec --workspace @honmaru/cli -- honmaru workspace room rename b:ops --name "Operations"
npm exec --workspace @honmaru/cli -- honmaru workspace room archive b:ops
npm exec --workspace @honmaru/cli -- honmaru workspace room list --archived
npm exec --workspace @honmaru/cli -- honmaru workspace room unarchive b:ops
npm exec --workspace @honmaru/cli -- honmaru workspace room create --name "Launch" --scope private --request-id launch-room-01 --members user_ref_1,user_ref_2
npm exec --workspace @honmaru/cli -- honmaru workspace room read b:ops --limit 30
npm exec --workspace @honmaru/cli -- honmaru workspace message search "release approval" --limit 20
npm exec --workspace @honmaru/cli -- honmaru workspace message get msg_…
npm exec --workspace @honmaru/cli -- honmaru workspace message send --room b:ops --text "Release is ready" --request-id release-note-01
npm exec --workspace @honmaru/cli -- honmaru workspace message forward msg_… --to b:ops --request-id forward-note-01 --comment "Please review"
npm exec --workspace @honmaru/cli -- honmaru workspace thread get b:ops msg_…
npm exec --workspace @honmaru/cli -- honmaru workspace thread msg b:ops msg_… --text "I will verify" --request-id verify-reply-01
npm exec --workspace @honmaru/cli -- honmaru workspace reaction add msg_… --emoji "✅"
npm exec --workspace @honmaru/cli -- honmaru workspace member list
npm exec --workspace @honmaru/cli -- honmaru workspace playbook read
npm exec --workspace @honmaru/cli -- honmaru workspace decision pending --direction mine
npm exec --workspace @honmaru/cli -- honmaru workspace decision search "release approval"
npm exec --workspace @honmaru/cli -- honmaru workspace decision request --title "Approve deploy?" --to "Aiko" --priority high
npm exec --workspace @honmaru/cli -- honmaru workspace call query_rows --args '{"tableId":"tbl_…","limit":25}'
npm exec --workspace @honmaru/cli -- honmaru workspace sdk generate tbl_… --out ./pipeline-client.ts
npm exec --workspace @honmaru/cli -- honmaru workspace app list
npm exec --workspace @honmaru/cli -- honmaru workspace app action list
npm exec --workspace @honmaru/cli -- honmaru workspace app action run app_… recalculate --version 4 --gateway-id gw_… --request-id recalc-01 --input '{"invoiceId":"inv_9"}'
npm exec --workspace @honmaru/cli -- honmaru workspace app action read app_… job_…
npm exec --workspace @honmaru/cli -- honmaru workspace row list tbl_… --query "in progress" --limit 25
npm exec --workspace @honmaru/cli -- honmaru workspace row create tbl_… --values '{"Status":"Open"}'
npm exec --workspace @honmaru/cli -- honmaru workspace workflow run wf_… --text "Review this week's changes"
npm exec --workspace @honmaru/cli -- honmaru workspace file list --scope b:ops --query "release notes"
npm exec --workspace @honmaru/cli -- honmaru workspace file read file_… --version 2
npm exec --workspace @honmaru/cli -- honmaru workspace folders list --scope b:ops --directory reports
npm exec --workspace @honmaru/cli -- honmaru workspace file versions file_… --limit 20
npm exec --workspace @honmaru/cli -- honmaru workspace file create --scope b:ops --path notes/status.md --request-id file-123e4567-e89b-12d3-a456-426614174000 --text "# Status" --content-type text/markdown
npm exec --workspace @honmaru/cli -- honmaru workspace file update file_… --expected-version 2 --text "# Revised status"
npm exec --workspace @honmaru/cli -- honmaru workspace file delete file_… --expected-version 3
npm exec --workspace @honmaru/cli -- honmaru workspace file revert file_… --version 2 --expected-version 4
npm exec --workspace @honmaru/cli -- honmaru workspace file upload --scope b:ops --path assets/logo.png --source ./logo.png --request-id file-123e4567-e89b-12d3-a456-426614174000
npm exec --workspace @honmaru/cli -- honmaru workspace file download file_… --output ./logo.png
npm exec --workspace @honmaru/cli -- honmaru workspace file copy file_… --scope b:archive --path assets/logo.png --request-id file-123e4567-e89b-12d3-a456-426614174001
npm exec --workspace @honmaru/cli -- honmaru workspace execution node list
npm exec --workspace @honmaru/cli -- honmaru workspace execution run --gateway-id gw_… --request-id release-check-01 --code "return {ok:true};" --input null
npm exec --workspace @honmaru/cli -- honmaru workspace execution read job_…
npm exec --workspace @honmaru/cli -- honmaru workspace execution cancel job_…
```

Resource commands are concise aliases for the same scoped MCP tools: Rooms/conversations, messages, threads, Skills, Apps, tables, rows, workflows, follow-ups, and accessible workspace files. Skill commands list/filter visible Skills, read a Skill, create/update a SKILL.md package from a file or directory, inspect installed/shareable Skills, assign/remove Skills, and publish/unpublish with an access-version CAS. `skill get` shows the current visibility and access version; publish requires `--confirm` because every Workspace member can read the Skill. Share-link metadata and revocation are owner-only; revocation requires `--confirm`, and the CLI never prints a bearer URL or token. Link creation and import remain in the human-session UI. New CLI Skills default to private. Updates require the exact `updatedAt` value to avoid overwriting newer edits; package paths and size limits are validated on the server. Assignment changes need a write-scoped token and current Agent management access. Add `--json` for machine-readable output. `workspace call` remains available for other tools and prints the complete JSON result. The workspace server remains the authority for input validation and permissions; private Rooms, DMs and file attachments still require their matching token scopes. Message writes need a stable `--request-id` reused only for identical retries; stale row edits are rejected by `--expected-updated-at` compare-and-set checks, and file edit/delete/restore operations require `--expected-version` from the current file version. File delete appends a reversible tombstone; only a human can permanently purge it. Restore copies an unpurged historical version into a new immutable version, and public links deleted with the file stay revoked. Binary uploads are limited to 25 MiB, require a stable `file-<UUID>` request ID for safe retries, and verify the reserved MIME type, length and SHA-256 before committing an immutable version. Binary downloads recheck current file access at transfer time and refuse to overwrite an existing output unless `--force` is explicit. Review mutating commands and their arguments before running them.

`workspace sdk generate` reads an accessible table's current columns and writes a dependency-free TypeScript module. The generated client follows the table REST contract: `listRows`, strict `createRow`/`updateRow`, and compare-and-swap `deleteRow`. Supply `apiUrl`, `orgId`, and a signed-in `sessionToken` when creating the client; credentials are never written into the generated file. Set `HONMARU_ORG_ID` and `HONMARU_SESSION_TOKEN` for generation, or pass `--org-id`. A pinned version from `workspace table contract publish` can be selected with `--contract-version`; regenerate after changing the schema.

Member, playbook, and decision aliases use the existing tools in both Simple and Harness workspaces. Harness-only aliases for Skills, Apps, tables, rows, workflows, follow-ups, files, and execution require Harness mode and the matching token scope. In Simple workspaces, those Harness-only aliases stay unavailable while the existing Simple tools continue to work through `workspace tools`, `workspace call`, and the member/playbook/decision aliases.

Execution aliases list registered nodes, queue isolated JavaScript, read the caller's own result, or cancel their queued/running job. The run command requires a stable request ID and JSON input. Code and input are sent to the selected node operator, so do not include secrets or unrelated private data. The server enforces the execution scope, node registration, and isolation limits; queued or running is not a completed result.

App action aliases list published actions, run an exact published version on a selected execution node, and read the caller's own scoped result. The request ID is stable across retries only when the app, action, version, node, and input stay the same. The node operator can read the input; do not include secrets or unrelated private data.

Use `--api-url URL` to override the environment URL for one command. The CLI requires HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development servers. Redirects are rejected.

## Human-only Workspace file administration

Agent API tokens can request and list public file shares, but they cannot approve, decline, or revoke them. These decisions and permanent file purges require a signed-in human session token in `HONMARU_SESSION_TOKEN` and an explicit workspace `--org-id`. Supply the token through a trusted local credential store or shell environment; do not put it in command arguments, committed files, or shared logs.

Public Skill share-link creation and import also use the signed-in human session, never an Agent API token. They are Harness-only operations. Create requires `--confirm` because anyone with the link can download the complete Skill package. The new bearer token is shown once; store the output securely. Import reads the bearer from an environment variable named by `--token-env`, never from a positional argument or shell history. Import is not retry-safe: after a timeout or an “import may be saved” response, inspect the destination Skill list before retrying. Set `HONMARU_APP_URL` when the app is hosted outside the default `https://app.honmaruai.com`.

```sh
export HONMARU_SESSION_TOKEN="<signed-in human session token>"
export HONMARU_SKILL_SHARE_TOKEN="<skl_ token from the share creator>"
honmaru workspace skill share-link create skill_id --org-id org_id --expires-in-days 7 --confirm
honmaru workspace skill share-link import --org-id destination_org --token-env HONMARU_SKILL_SHARE_TOKEN --confirm
```

The create result includes the complete app URL with the one-time bearer token embedded in its fragment. Keep it private and share it only with intended recipients. To import, copy the token from the fragment into `HONMARU_SKILL_SHARE_TOKEN` using a local secret store.

Every mutation requires `--confirm`. Approval returns a bearer URL once on stdout; treat it as a secret and avoid logging or sharing the output. Failed or timed-out mutations are never retried automatically. Inspect current state before retrying.

```sh
export HONMARU_SESSION_TOKEN="<signed-in human session token>"
honmaru workspace file share requests
honmaru workspace file share approve fshare_request_id --org-id org_id --confirm
honmaru workspace file share decline fshare_request_id --org-id org_id --confirm
honmaru workspace file share revoke fshare_id --org-id org_id --confirm
```

Permanent purge also requires a reason and one version fence. Use `--version` to purge an eligible historical version; use `--expected-version` only after the file has a deleted tombstone. The server still enforces current workspace membership, owner/administrator authority, held-file restrictions, and compare-and-set checks.

```sh
honmaru workspace file purge file_id --org-id org_id --reason "Remove retained copy" --version 2 --confirm
honmaru workspace file purge file_id --org-id org_id --reason "Purge deleted file" --expected-version 5 --confirm
```

## Local execution gateway

Register a trusted node under **Studio → Harness → Execution nodes**, then keep its separate node token in the environment on that machine:

```sh
npm exec --workspace @honmaru/cli -- honmaru gateway status
npm exec --workspace @honmaru/cli -- honmaru gateway status --json
npm exec --workspace @honmaru/cli -- honmaru gateway install --config /absolute/path/service.json --confirm
npm exec --workspace @honmaru/cli -- honmaru gateway repair --config /absolute/path/service.json --confirm
npm exec --workspace @honmaru/cli -- honmaru gateway upgrade --config /absolute/path/service.json --confirm
export HONMARU_API_URL="https://your-honmaru-api-origin"
export HONMARU_GATEWAY_TOKEN="hgw_…"
npm exec --workspace @honmaru/cli -- honmaru gateway run
```

`gateway status` reports whether the macOS LaunchAgent is installed and loaded, including its process state and PID when available. It does not read the service configuration or token. `gateway run` starts the repository's existing outbound-only worker in the foreground; stop it with Ctrl+C. The node token is inherited through the environment and is never added to process arguments or printed. On macOS, `install`, `repair` and `upgrade` invoke the existing LaunchAgent installer, which snapshots the local runtime and reloads the service for automatic connection at login. They require an absolute config path and `--confirm`; review the config first. The installer requires the referenced token file to be owned by the current user and inaccessible to group or other users. These operations do not register a new cloud node or create a paid service.

The aliases are an incremental CLI surface, not full Kylon CLI parity. Room management covers listing, public managed Room discovery, joining/leaving, rename, archive/restore, creation, conversation history, versioned public/private changes, member management, and Agent assignment. `room agent access` lists only the current Room members who still need access; `room agent add --grant-access-members REF,...` grants only the selected people. For external Agents, review and pass `--acknowledge-external-processing` only after the processing notice. None of these commands silently adds people to the Room. Thread/message management covers read, search, create replies, send, edit, and delete. Edits and deletes require the current message version; deleting a thread with other people's replies also requires `--with-replies`. `--acknowledge-dlp` acknowledges warning-only DLP matches; blocking rules still reject the edit. Message forward, participant management, and agent activation remain open. File aliases cover text and binary upload/download, immutable version history, reversible delete/restore, copying a readable source version into an explicitly writable scope, and requesting a version-pinned public share. Share approval, token reveal, revocation and human-only permanent purge are available through the session-authenticated CLI commands below. Skill management now supports Kylon-style install/uninstall aliases and explicit multi-Skill/multi-Agent assignment (up to five of each), with confirmation and per-pair authorization; Skill share-link create/import are now available as explicitly confirmed human-session CLI commands; the UI remains available. Gateway repair/upgrade, browser/device sign-in, secure credential storage, Connections, and the remaining Kylon command families are also still open.
