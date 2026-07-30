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
3. **Relay server** — defaults to `ws://127.0.0.1:8080` for simulators; tap the relay address at the bottom of the sign-in screen to point at a deployed relay (`wss://…`) and set its token. Settings persist in the Keychain.

### 4. Two-simulator demo

1. Start relay server
2. Simulator A → Alice
3. Simulator B → Bob
4. Alice → Message your AI → natural language instruction
5. Bob sees card via WebSocket
6. Bob approves → GitHub Issue created → Alice gets result

## Channels — the AI-native chat behind the feed

The vertical feed is the primary way to work; behind it sits a Slack-like channel space (menu → **Channels**) that is AI-native from the start:

- **"Tell your AI" is the only inbox.** The AI triages everything you say (`/ai/ingest`): a decision becomes a card to review, a status update is filed to the right channel — and a genuinely new topic gets its own channel created behind the scenes
- Humans and **AI agents share the same channels**. Mention `@ai` (or `@ai-alice` for a personal agent) and the agent replies with conversation context
- When the conversation surfaces a real ask, the agent **files a decision card straight from chat** — it goes through the same routing pipeline and lands in the right person's feed, linked back to the conversation
- Every routed decision leaves a trail: the sender's AI posts a log message in the card's home channel
- Channels are meant to be AI-managed: reading them is optional, deciding on cards is the work
- **Digests close the loop**: activity you haven't seen arrives as one quiet AI-summarized card in your feed (`/digest/run` or `DIGEST_INTERVAL_MINUTES`) — skim it, reply, or mark as read. You never owe the scrollback anything

## Decision loop

- **Decide**: approve → GitHub Issue, decline, revise (with a note), or delegate — swipe or tap
- **Reply in your own words**: a reply box on every pending card (`/ai/reply`) — "OK, but release after Friday" approves with the condition recorded on the card and the Issue; "Has auth signed off?" sends a question card back to the sender while the decision stays pending; plain remarks become notes. Questions and notes arrive as lightweight cards with reply + mark-as-read, closing the loop without a chat thread
- **Voice everywhere**: a mic on the composer, card replies, Ask AI, resend, and channel chat — on-device transcription (Speech framework), and the transcript lands in the field for editing before anything is sent. Works on physical devices; simulator dictation support varies
- **Notifications that respect you**: APNs pushes only pending high/urgent decisions, and never while you're connected — chat, notes, and medium/low cards stay silent. Tapping a push opens the exact card (see [server/README.md](server/README.md) for APNs setup)
- **Everyone works in their own language**: set your language in the user switcher — every card is translated at delivery, digests are written in your language, and agents answer in it. A Japanese CEO decides in Japanese on the same card an English engineer sent in English
- **GitHub feeds the queue**: review requests, issue assignments, and CI failures arrive as decision cards automatically via `/github/webhook` — the org's `githubUsername` mapping routes them to the right feed
- **Nothing rots in a queue**: pending cards past their SLA (urgent 2h · high 8h · medium 24h) automatically escalate up the org graph — the recipient's manager gets an actionable copy, translated into their language, pushed if they're offline
- **Your AI learns how you decide**: every decision trains your agent's memory. New cards arrive with a one-tap recommendation when your history shows a clear pattern — "Your AI suggests: Approve · you approved the last 3 review requests from Alice". Advisory only; the human always decides
- **Re-prioritize**: recipients can change a pending card's priority from the detail sheet; the change syncs to every client
- **Ask AI**: a follow-up instruction on any pending card ("make this urgent, deadline moved") updates the card in place via the relay's `/ai/refine`
- **Revise & resend**: a revision request comes back to the sender as an actionable card — edit the instruction, review the AI's redraft, and it routes straight back to whoever asked for changes

## Architecture

```
┌─────────────┐   OAuth code    ┌────────────────────┐
│  iOS Client │───────────────►│ localhost:8080     │
│  (SwiftUI)  │◄──access token─│ GitHub token swap  │
└──────┬──────┘                │ WebSocket relay    │
       │         card events    └────────────────────┘
       └────────────────────────►
       │
       ├── AIService → relay `/ai/route` + `/ai/refine` → OpenRouter
       └── GitHubService → Issues API
```

Client secret stays on the relay server only.

## Deploy & ship

**Relay** — see [server/README.md](server/README.md). The relay persists cards to disk, honors `PORT`, requires a `RELAY_TOKEN` when set, and ships with a Dockerfile — it runs as-is on Fly.io / Render / Railway. Terminate TLS at the platform so the app connects over `wss://`.

**App on a real device / TestFlight**

1. Deploy the relay and note its `wss://` URL and `RELAY_TOKEN`
2. Update the GitHub OAuth app's Homepage URL to the relay's `https://` URL (callback stays `tiktokforwork://oauth/callback`)
3. `xcodegen generate` → open the project → set your team in Signing & Capabilities
4. Archive → distribute via TestFlight (or run directly on device)
5. In the app's sign-in screen, tap the relay address → enter the `wss://` URL + token → Test connection → Save

## Testing

```bash
cd server && npm test   # routing, refine, persistence, auth integration
```

## Progress

See [PROGRESS.md](PROGRESS.md)
