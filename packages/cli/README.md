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
```

`workspace call` sends an MCP `tools/call` request and prints the complete JSON result. The workspace server remains the authority for input validation and permissions. Review mutating tool names and arguments before running them.

Use `--api-url URL` to override the environment URL for one command. The CLI requires HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development servers. Redirects are rejected.

This initial CLI slice covers tool discovery and execution. It does not yet provide local credential storage, OAuth sign-in, resource editors, or the full command family of Kylon's workspace CLI.
