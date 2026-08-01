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

## Tests

- `core.test.ts` — protocol decoding (including forward compatibility) and card-store reducers
- `realtime.integration.test.ts` — boots the relay, asserts the built app is served, a card sent by one client reaches another client's store, and a client reconnects and re-syncs after the relay is killed

## Status

Phase 1 complete: realtime feed, read-only. See [../docs/WEB_PLAN.md](../docs/WEB_PLAN.md).
