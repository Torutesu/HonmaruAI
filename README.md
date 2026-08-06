# TikTok for Work

AI-native decision feed for teams. Humans talk to their AI; agents route Decision Cards across the org in real time.

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
3. Pick **who you are** in the organization — or add yourself with **Add member**

### 4. Organization

The relay owns the roster and starts with the founding members:

| Member | Role |
|--------|------|
| Toru | CEO |
| Gota | PM |

Add teammates from **Organization → Add member** (or the user menu). Each member
gets their own AI agent, appears on every connected client instantly, and becomes
routable by the AI right away — routing matches work to **roles**, so no code
change is needed to onboard someone.

### 5. Two-device run

1. Start relay server
2. Device A → sign in → continue as Toru
3. Device B → sign in → continue as Gota
4. Toru → Tell your AI → natural language instruction
5. Gota sees the decision card via WebSocket
6. Gota approves → GitHub Issue created → Toru gets the result

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

## Docs

| Doc | Contents |
|-----|----------|
| [PROGRESS.md](PROGRESS.md) | Implementation checklist |
| [docs/DESIGN_HANDOFF.en.md](docs/DESIGN_HANDOFF.en.md) | Designer handoff — product overview, screen inventory, what's built so far, and the open design decisions. **The UI is at mockup stage; the design system is still to be defined.** |
| [docs/DESIGN_HANDOFF.ja.md](docs/DESIGN_HANDOFF.ja.md) | デザイナー向け引き継ぎドキュメント（日本語版） |
| [design.md](design.md) | Early design notes (drifted from the code — see handoff docs) |
| [server/README.md](server/README.md) | Relay server, OAuth, WebSocket protocol |
