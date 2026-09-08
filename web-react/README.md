# Honmaru AI web client

React and TypeScript client for the Honmaru decision feed. It connects to the
Cloudflare Worker in `../worker` for authentication, routing, live decisions,
team invitations, notification preferences, and the decision record.

The interface has a desktop workspace and a mobile card feed, with automatic
light/dark appearance. Requests remain visible until the server confirms the
saved decision. Creating a request waits for the server's persisted-card echo;
an offline or rejected request keeps its draft and shows an error.

## Run locally

Use Node 20.19+ or Node 22.12+. Install the locked dependencies:

```sh
npm ci --no-audit
npm run dev
```

The frontend opens at `http://127.0.0.1:3000`. Start the Worker separately on
port 8787; the historical Node relay has a different authentication contract
and is not this client's development backend.

For a disposable local backend, from `../worker`:

```sh
npm ci --no-audit
WRANGLER_SEND_METRICS=false npx --no-install wrangler d1 execute tiktokforwork --local --persist-to /tmp/honmaruai-web-qa --file schema.sql
WRANGLER_SEND_METRICS=false npx --no-install wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to /tmp/honmaruai-web-qa
```

Use the account form to create a test account. A new account gets its own
workspace; a valid invite code joins the corresponding existing workspace.
No AI provider is required for local tests: the Worker uses its fallback router.

## Build configuration

`VITE_API_HOST` accepts an HTTP(S) origin or bare host. Local development defaults
to `localhost:8787`. Production defaults to the web page's origin, so a separately
hosted Worker requires an explicit API origin at build time:

```sh
VITE_API_HOST=https://your-api.example.com npm run build
```

A secure page requires an HTTPS API. Invalid origins containing credentials,
paths, queries, or fragments are rejected. Sessions are tied to their API origin.
`VITE_DEBUG=true` enables a diagnostic event log; keep it off in production.

Serve `dist/` as static assets. Keep `sw.js`, the manifest, and icons at the
origin root for installed-app and push support. A successful local build does
not verify production deployment, configured push/email delivery, paid AI,
connector credentials, or native iOS behavior.

## Checks

```sh
npm run test:run   # deterministic transport and presentation regressions
npm run build     # TypeScript check and production bundle
npx --no-install playwright install chromium
npm run test:browser
```

The browser smoke test requires the disposable local Worker and frontend above.
It signs up `.invalid` test accounts and exercises real request routing,
persistence, approval, undo, reply, history, modal isolation, canceled gestures,
responsive layout, and session reload. It rejects non-local HTTP requests.
No production account or storage state is saved. Screenshots and a JSON checklist
are written to `/tmp/honmaruai-web-qa/screenshots` by default.

Optional `WEB_QA_URL` and `WEB_QA_OUTPUT` override the local URL and output path.
`PLAYWRIGHT_MODULE` can point to an already provisioned Playwright installation.
Checked local evidence is under `qa/2026-09-08/`.

The locked Vite 8.2.2 and Vitest 4.1.11 toolchain replaces unsupported older
versions. Public upstream advisories informed this update. A full `npm audit`
was not completed because automatic approval review rejected sending the
project's dependency metadata to the public advisory endpoint.
