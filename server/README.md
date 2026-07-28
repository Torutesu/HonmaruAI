# Relay server

Localhost backend for WebSocket card sync and GitHub OAuth token exchange.

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
| GET | `/health` | Health check (`aiRouting`, `aiModel`) |
| GET | `/oauth/github/config` | OAuth client config for iOS |
| POST | `/oauth/github/token` | Exchange code → access token |
| POST | `/ai/route` | Route instruction via OpenRouter |

## WebSocket protocol

| Message | Direction | Payload |
|---------|-----------|---------|
| `join` | client → server | `{ userId, orgId? }` |
| `snapshot` | server → client | `{ cardsByUser }` |
| `card_created` | both | `{ card }` |
| `card_updated` | both | `{ card }` |
| `presence` | server → clients | `{ userId, status }` |
