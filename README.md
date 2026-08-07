# Honmaru AI — TikTok for Work

AI-native decision feed for teams. Humans talk to their AI; agents route Decision Cards across the org in real time.

## App structure

Follows the designer's UX Strategy & Architecture (33-screen IA):

| Area | Screens |
|------|---------|
| Onboarding | 11 — welcome, problem, concept ×2, connect AI (identity), tools intro, GitHub OAuth, Slack, Notion/Gmail/Calendar, AI builds context, ready |
| Core product | Decision feed (Approve / Reject / Revise / Delegate / Later), card detail, AI input, draft review, history |
| AI Assistant | Assistant home, what your AI knows, agent activity |
| Organization | Teams, People, AI Agents, Org graph |
| Integrations | Hub + Slack / GitHub / Notion / Gmail / Calendar detail |
| Settings | Profile, Context, Billing, Security, Language |

GitHub is a live integration (OAuth + Issues). Slack / Notion / Gmail / Calendar are simulated connections in the MVP — the UI is real, the side effects are not.

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

## Progress

See [PROGRESS.md](PROGRESS.md)
