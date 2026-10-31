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
npm exec --workspace @honmaru/cli -- honmaru workspace member list
npm exec --workspace @honmaru/cli -- honmaru workspace playbook read
npm exec --workspace @honmaru/cli -- honmaru workspace decision pending --direction mine
npm exec --workspace @honmaru/cli -- honmaru workspace decision search "release approval"
npm exec --workspace @honmaru/cli -- honmaru workspace decision request --title "Approve deploy?" --to "Aiko" --priority high
npm exec --workspace @honmaru/cli -- honmaru workspace call query_rows --args '{"tableId":"tbl_…","limit":25}'
npm exec --workspace @honmaru/cli -- honmaru workspace app list
npm exec --workspace @honmaru/cli -- honmaru workspace row list tbl_… --query "in progress" --limit 25
npm exec --workspace @honmaru/cli -- honmaru workspace row create tbl_… --values '{"Status":"Open"}'
npm exec --workspace @honmaru/cli -- honmaru workspace workflow run wf_… --text "Review this week's changes"
npm exec --workspace @honmaru/cli -- honmaru workspace file list --scope b:ops --query "release notes"
npm exec --workspace @honmaru/cli -- honmaru workspace file read file_… --version 2
```

Resource commands are concise aliases for the same scoped MCP tools: Apps, tables, rows, workflows, follow-ups, and accessible workspace files. Add `--json` for machine-readable output. `workspace call` remains available for other tools and prints the complete JSON result. The workspace server remains the authority for input validation and permissions; in particular, stale row edits are rejected by `--expected-updated-at` compare-and-set checks. Review mutating commands and their arguments before running them.

Member, playbook, and decision aliases use the existing tools in both Simple and Harness workspaces. Harness-only aliases for Apps, tables, rows, workflows, follow-ups, files, and execution require Harness mode and the matching token scope. In Simple workspaces, those Harness-only aliases stay unavailable while the existing Simple tools continue to work through `workspace tools`, `workspace call`, and the member/playbook/decision aliases.

Use `--api-url URL` to override the environment URL for one command. The CLI requires HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development servers. Redirects are rejected.

## Local execution gateway

Register a trusted node under **Studio → Harness → Execution nodes**, then keep its separate node token in the environment on that machine:

```sh
export HONMARU_API_URL="https://your-honmaru-api-origin"
export HONMARU_GATEWAY_TOKEN="hgw_…"
npm exec --workspace @honmaru/cli -- honmaru gateway run
```

`gateway run` starts the repository's existing outbound-only worker in the foreground; stop it with Ctrl+C. The node token is inherited through the environment and is never added to process arguments or printed. This does not install or manage the launch-at-login service.

The aliases are an incremental CLI surface, not full Kylon CLI parity. Gateway status/repair, browser/device sign-in, secure credential storage, resource commands for Rooms/messages/Agents/connections/Skills and the remaining Kylon command families are still open.
