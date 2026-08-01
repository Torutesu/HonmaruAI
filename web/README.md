# Web client

React + TypeScript thin client for the relay. Product logic stays server-side; this renders state and captures input.

## Run

```bash
npm install
npm run dev      # http://localhost:5173, HTTP proxied to the relay on :8080
npm test         # core unit tests + a real-relay integration suite
npm run build    # type-check + build to dist/
```

Serve the build from the relay (same origin — no CORS, session cookie works):

```bash
cd ../server && WEB_DIST_PATH=../web/dist npm start   # app at http://127.0.0.1:8080/
```

## Layout

```
src/
  core/        framework-agnostic — never imports React
    types.ts       mirrors the Swift models
    protocol.ts    WS envelopes + tolerant decoding
    socket.ts      RelaySocket: join, snapshot/deltas, auto-reconnect
    api.ts         same-origin REST (session cookie)
    stores/        zustand stores mirroring the Swift services
  features/    screens and their components
  styles/      design tokens (same values as Theme.swift) + base
```

`core/` runs unchanged in Node, which is how the integration test drives the real relay with the real client code.

## Two surfaces, one app

Below 1024px you get the phone shell: one card at a time, swipe-free buttons, a composer at the bottom. At 1024px and up `App` renders `features/workbench` instead — sidebar, decision queue and a context column showing the selected card's source conversation side by side. Both read the same stores and the same socket; nothing is duplicated.

Keyboard (workbench): `J`/`K` or `↑`/`↓` move, `⏎` approve, `⌫` decline, `R` reply, `?` shortcuts, `⌘K` command palette.

## Tests

- `core.test.ts` — protocol decoding (including forward compatibility) and card-store reducers
- `features/workbench/shortcuts.test.ts` — the keyboard table as a pure function: typing never decides, `⌘K` still works from a text field, notifications can't be declined
- `realtime.integration.test.ts` — boots the relay, asserts the built app is served, a card sent by one client reaches another client's store, and a client reconnects and re-syncs after the relay is killed

## Status

Phase 5 complete: decision loop, channels, settings, PWA + Web Push + dictation, desktop workbench. See [../docs/WEB_PLAN.md](../docs/WEB_PLAN.md).
