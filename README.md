# Honmaru AI

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
3. Callback URL: `honmaruai://oauth/callback`
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
open HonmaruAI.xcodeproj
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

## Release

TestFlight builds and App Store review submissions run from the terminal via the
[`asc`](https://github.com/rorkai/App-Store-Connect-CLI) CLI — no browser.

Step-by-step guide in Japanese, written for non-engineers:
**[docs/setup-ja.md](docs/setup-ja.md)** ← start here if this is your first release.

```bash
brew install asc xcodegen
scripts/setup.sh               # asks for team id, key id, issuer id, .p8 path
scripts/release.sh login
scripts/release.sh doctor      # auth + signing + review readiness

scripts/release.sh build 1.0.0 && scripts/release.sh testflight   # beta
scripts/release.sh all 1.0.0                                      # submit for review
```

Add `--dry-run` to print the pipeline without executing it. Full setup and
troubleshooting: [docs/app-store-release.md](docs/app-store-release.md)

## Progress

See [PROGRESS.md](PROGRESS.md)
