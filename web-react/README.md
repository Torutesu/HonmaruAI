# Honmaru AI — web client

The same product as the phone app, in a browser: one decision per screen,
swipe or press to decide, and one button — *Tell your AI*. It speaks the
relay's AG-UI protocol over a WebSocket and the Worker's HTTP routes for
everything else (sign-in, the team, tools, the record).

- **Phone width** (< 1080px): a snap-scrolled feed, a three-tab bar (feed,
  compose, you). History and Tools live under *You*.
- **Laptop** (≥ 1080px): the bar becomes a rail with all five, the feed becomes
  a scrollable queue, screens open beside the rail.
- **Installable** as a PWA; on an iPhone that is what makes Web Push possible.
- **Two languages**, English and Japanese, for the interface (`src/utils/i18n.ts`)
  and — via the Worker — for every card and notification.

## Run it

```bash
npm ci
npm run dev                       # http://localhost:3000 against localhost:8787
VITE_API_HOST=… npm run build     # production build in dist/
```

`VITE_API_HOST` is the backend host **without a scheme**; the page derives
`http`/`ws` or `https`/`wss` from its own URL. It is baked in at build time —
`scripts/deploy-pages.sh` exists to get exactly this right on Cloudflare Pages.
`.env.example` shows the two variables.

## Check it

```bash
npx tsc --noEmit    # types
npx vitest run      # the WebSocket client, against a fake socket
npm run build       # what CI runs
../e2e/run.sh       # the real thing: a Worker on workerd, a D1, this build, a browser
```

The unit suite covers the protocol client: the join payload, state identity
after snapshots and deltas, `toolCallId` correlation, reconnect-with-backoff,
the 1008 refusal that must not be retried, and the **outbox** — a decision
made while the relay is unreachable is held and delivered after the next
accepted join, in order, once.

The end-to-end suite signs up with a code it reads out of the email the Worker
really sent, tells its AI something, decides, undoes, invites, joins, revokes
and evicts — 28 steps, screenshots at phone and laptop sizes, every screen.

## Where things are

| Path | What |
|------|------|
| `src/App.tsx` | The way in: welcome → sign-in → code → onboarding → app |
| `src/components/Dashboard.tsx` | The shell: socket, feed/list, tab bar, sheets, screens, toasts |
| `src/components/Feed.tsx` | One decision per page; swipe, buttons, A/D keys, "Ask anything" |
| `src/components/ClassicList.tsx` | The same decisions as a list |
| `src/screens/*.tsx` | Welcome, SignIn, Otp, Onboarding, Profile, History, Tools, Team, Notifications, Plans |
| `src/services/WebSocketClient.ts` | AG-UI over WebSocket: events in, `tool_result` etc. out, reconnect, outbox |
| `src/utils/i18n.ts` | The interface's words, keyed by their English |
| `src/utils/push.ts`, `public/sw.js` | Web Push: subscribe, and show a notification with the tab closed |
| `src/theme.css` | Design tokens and the laptop layout ([docs/design-system.md](../docs/design-system.md)) |

## What the feed promises

- Nothing is shown as "All clear" until the relay has answered. Before that
  the feed says it is opening.
- Every decision leaves six seconds of **Undo** on the screen; History keeps
  Undo for anything you decided.
- A decision made offline is kept and sent when the relay is back; the top
  bar says how many are waiting.
- Keyboard: ↑ ↓ (or j k) to move, **A** approve, **D** decline, **N** tell
  your AI, **Esc** closes anything. The keys are inert while a sheet or a
  screen is open.
- A render error shows a screen with a Reload button, in the reader's
  language, rather than a blank page.

## Protocol

Inbound: `STATE_SNAPSHOT`, `STATE_DELTA` (RFC 6902 patches on `cardsById`),
`TOOL_CALL_START/ARGS/END` (a `request_decision` becomes a card),
`TOOL_CALL_RESULT`, `CUSTOM presence`, `RUN_ERROR` (with a `code` when the
relay is refusing: `not-a-member`, `sign-in-required`, `client-too-old`).

Outbound: `join` (with the session token; identity comes off the session, not
the payload), `tool_result` (a decision, carrying the `toolCallId` of the
request it answers), `card_created`, `rollback`, `nudge`, `set_business`.

Details: [docs/agui-protocol.md](../docs/agui-protocol.md) and the relay in
[worker/src/relay.js](../worker/src/relay.js).
