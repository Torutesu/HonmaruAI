# TikTok for Work

AI-native decision feed for teams. Humans talk to their AI; agents route Decision Cards across the org in real time.

## Stack

| Layer | Tech |
|-------|------|
| iOS | SwiftUI thin client on protocol v1 (URLSession WebSocket + REST) |
| Web | React/TS client (`backend/packages/web`) on the same protocol |
| Backend | TypeScript monorepo (`backend/`) — schema-first protocol + Hono/SQLite server, see [backend/README.md](backend/README.md) |
| AI | OpenRouter via server (async refinement pipeline + agent memory), deterministic fallback |
| GitHub | Server-side `github_issues` integration (pluggable) |

> `server/` is the original localhost demo relay, kept for reference only —
> the iOS app now speaks the production backend.

## Quick start

### 1. Start the backend

```bash
cd backend
npm install
npm run dev        # API + WebSocket on http://127.0.0.1:8081 (dev login enabled)
```

### 2. Run the iOS app

```bash
xcodegen generate
open TikTokForWork.xcodeproj
```

On first launch: enter your name and job title, create a workspace (or join
with an invite code from a teammate's ⋯ menu). Two simulators against the
same backend give you the full cross-user flow — instruction → card →
approve/decline/revise/delegate — with AI refinement and SLA escalation
happening server-side.

The web client (`npm run dev -w @honmaru/web`) joins the same org from a
browser.

---

The sections below describe the original localhost-relay demo setup and are
kept for reference.

### 1. Configure GitHub OAuth app

1. [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) → **New OAuth App**
2. Homepage URL: `http://localhost:8080`
3. Callback URL: `tiktokforwork://oauth/callback`
4. Copy Client ID and Client secret

### 2. Start localhost backend

```bash
cd server
cp .env.example .env
# paste GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET into .env
# paste OPENROUTER_API_KEY into .env (see server/.env.example)
npm install
npm start
```

- HTTP: `http://127.0.0.1:8080`
- WebSocket: `ws://127.0.0.1:8080`

### 3. Run iOS app

```bash
xcodegen generate
open TikTokForWork.xcodeproj
```

On sign-in:

1. **Sign in with GitHub** (opens secure browser sheet)
2. Pick **repository** from your GitHub account
3. **Relay server** — `ws://127.0.0.1:8080` (AI routes through relay when `OPENROUTER_API_KEY` is set)

### 4. Two-simulator demo

1. Start relay server
2. Simulator A → Alice
3. Simulator B → Bob
4. Alice → Message your AI → natural language instruction
5. Bob sees card via WebSocket
6. Bob approves → GitHub Issue created → Alice gets result

## Architecture

```
┌─────────────┐   OAuth code    ┌────────────────────┐
│  iOS Client │───────────────►│ localhost:8080     │
│  (SwiftUI)  │◄──access token─│ GitHub token swap  │
└──────┬──────┘                │ WebSocket relay    │
       │         card events    └────────────────────┘
       └────────────────────────►
       │
       ├── AIService → relay `/ai/route` → OpenRouter
       └── GitHubService → Issues API
```

Client secret stays on localhost server only.

## Production backend (`backend/`)

The cross-platform successor to the demo relay. All business logic
(routing, card state machine, auth, persistence, GitHub sync) lives
server-side behind a zod-schema-defined protocol so iOS / web / desktop /
Android clients stay thin. The demo relay remains until the iOS client is
migrated. Details: [backend/README.md](backend/README.md).

## Progress

See [PROGRESS.md](PROGRESS.md)
