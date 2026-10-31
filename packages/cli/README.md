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
npm exec --workspace @honmaru/cli -- honmaru workspace call query_rows --args '{"tableId":"tbl_…","limit":25}'
npm exec --workspace @honmaru/cli -- honmaru workspace app list
npm exec --workspace @honmaru/cli -- honmaru workspace row list tbl_… --query "in progress" --limit 25
npm exec --workspace @honmaru/cli -- honmaru workspace row create tbl_… --values '{"Status":"Open"}'
npm exec --workspace @honmaru/cli -- honmaru workspace workflow run wf_… --text "Review this week's changes"
npm exec --workspace @honmaru/cli -- honmaru workspace file list --scope b:ops --query "release notes"
npm exec --workspace @honmaru/cli -- honmaru workspace file read file_… --version 2
```

Resource commands are concise aliases for the same scoped MCP tools: Apps, tables, rows, workflows, follow-ups, and accessible workspace files. Add `--json` for machine-readable output. `workspace call` remains available for other tools and prints the complete JSON result. The workspace server remains the authority for input validation and permissions; in particular, stale row edits are rejected by `--expected-updated-at` compare-and-set checks. Review mutating commands and their arguments before running them.

The resource aliases need Harness tools enabled and a token with the matching scope. In Simple workspaces, the aliases remain unavailable and the existing Simple-mode tools continue to work through `workspace tools` and `workspace call`.

Use `--api-url URL` to override the environment URL for one command. The CLI requires HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development servers. Redirects are rejected.

The aliases are an incremental CLI surface, not full Kylon CLI parity. Local gateway lifecycle, browser/device sign-in, secure credential storage, resource commands for Rooms/messages/Agents/connections/Skills and the remaining Kylon command families are still open.
