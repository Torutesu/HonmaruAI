# TikTok for Work

AI-native decision feed for teams. Humans talk to their AI; agents route Decision Cards across the org in real time.

## Stack

| Layer | Tech |
|-------|------|
| iOS | SwiftUI, ASWebAuthenticationSession, URLSession WebSocket |
| Payments | RevenueCat (`purchases-ios-spm`), hosted paywall + Customer Center |
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

## Subscriptions

`honmaruai Pro` is sold through RevenueCat. The Swift package is already declared in
`project.yml` and the Xcode project, so `xcodegen generate` is all that's needed — Xcode
resolves `purchases-ios-spm` on first open.

| | |
|---|---|
| Entitlement | `honmaruai Pro` |
| Products | `yearly`, `monthly` (offering `default`) |
| Free tier | 3 AI routes/day, org graph locked |
| Pro | unlimited routing, org graph, priority delivery |

The committed API key is a **Test Store** key, so purchases work on the simulator with no
App Store Connect setup. Entry points: **⋯ → Upgrade to Pro / Manage subscription** in the
feed, the paywall when the daily routing allowance runs out, and the Pro-gated org graph.

Full setup, dashboard configuration, and testing notes: [docs/revenuecat.md](docs/revenuecat.md)

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
