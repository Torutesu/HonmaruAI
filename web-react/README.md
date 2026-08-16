# Honmaru AI Web Client (Phase 8)

A production-ready React + TypeScript web client for the Honmaru AI decision feed system, implementing the AG-UI protocol v1.

## Features

- **Real-time decision feed** via WebSocket AG-UI protocol
- **Full decision lifecycle**: receive, decide (approve/decline/choose/reply), rollback
- **Multi-user sync**: see other users' online status and decisions in real-time
- **AG-UI event stream** debug logger
- **Responsive design** (desktop & mobile)

## Setup

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

## Architecture

### Types
- `src/types/agui.ts` — AG-UI event definitions
- `src/types/card.ts` — Decision card types

### Services
- `src/services/WebSocketClient.ts` — AG-UI WebSocket client
  - Parses AG-UI events (STATE_SNAPSHOT, STATE_DELTA, TOOL_CALL_*, TOOL_CALL_RESULT)
  - Applies JSON Patch RFC 6902 operations
  - Manages tool call ID tracking for decision correlation
  - Sends outbound `tool_result` decisions

### Components
- `src/components/Dashboard.tsx` — Main feed layout (pending & decided sections)
- `src/components/DecisionCard.tsx` — Individual card with actions

### Main App
- `src/App.tsx` — Login page, user selection, connection setup
- `src/main.tsx` — React root

## Environment Variables

Copy `.env.example` to `.env.local` to override the defaults shown on the login screen:

- `VITE_RELAY_URL` — default relay WebSocket URL (still editable on the login form)
- `VITE_ORG_ID` — default organization id
- `VITE_DEBUG` — set to `true` to have the debug event log open by default

## Testing

### Automated

```bash
npm test        # vitest, watches by default; CI=true npm test runs once and exits
npm run build   # tsc --noEmit-equivalent type check + production build
```

`src/services/WebSocketClient.test.ts` covers the AG-UI event handling directly (join payload,
state-reference identity after STATE_SNAPSHOT/tool-call-derived updates, toolCallId linking,
reconnect-after-unexpected-close vs. no-reconnect-after-explicit-disconnect) against a fake
WebSocket — no relay or browser needed.

### Manual Testing with Relay

1. **Start the relay**:
   ```bash
   cd server
   npm start
   # Should output: Server running on port 8080
   ```

2. **Start the web client dev server** (from `/web`):
   ```bash
   npm run dev
   # Should output: http://localhost:3000
   ```

3. **Connect as first user** (Alice):
   - Open http://localhost:3000
   - Enter user ID: `alice`
   - Relay URL: `ws://localhost:8080`
   - Org: `core-team`
   - Click "Connect"

4. **Connect as second user** (Bob):
   - Open another browser tab to http://localhost:3000
   - Enter user ID: `bob`
   - Same relay & org
   - Click "Connect"

5. **Send a decision from Alice to Bob** (via iOS or CLI):
   ```bash
   # From the relay, you can send a decision via the API
   curl -X POST http://localhost:8080/api/route \
     -H "Content-Type: application/json" \
     -d '{
       "text": "Approve the design proposal",
       "sender": "alice",
       "organization": "core-team",
       "reader": "bob"
     }'
   ```

6. **Observe**:
   - Bob's web client shows a new card in "Pending Decisions"
   - Bob clicks "Approve"
   - Alice's web client sees the card move to "Decided" with decision recorded
   - Event log shows `tool_result` event

### Cross-Platform Testing (iOS ↔ Web)

1. **iOS sends decision**:
   - Open iOS app, connect as Alice
   - Send an instruction (via AI composer)
   - Relay routes to Bob
   - Bob's iOS shows card

2. **Web receives & approves**:
   - Open web client as Bob in another browser
   - Both iOS and web see the same card (synced via WebSocket)
   - Click Approve on web
   - iOS immediately shows card as approved
   - Alice's iOS sees the decision result

3. **Rollback from web**:
   - Web shows "↩ Roll back" button on decided cards
   - Click it
   - Card returns to pending
   - iOS reflects the change instantly

## Debug Features

- **Event Log**: Toggle "Show Debug Log" to see all AG-UI events in real-time
- **Connection Info**: Displays current URL, user, org, and card counts
- **Browser DevTools**: Full React/TypeScript debugging

## Protocol Details

### Inbound Events
- `STATE_SNAPSHOT` — Initial card state on connection
- `STATE_DELTA` — JSON Patch operations (RFC 6902)
- `TOOL_CALL_START/ARGS/END` — Incoming decision request
- `TOOL_CALL_RESULT` — Decision result echo from other clients
- `CUSTOM presence` — User online/offline status

### Outbound Events
- `tool_result` — Send decision (approve/decline/choose/reply/acknowledge)
  ```json
  {
    "type": "tool_result",
    "payload": {
      "toolCallId": "...",
      "content": {
        "cardId": "...",
        "action": "approve|decline|choose|reply|acknowledge",
        "actorUserID": "...",
        "decidedAt": "2024-08-12T...",
        "optionId": "...",
        "replyText": "..."
      }
    }
  }
  ```

- `rollback` — Undo a decision
  ```json
  {
    "type": "rollback",
    "payload": { "cardId": "..." }
  }
  ```

## Deployment

For production, build and serve the `dist/` output:

```bash
npm run build
# Deploy dist/ to a static host (Vercel, Netlify, Cloudflare Pages, etc.)
```

Or embed in a Node.js server:

```javascript
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.static(join(__dirname, 'dist')))
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})
app.listen(3000)
```

## References

- [AG-UI Protocol Documentation](../docs/agui-protocol.md)
- [Server Relay Implementation](../server/index.js)
- [iOS App (Phase 8 implementation)](../TikTokForWork/)
