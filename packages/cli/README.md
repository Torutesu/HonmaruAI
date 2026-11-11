# Honmaru workspace CLI

`@honmaru/cli` is a small Node.js command line client for the same scoped workspace tools used by Honmaru's MCP endpoint. It reads only the tools allowed to its agent token, then lets an operator call those tools with JSON arguments.

## Set up

Use Node.js 22 or later. Create an agent token in **Studio → API**, then set the API origin and token in the shell that runs the CLI:

```sh
export HONMARU_API_URL="https://your-honmaru-api-origin"
export HONMARU_API_TOKEN="hm_…"
```

The token stays in the environment and is not written to a config file or printed by the CLI. The server checks token expiry, workspace membership, IP and SSO policy, scopes, and whether Harness tools are enabled for that workspace. Simple workspaces continue to expose their existing tools.

## Use

```sh
npm install
npm exec --workspace @honmaru/cli -- honmaru workspace tools
npm exec --workspace @honmaru/cli -- honmaru workspace tools --json
npm exec --workspace @honmaru/cli -- honmaru workspace call list_apps
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

Resource commands are concise aliases for the same scoped MCP tools: rooms/conversations, messages, threads, Apps, tables, rows, workflows, follow-ups, and accessible workspace files. Add `--json` for machine-readable output. `workspace call` remains available for other tools and prints the complete JSON result. The workspace server remains the authority for input validation and permissions; private Rooms, DMs and file attachments still require their matching token scopes. Message writes need a stable `--request-id` reused only for identical retries; stale row edits are rejected by `--expected-updated-at` compare-and-set checks, and file edit/delete/restore operations require `--expected-version` from the current file version. File delete appends a reversible tombstone; only a human can permanently purge it. Restore copies an unpurged historical version into a new immutable version, and public links deleted with the file stay revoked. Binary uploads are limited to 25 MiB, require a stable `file-<UUID>` request ID for safe retries, and verify the reserved MIME type, length and SHA-256 before committing an immutable version. Binary downloads recheck current file access at transfer time and refuse to overwrite an existing output unless `--force` is explicit. Review mutating commands and their arguments before running them.

`workspace sdk generate` reads an accessible table's current columns and writes a dependency-free TypeScript module. The generated client exposes typed `listRows`, `createRow`, and `updateRow` methods using column IDs; it does not embed credentials. Pass `apiUrl` and an active API token when creating the client, and regenerate after changing the table schema.

Member, playbook, and decision aliases use the existing tools in both Simple and Harness workspaces. Harness-only aliases for Apps, tables, rows, workflows, follow-ups, files, and execution require Harness mode and the matching token scope. In Simple workspaces, those Harness-only aliases stay unavailable while the existing Simple tools continue to work through `workspace tools`, `workspace call`, and the member/playbook/decision aliases.

Execution aliases list registered nodes, queue isolated JavaScript, read the caller's own result, or cancel their queued/running job. The run command requires a stable request ID and JSON input. Code and input are sent to the selected node operator, so do not include secrets or unrelated private data. The server enforces the execution scope, node registration, and isolation limits; queued or running is not a completed result.

App action aliases list published actions, run an exact published version on a selected execution node, and read the caller's own scoped result. The request ID is stable across retries only when the app, action, version, node, and input stay the same. The node operator can read the input; do not include secrets or unrelated private data.

Use `--api-url URL` to override the environment URL for one command. The CLI requires HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development servers. Redirects are rejected.

## Local execution gateway

Register a trusted node under **Studio → Harness → Execution nodes**, then keep its separate node token in the environment on that machine:

```sh
npm exec --workspace @honmaru/cli -- honmaru gateway status
npm exec --workspace @honmaru/cli -- honmaru gateway status --json
export HONMARU_API_URL="https://your-honmaru-api-origin"
export HONMARU_GATEWAY_TOKEN="hgw_…"
npm exec --workspace @honmaru/cli -- honmaru gateway run
```

`gateway status` reports whether the macOS LaunchAgent is installed and loaded, including its process state and PID when available. It does not read the service configuration or token. `gateway run` starts the repository's existing outbound-only worker in the foreground; stop it with Ctrl+C. The node token is inherited through the environment and is never added to process arguments or printed. This does not install or manage the launch-at-login service.

The aliases are an incremental CLI surface, not full Kylon CLI parity. Room management covers listing, public managed Room discovery, joining/leaving, rename, archive/restore, creation, and conversation history; notification settings, membership editing, and agent assignment are still open. Discovery and membership changes act as the human owner of the API token and never add an Agent or grant Agent access. Thread/message management covers read, search, create replies, and sending, while edit/delete/forward, participant management, pins, title changes, and agent activation are still open. File aliases cover text and binary upload/download, immutable version history, reversible delete/restore, and copying a readable source version into an explicitly writable scope. Public share management and human-only permanent purge are still outside the CLI. Gateway repair/upgrade, browser/device sign-in, secure credential storage, Connections, Skills, and the remaining Kylon command families are also still open.
