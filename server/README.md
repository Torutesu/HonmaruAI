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
| GET | `/health` | Health check (`aiRouting`, `aiModel`, `memberCount`) |
| GET | `/oauth/github/config` | OAuth client config for iOS |
| POST | `/oauth/github/token` | Exchange code → access token |
| GET | `/org/members` | Current organization roster |
| POST | `/org/members` | Add a member (`{ name, role, githubUsername?, managerID? }`) |
| POST | `/ai/route` | Route instruction via OpenRouter |

## Organization roster

The relay owns the roster. It starts with the founding members (`server/members.js`)
and grows as people are added from the app:

| id | name | role |
|----|------|------|
| `user-toru` | Toru | CEO |
| `user-gota` | Gota | PM |

Adding a member broadcasts a `roster` event to every connected client, and the
new member is routable by the AI immediately — the `create_decision_card` tool
schema and the keyword fallback are both built from the live roster per request,
so no code change is needed to onboard someone.

Routing matches the work to a member's **role**, not to specific people:
design work goes to a designer, engineering work to an engineer, product work to
a product role, and budget/hiring/strategy to the CEO or a lead. A person named
in the instruction always wins.

## WebSocket protocol

| Message | Direction | Payload |
|---------|-----------|---------|
| `join` | client → server | `{ userId, orgId? }` |
| `roster` | server → clients | `{ members }` |
| `snapshot` | server → client | `{ cardsByUser }` |
| `member_added` | client → server | `{ member }` |
| `card_created` | both | `{ card }` |
| `card_updated` | both | `{ card }` |
| `card_deleted` | both | `{ cardId, recipientUserID }` |
| `clear_store` | client → server | `{}` (clears cards, keeps the roster) |
| `presence` | server → clients | `{ userId, status }` |
