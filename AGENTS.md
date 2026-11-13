# Working in this repository

Most changes here are made by coding agents working in parallel branches, and by people
reviewing them. This page is where both start. `apps/mobile/AGENTS.md` adds the Expo
specifics for the mobile app.

## What is where

| Directory | What it is | Check it with |
| --- | --- | --- |
| `worker/` | The backend: a Cloudflare Worker with D1, R2 and Durable Objects. Routes, relay, agents, Harness (`src/harness/`), MCP (`src/mcp*.js`). | `npm test` (whole suite ~45 min); `npx vitest run test/<file>.test.js` for one file |
| `web-react/` | The web app (Vite + React), also loaded by the desktop shell | `npm run build && npx tsc --noEmit -p . && npm test` |
| `apps/desktop/` | The Electron shell around the hosted web app | `npm test` |
| `apps/mobile/`, `packages/` | Expo app and shared core / protocol / CLI (npm workspaces at the root) | see `scripts/verify.sh` |
| `TikTokForWork/` | The native iOS app (Xcode) | CI builds it on macOS |
| `server/` | The reference relay | `npm test` |
| `e2e/` | End-to-end run against a local stack in a real browser | `./e2e/run.sh` (`E2E_SPEC=e2e/<spec>.mjs` for one spec) |
| `.github/workflows/` | CI, deploys, backups, operational reports | `.github/scripts/*.test.cjs` |

## Before you push

- `scripts/verify.sh` runs what CI runs, in one command (`--quick` skips the Worker suite,
  `--e2e` adds the end-to-end run). At least run the targeted tests for what you changed,
  and the full Worker suite before merging anything under `worker/src/`.
- A fix comes with a test that fails without it. Run it against the old code once to see
  it fail.
- Run end-to-end tests from a separate git worktree, not from a checkout another task is
  using; the local stack writes into the tree.

## Rules the code depends on

- **Fail closed.** An authorization read that fails denies, never grants. When you make
  checks concurrent, decide them in the original order, and never let a refused request
  write anything (`worker/test/tenant-isolation.test.js` checks this).
- **Every query on a workspace table names `org_id`.** `worker/test/workspace-queries.test.js`
  counts the exceptions; raise a count only with a comment saying why.
- **Schema changes go in both** `worker/schema.sql` (fresh databases) **and**
  `worker/migrations.sql` (one statement per line, as the deploy greps them).
  `worker/test/migration.test.js` replays exactly what the deploy runs.
- **Interface text goes through `t()`**, with entries in
  `web-react/src/utils/locales/{ja,es,fr,de}.ts`.
- **Wrangler is pinned** in `worker/package.json`; workflows run that exact version
  (`.github/scripts/wrangler-pin.test.cjs`).
- **This repository is public, and so is every Actions log and run summary.** A workflow
  that reads production must print counts and statuses, never logins, emails, workspace
  ids or row contents.
- Comments explain why, in plain prose; the code says what.

## Production

Merging to `main` deploys: `deploy-worker.yml` (after CI passes on the same commit: tests,
D1 schema and migrations, then the Worker) and `deploy-web.yml`. Operational workflows
(`media-inventory.yml`, `perf-report.yml`, `backup-d1.yml`) run by hand or on a schedule
against production. Do not run them, or anything else that touches production, without
being asked.
