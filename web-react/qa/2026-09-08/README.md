# Historical web candidate — superseded local fixture evidence

This directory records the earlier `7fd1a2d` candidate, before the current
Figma alignment. Its screenshots and checklist are retained as historical
evidence and do not qualify the current interface. The current references,
visual review, and local browser regression results are in
[`docs/figma-alignment/2026-09-08/`](../../../docs/figma-alignment/2026-09-08/),
including [`browser-regression/checks.json`](../../../docs/figma-alignment/2026-09-08/browser-regression/checks.json).

Captured 2026-09-08 using the implemented frontend, a real local Cloudflare
Worker, disposable D1/R2 under `/tmp/honmaruai-web-qa`, and Chromium via
Playwright 1.62.1. These are **local fixture checks**, not production release
qualification. The test account display name is “Release Review”; its address
uses the reserved `.invalid` domain. No tokens, passwords, browser storage
state, production customer data, or remote integration credentials are stored
in this evidence directory.

## Verified at that checkpoint

- `npm ci --no-audit --ignore-scripts` succeeds with the locked toolchain.
- `npm run test:run`: 22 tests across transport, API configuration, and context
  presentation.
- `npm run build`: TypeScript check and Vite 8.2.2 production build succeed.
- `npm run test:browser`: 13 checkpoints; exact completed checks are in
  `checks.json`. Signup, persisted creation, approval, undo, reply, record,
  session reload, canceled gestures, modal focus/shortcut isolation, mobile
  layout, notification keyboard behavior, and pending-compose cancellation
  were exercised against the local Worker.
- No browser runtime errors in that run.

## Screenshots

- `screenshots/auth-desktop.png`: authentication and explicitly labeled example.
- `screenshots/inbox-empty-desktop.png`: authenticated empty workspace.
- `screenshots/inbox-decision-desktop.png`: real locally persisted request.
- `screenshots/inbox-decision-mobile.png`: 390 × 844 light presentation.
- `screenshots/inbox-decision-mobile-dark.png`: dark and reduced-motion settings.

Generated identity-routing context is suppressed only when it exactly matches
the known sender, recipient, or route names. Substantive context is retained;
full source requests are accessible when they differ from the summary.

## Run the current checks

Follow the current disposable Worker and frontend instructions in [`../../README.md`](../../README.md).
Then run `npm run test:browser` from `web-react`. The script restricts API traffic
to local services and writes new evidence to `/tmp`, leaving these historical
images intact. Current Figma selectors and workflows differ from this checkpoint;
running today's script does not reproduce this older visual state.

## Boundaries

No public deployment, external AI call, Slack/GitHub/Notion/Gmail delivery,
email/push delivery, production credentials, or native iOS hardware behavior
is proven here. Vite 8.2.2, React plugin 6.1.1, and Vitest 4.1.11 replace the old
Vite 4/Vitest 0 toolchain; public upstream advisories informed those updates.
A full `npm audit` was not run to completion: automatic approval review rejected
uploading the project's dependency metadata to npm's public advisory endpoint.
