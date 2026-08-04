# TikTok for Work

AI-native decision feed for teams. Humans talk to their AI; agents route Decision Cards across the org in real time.

**The 3-second value:** open the feed, and the decision you need to make is already there — clear it in one swipe. A five-screen guided onboarding gets you there: the pitch, how AI routing works, an interactive swipe tutorial, GitHub sign-in (skippable — the feed re-offers it after your first approval), and persona selection. Design rationale in [onboarding.md](onboarding.md).

## Stack

| Layer | Tech |
|-------|------|
| iOS | SwiftUI, ASWebAuthenticationSession, URLSession WebSocket |
| Backend | Node.js localhost relay (`server/`) |
| AI | OpenRouter `inclusionai/ling-3.0-flash:free` via relay server |
| GitHub | OAuth via localhost + Issues API |

## Quick start

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
- Web client (AG-UI reference): open `http://127.0.0.1:8080/` in a browser
- Agent↔client protocol: [AG-UI](https://github.com/ag-ui-protocol/ag-ui) — see `docs/agui-protocol.md`

### 3. Run iOS app

```bash
xcodegen generate
open TikTokForWork.xcodeproj
```

First run (guided onboarding, 5 screens):

1. **Welcome** — the pitch: decisions, not messages
2. **How it works** — the You → Your AI → Dana's AI → Dana routing chain
3. **Try it** — swipe a real Decision Card to continue (learn the gesture by doing)
4. **Sign in with GitHub** — OAuth browser sheet → pick repository. Skippable; the feed offers the connection again right after your first approval, and from `Local mode · Connect GitHub` or the account menu.
5. **Who are you?** — pick a persona (Alice recommended) → your AI's triaged Decision Cards stream into the feed

The relay server (`ws://127.0.0.1:8080`) is optional for a single simulator: without it the app runs fully local. It is required for the two-simulator realtime demo and for GitHub OAuth + AI routing (`OPENROUTER_API_KEY`).

### 4. Two-simulator demo

1. Start relay server
2. Simulator A → Continue as Alice (seeded cards publish to the relay)
3. Simulator B → Continue as Bob (same store via WebSocket)
4. Alice → Message your AI → natural language instruction
5. Bob sees card via WebSocket
6. Bob approves → GitHub Issue created (if connected) → Alice gets result

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

## Progress

See [PROGRESS.md](PROGRESS.md)
