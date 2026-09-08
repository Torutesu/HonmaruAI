# Web redesign evidence — September 8, 2026

These are fixture screenshots of the implemented React application, not design mockups.

- `web-inbox-*`, `web-detail-*`, `web-sent-*`, `web-completed-*`, and `web-compose-mobile` show the explicitly labeled **Sample workspace**. It uses only client memory. Browser tests assert zero backend requests or WebSocket connections during sample interactions.
- `web-real-request-*`, `web-compose-preview-desktop`, `web-empty-desktop`, and `web-workspace-desktop` show a disposable local Worker and local D1 with a newly registered `.invalid` test account. The workspace was removed after the test. No production data was used.
- The cold CI harness built a production bundle, initialized its own empty D1/R2, used ports 44149/48949, ran all 13 grouped browser checks, and cleaned up its servers and state. Full check names are in `web-checks.json`.
- Screenshots intentionally exclude session tokens, passwords, invite codes, and browser storage. No storage-state artifact is retained.
- Notion database-selection controls were additionally checked against explicit local HTTP fixtures; no live Notion account or external tool was used.
- This verifies local request workflows and responsive rendering. It does not prove live deployment, real external notifications, provider credentials, or external connector behavior.

Reproduce after installing both locked dependency trees and Chromium:

```sh
WEB_QA_WEB_PORT=4317 WEB_QA_WORKER_PORT=8797 WEB_QA_OUTPUT=/tmp/honmaru-redesign-evidence bash web-react/scripts/ci-browser-smoke.sh
```

The script rejects non-local HTTP requests and refuses already-occupied ports. Request creation checks recipient and editable preview before delivery; approval and undo wait for server-confirmed state. Reply is a completed response, not a chat message. Undo does not reverse changes in external tools.
