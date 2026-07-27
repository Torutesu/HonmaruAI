# Relay server

Localhost backend for WebSocket card sync and GitHub OAuth token exchange.

## Run

```bash
cp .env.example .env
# Fill in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
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

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| GET | `/oauth/github/config` | OAuth client config for iOS |
| POST | `/oauth/github/token` | Exchange code → access token |

## WebSocket protocol

| Message | Direction | Payload |
|---------|-----------|---------|
| `join` | client → server | `{ userId, orgId? }` |
| `snapshot` | server → client | `{ cardsByUser }` |
| `card_created` | both | `{ card }` |
| `card_updated` | both | `{ card }` |
| `presence` | server → clients | `{ userId, status }` |
