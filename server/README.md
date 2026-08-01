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

Cards, channels, and the organization are persisted to JSON files (debounced writes, flushed on SIGINT/SIGTERM) and reloaded on boot. Defaults are `./data/cards.json`, `./data/channels.json`, and `./data/org.json`; override with `CARDS_STORE_PATH` / `CHANNELS_STORE_PATH` / `ORG_STORE_PATH`. When deploying, mount a volume at `./data` so state survives restarts.

## Organization

The relay owns the org graph (users, teams, agents, manages/memberOf/canApprove edges). It seeds the four-person demo roster so the two-simulator demo needs zero setup, and grows from there: `POST /org/members` adds a member, creates their personal agent and team edges, persists, and broadcasts `org_updated` to all clients. Routing, @-mention parsing, and every AI prompt derive from the live org — a member added at runtime is immediately routable by name, role keywords, and team.

## Auth

Set `RELAY_TOKEN` to require a shared secret:

- HTTP: `Authorization: Bearer <token>` on every endpoint except `/health`
- WebSocket: `token` field in the `join` payload — unauthorized joins are closed

Leave it empty for localhost development. **Always set it before deploying** — without it anyone can read and wipe the card store.

## Language — everyone decides in their own language

Each member has a `language` (set at add-member time or via `POST /org/language`). Cards are authored in the sender's language and **translated at delivery time** into the recipient's language (`translate.js`, OpenRouter tool call — names, numbers, and IDs preserved; same-language pairs skip the hop). Digests are generated directly in the recipient's language, in-channel agents reply in the mention author's language, and the offline reply interpreter understands Japanese decision phrases (承認/却下/〜？/修正). A Japanese CEO reads and decides in Japanese; an English engineer receives that decision in English.

## GitHub webhooks — work flows in by itself

Point a repository webhook (JSON, secret = `GITHUB_WEBHOOK_SECRET`) at `/github/webhook`. Handled events:

- `pull_request` / `review_requested` → **approval card** for the requested reviewer (high)
- `issues` / `assigned` → **task card** for the assignee (medium)
- `workflow_run` failure → **CI card** for the actor (high)

Recipients resolve via each member's `githubUsername`; events for unknown logins are dropped. Cards flow through the normal delivery path — translation, channel trail, and the push policy all apply.

## Decisions resolve on the relay

`POST /cards/decide` owns what used to live only in the iOS client: the status transition, note handling (`Condition:` / `Reason:` / `Revision:`), the response card back to the sender (actionable when it's a revision request), delegation fan-out, decision-memory recording, and GitHub issue create/update when the caller's session has a token. Every client gets identical behavior instead of re-implementing it, and the result rides the normal delivery pipeline (translation, provenance, quiet push). Deciding an already-decided card returns `409`; a card belonging to another user returns `404`.

**iOS goes through this endpoint too** (`RelayDecisionClient`), so there is one implementation of the decision rules rather than one per client. Two deliberate exceptions:

- **GitHub stays on the client for iOS.** The relay syncs issues only for callers whose *session* carries a GitHub token; iOS authenticates with the relay token and holds the user's OAuth token itself, so it files the issue after the decision lands and publishes the link as a `card_updated`.
- **No relay, no relay decisions.** The app runs as a local demo when the socket won't open (`AppState` seeds the feed). In that mode a decision flips the status and keeps the note — nothing is broadcast, no response card is invented. It is a degraded mode, not a second copy of these rules.

Since the iOS app can't be compiled in this repo's CI (no Xcode, and SwiftUI doesn't exist off Apple platforms), `test/swiftContract.test.js` covers the part a compiler would have: it parses the Swift models and asserts that every field, status, card type and decision action the relay can emit has somewhere to land. A field Swift doesn't declare is silently dropped; a non-optional Swift field the relay omits fails decoding and the card never appears — both are runtime-only bugs on a device.

## Provenance — one tap from summary to source

Every delivered card carries a `sources` array (provenance.js): the **channel conversation** it came from (with the triggering message ID when the card was filed from chat), and **documents referenced in the original ask** — URLs in the instruction are auto-extracted and labeled (Notion, Google Docs, Figma, Linear, Jira, GitHub PR/Issue numbers, or the hostname). A webhook card's GitHub URL is its origin and is included; a *created* Issue link is the card's output and stays separate. The app renders these as tappable chips: links open in the browser, channel sources open the conversation scrolled to the exact message.

### Notion, connected (`NOTION_TOKEN`)

With an integration token the relay stops merely recognising Notion URLs and starts reading the workspace (notion.js), during the same delivery pipeline:

- **A linked page becomes its title.** `sources` gains `kind: "doc"` and the chip reads *"Onboarding rewrite spec"* instead of *"Notion"*. A page the integration can't see degrades to the plain link rather than disappearing.
- **A card that links nothing gets its page found.** The decision's own words — minus the boilerplate every card contains ("approve", "needs", "review") — become a workspace search, and a hit is attached only if its title covers ≥⅓ of that query. A vague match is worse than no source: it teaches people to distrust the chip. An explicitly linked page suppresses the search entirely; the human already said which page matters.
- **`GET /sources/notion?url=…`** returns the title and a text excerpt so a client can render the document *next to* the decision. The token never leaves the relay, exactly like the GitHub token.

Everything is best-effort by construction: unset, rate-limited, unreachable or slow (4s timeout), the card ships with the provenance it already had. `/health` reports `notion: true|false` so a client knows before it asks. Notion grants access per page — share the pages you want reachable with the integration.

**Verified against a fixture workspace, not a live one**: the E2E suite points the relay's real HTTP client at a stand-in Notion API (`NOTION_API_BASE`), so the wire format, the resolution logic and the in-app preview are all exercised; only Notion's servers are swapped out.

## Agent memory — your AI learns how you decide

Every pending→decided transition (approve / reject / revise) is recorded per user (`data/memory.json`, last 50). When a new decidable card is delivered to someone with ≥3 relevant data points, their AI predicts the call (`recommend_decision` tool; offline, a ≥75%-consistency pattern heuristic over same-sender/same-type history) and attaches a one-tap recommendation — "Your AI suggests: Approve · You approved the last 3 review requests from Alice", written in the recipient's language. Advisory only: no clear pattern, no recommendation, and the human always decides.

## Autopilot — the recommendation engine allowed to act

The recommendation engine already predicts how someone decides. Autopilot lets it act, under conditions strict enough that acting is defensible. The design is mostly about what it refuses to do:

- **Opt-in per person** (`POST /org/autopilot`), stored on the org member because it is a delegation of authority, not a workspace setting. Off for everyone until they turn it on.
- **Never immediately.** A hold window (default 2h, minimum 15m — zero is refused) means the human always gets first refusal; autopilot only handles what they left sitting.
- **Never urgent.** If it genuinely can't wait, it needs a person. A stored `maxPriority: "urgent"` is clamped to `high`.
- **Approve only, by default.** Auto-approving is recoverable and visible; silently declining someone's request is not, so it takes a second opt-in. Anything else (`delegate`, `revise`) is dropped from the action list entirely.
- **Never a revision request**, never your own card, never twice — the card records `autopilotAt`.
- **Never invisibly.** The card carries `decidedByAI`, the context says *"Approved by your AI after 3h · <the pattern it saw>"*, and the sender's notification carries the same mark.

The sweep runs every `AUTOPILOT_INTERVAL_MINUTES` (default 10; `POST /autopilot/run` on demand) and resolves through the same `applyDecision` as every other client, so an autopilot approval is not a special kind of decision.

**One deliberate omission**: an autopilot decision is *not* written to decision memory. A system that learns from its own predictions only ever confirms itself — the pattern that justified acting has to keep being earned from human decisions. `GET /memory?userId=…` exposes that history, and the integration test asserts autopilot's own decisions never appear in it.

## Decision ledger — the store read as history

`GET /ledger` turns the card store into a searchable record: who asked, who decided, how long it took, and where work is waiting. `applyDecision` stamps `decidedAt` and `decidedByUserID` on every decision, because lead time is unknowable after the fact.

- **Filters**: `userId` (involved as recipient, sender *or* decider — asking "what happened with Bob" and getting only what was addressed to him would hide half the story), `status` (`pending` / `decided` / a specific status), `q` full-text over title/summary/context/instruction, `since`, `limit`.
- **Lead time as median and p90**, never a mean: one card that sat over a holiday weekend would otherwise define the whole picture. A pending card reports `null`, not `0` — it hasn't taken any time yet, and zero would claim it was instant.
- **Bottlenecks** rank each person's queue by how long its *oldest* item has waited, not by size. A long queue that moves is fine; one card stuck for three days is not. Scoped to a single person the view is empty, because "where does work wait" means nothing filtered to one queue.
- Also counts what autopilot decided and what had to be escalated — the two signals that a queue is not being handled by the person it belongs to.

## SLA escalation — stuck decisions climb the org graph

Pending cards have an SLA by priority (urgent 2h · high 8h · medium 24h; low never — override with `SLA_MINUTES="urgent:60,high:240"`). A sweep (every `ESCALATION_INTERVAL_MINUTES`, default 15; `POST /escalations/run` on demand) finds breaches, follows the recipient's `manages` edge, and delivers the manager an actionable **"Escalated:"** copy of the stuck decision — urgent stays urgent, everything else arrives high, so offline managers get pushed. The original card is annotated (`escalated: Dana notified after 9h`) and marked so it never escalates twice. Escalations ride the normal delivery path: translated into the manager's language, logged to the card's channel.

## Push notifications

Set `APNS_KEY_ID`, `APNS_TEAM_ID`, and the p8 key (`APNS_KEY_P8` inline or `APNS_KEY_PATH`) to enable APNs (token-based auth over HTTP/2, zero dependencies; `APNS_ENV=sandbox|production`). The policy is deliberate: **only pending high/urgent decision cards ring**, and never for a user who is currently connected — their feed already shows the card. Question/note/medium cards stay silent. Device tokens are registered via `/push/register` (a token follows the active user when the demo switches users) and pruned automatically on APNs `410 Unregistered`. Without keys the relay runs with push off.

## Digest cards

FYI traffic reaches the feed without notifications: per user, the relay collects channel messages they haven't seen (and didn't write), summarizes them (OpenRouter `write_digest` tool, count-based fallback offline), and delivers a single low-priority "Team digest" card — reply or mark as read. Set `DIGEST_INTERVAL_MINUTES` for periodic runs (0 = off, default) or trigger with `POST /digest/run`; last-run timestamps persist in `data/digest.json` so re-runs only cover new activity.

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
| GET | `/health` | Health check (`aiRouting`, `aiModel`, `authRequired`, `push: {apns, web}`, `notion`) |
| GET | `/org` | Organization snapshot: users, nodes, edges |
| POST | `/org/members` | Add a member (name, role, team, githubUsername) — broadcasts `org_updated` |
| POST | `/push/register` | Register an APNs device token for a user |
| POST | `/digest/run` | Generate digest cards now (also runs on `DIGEST_INTERVAL_MINUTES`) |
| POST | `/org/language` | Set a member's language — future cards arrive translated |
| POST | `/github/webhook` | GitHub events → decision cards (HMAC-verified, no bearer token) |
| POST | `/escalations/run` | Sweep for SLA breaches now (also runs on `ESCALATION_INTERVAL_MINUTES`) |
| POST | `/autopilot/run` | Decide the cards autopilot is cleared to decide now (also runs on `AUTOPILOT_INTERVAL_MINUTES`) |
| POST | `/org/autopilot` | Grant/revoke a member's autopilot — echoes the *clamped* settings, not the request |
| GET | `/memory[?userId=…]` | The decision history a person's AI learns from (human decisions only) |
| GET | `/ledger[?userId=&status=&q=&since=&limit=]` | The decision ledger: history, lead-time stats, bottlenecks |
| POST | `/cards/decide` | Resolve a decision: approve / reject / revise / acknowledge / delegate / priority |
| GET | `/auth/github/start` → `/auth/github/callback` | Browser OAuth (server-side `state`), sets the session cookie |
| GET/POST | `/auth/me`, `/auth/session`, `/auth/signout` | Session identity, org-member selection, sign out |
| GET/POST/PATCH | `/github/repos`, `/github/repo`, `/github/issues[/:n]` | GitHub proxy using the session's token |
| GET | `/sources/notion?url=…` | Read a linked Notion page (title + excerpt) — the token never leaves the relay |
| GET | `/auth/dev?user=…` | Sign in as an org member with no credentials — **404 unless `DEV_AUTH=true`, and never in production** |

## Web client (same-origin hosting)

The relay serves the built web app (`WEB_DIST_PATH`, SPA fallback) so the app and API share an origin. That single decision removes CORS entirely, makes the OAuth redirect a real URL the relay owns, and keeps the **GitHub token server-side** — the browser only carries an `httpOnly; Secure; SameSite=Lax` session cookie and never sees a token.

- **Auth**: `/auth/github/start` issues a single-use, server-side `state` and redirects to GitHub; the callback verifies it, exchanges the code, matches an org member by `githubUsername` (falling back to the member picker), and creates a session. PKCE is deliberately omitted: it protects *public* clients, while the relay is a confidential client holding the client secret, and GitHub OAuth Apps don't support it.
- **Authorization**: API routes accept either the relay token (native clients) or a valid session cookie (web). Static assets are public — a browser must load the app before it has credentials.
- **Dev sign-in**: no CI can complete a GitHub OAuth round trip, so `DEV_AUTH=true` exposes `/auth/dev?user=user-bob`, which binds a session to an org member directly. It is off by default, refuses to work when `NODE_ENV=production`, returns 404 rather than 403 (nothing to probe for), and logs a warning at boot when it is on. The browser E2E suite is its only intended user.
- **Push**: `/push/register` takes `{platform:"web", subscription}` alongside APNs device tokens; **the quiet policy is shared** — only pending high/urgent decisions, never to a connected user.
| GET | `/oauth/github/config` | OAuth client config for iOS |
| POST | `/oauth/github/token` | Exchange code → access token |
| POST | `/ai/route` | Route instruction via OpenRouter |
| POST | `/ai/ingest` | Triage input: decision → routing, update → filed to a channel (auto-creates channels for new topics) |
| POST | `/ai/refine` | Apply a follow-up instruction to an existing card |
| POST | `/ai/reply` | Interpret a recipient's freeform reply: approve / reject / revise / question / comment + extracted note |

## WebSocket protocol

| Message | Direction | Payload |
|---------|-----------|---------|
| `join` | client → server | `{ userId, orgId?, token? }` |
| `snapshot` | server → client | `{ cardsByUser }` |
| `channel_snapshot` | server → client | `{ channels, messagesByChannel }` |
| `card_created` | both | `{ card }` |
| `card_updated` | both | `{ card }` |
| `channel_message` | both | client: `{ channelID, text }` · server: `{ message }` |
| `channel_create` | client → server | `{ name, purpose? }` |
| `channel_created` | server → clients | `{ channel }` |
| `presence` | server → clients | `{ userId, status }` |

## Agents in channels

Mention `@ai` in any channel message and the team AI replies with conversation context; `@ai-alice` addresses Alice's personal agent. When the conversation contains a clear ask, the agent calls its `file_decision` tool and the instruction goes through the normal routing pipeline — the decision card lands in the recipient's feed, and the agent's chat message links to it. Without `OPENROUTER_API_KEY`, the agent runs in offline mode: `@ai file: <instruction>` still routes a card via the local keyword router.
