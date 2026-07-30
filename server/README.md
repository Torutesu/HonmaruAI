# Relay server

Backend for WebSocket card sync, AI routing, and GitHub OAuth token exchange. Runs on localhost for development and deploys anywhere Node 22 runs (Docker image included).

## Run

```bash
cp .env.example .env
# Fill in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
# Fill in OPENROUTER_API_KEY (see .env.example)
npm install
npm start
```

- HTTP: `http://127.0.0.1:8080`
- WebSocket: `ws://127.0.0.1:8080`

## Test

```bash
npm test
```

Runs unit tests (routing, refine, persistence) plus an integration test that boots the relay with auth enabled and exercises HTTP + WebSocket.

## Persistence

Cards are persisted to a JSON file (debounced writes, flushed on SIGINT/SIGTERM) and reloaded on boot. Default path is `./data/cards.json`; override with `CARDS_STORE_PATH`. When deploying, mount a volume there so cards survive restarts.

## Auth

Set `RELAY_TOKEN` to require a shared secret:

- HTTP: `Authorization: Bearer <token>` on every endpoint except `/health`
- WebSocket: `token` field in the `join` payload — unauthorized joins are closed

Leave it empty for localhost development. **Always set it before deploying** — without it anyone can read and wipe the card store.

## Deploy

```bash
docker build -t tiktokforwork-relay .
docker run -p 8080:8080 -v relay-data:/app/data \
  -e RELAY_TOKEN=... -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... \
  -e OPENROUTER_API_KEY=... tiktokforwork-relay
```

Works as-is on Fly.io / Render / Railway (they set `PORT`; the server honors it). Terminate TLS at the platform so clients connect via `wss://` — then point the iOS app at `wss://your-relay.example.com` in the auth screen's relay settings.

## GitHub OAuth app setup

1. Go to [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers)
2. **New OAuth App**
   - Application name: `TikTok for Work (local)`
   - Homepage URL: `http://localhost:8080`
   - Authorization callback URL: `tiktokforwork://oauth/callback`
3. Copy **Client ID** and generate **Client secret**
4. Paste both into `server/.env`

The iOS app opens GitHub in a secure browser sheet. The authorization code returns to the app via the `tiktokforwork://` URL scheme. The localhost server exchanges the code for an access token so the client secret never ships in the app.

## OpenRouter setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Add to `server/.env`:

```env
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=inclusionai/ling-3.0-flash:free
```

The iOS app calls `POST /ai/route` on the relay server. The OpenRouter key stays on the server only.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (`aiRouting`, `aiModel`, `authRequired`) |
| GET | `/oauth/github/config` | OAuth client config for iOS |
| POST | `/oauth/github/token` | Exchange code → access token |
| POST | `/ai/route` | Route instruction via OpenRouter |
| POST | `/ai/refine` | Apply a follow-up instruction to an existing card |

## WebSocket protocol

| Message | Direction | Payload |
|---------|-----------|---------|
| `join` | client → server | `{ userId, orgId?, token? }` |
| `snapshot` | server → client | `{ cardsByUser }` |
| `card_created` | both | `{ card }` |
| `card_updated` | both | `{ card }` |
| `presence` | server → clients | `{ userId, status }` |
