# TikTok for Work

**An AI-native work OS in the shape of a decision feed.** Humans only talk to their own AI. The AI triages everything — decisions become swipeable cards routed to the right person, updates flow into AI-managed channels — and every outcome lands in GitHub. No channels to manage, no scrollback to owe, no notification firehose.

> 📱 Interactive demo (HTML mock of the app): available as a Claude artifact — feed, routing, translation, webhooks, escalation, and AI recommendations, all clickable in the browser.

## Product overview

Slack assumes humans read channels. This product assumes they shouldn't have to:

1. **You talk to your AI** (text or voice, in your language). It decides: is this a decision for someone, or an update to file?
2. **Decisions become cards** in the right person's vertical feed — routed by the org graph, translated into *their* language, annotated with how they usually decide similar requests.
3. **They swipe** (approve → GitHub Issue / decline), or reply in freeform words — "OK, but release after Friday" is a conditional approval; "Has auth signed off?" bounces back as a question while the decision stays pending.
4. **Everything else stays quiet**: updates live in AI-managed channels where agents are members, unread activity arrives as one digest card, stuck decisions escalate to managers automatically, and only urgent/high pending decisions ever push.

## Technologies used

| Layer | Tech |
|-------|------|
| iOS | Swift / SwiftUI (iOS 17), URLSession WebSocket, ASWebAuthenticationSession, Speech framework, UserNotifications, Keychain |
| Backend | Node.js 22 relay (`server/`) — zero runtime dependencies except `ws`; Dockerfile included |
| AI | OpenRouter free tier (`inclusionai/ling-3.0-flash:free`) via tool calling — routing, triage, reply interpretation, translation, digests, recommendations. Deterministic keyword fallbacks for every AI path |
| GitHub | OAuth (secret stays server-side), Issues API (create/update/two-way state sync), inbound webhooks (HMAC-verified) |
| Push | APNs over HTTP/2 with p8 token auth — implemented with `node:crypto` + `node:http2`, no SDK |
| Project | XcodeGen, `node --test` (78 server tests incl. WebSocket integration) |

## Setup instructions

### 1. GitHub OAuth app

[GitHub → Developer settings → OAuth Apps](https://github.com/settings/developers) → New OAuth App
Homepage `http://localhost:8080` · Callback `tiktokforwork://oauth/callback` → copy Client ID/Secret.

### 2. Relay server

```bash
cd server
cp .env.example .env    # paste GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / OPENROUTER_API_KEY
npm install
npm start               # http+ws on 127.0.0.1:8080
npm test                # 78 tests
```

Everything degrades gracefully: no OpenRouter key → keyword routing; no APNs key → push off; no webhook secret → dev-open endpoint.

### 3. iOS app

```bash
xcodegen generate
open TikTokForWork.xcodeproj
```

Sign in with GitHub → pick a repository → Continue. The relay defaults to `ws://127.0.0.1:8080` (simulator); tap the relay address on the sign-in screen to point at a deployed relay (`wss://…` + token, stored in Keychain, with a connection test).

### 4. Two-simulator demo

Simulator A = Alice, Simulator B = Bob (user switcher, top left). Alice: *"Ask Bob to fix the login bug before Friday"* → Bob's feed gets the card in real time → Bob swipes right → GitHub Issue → Alice gets the result card. Say something that isn't an ask — *"relay migration went well today"* — and it files into a channel instead.

## Key features

**The feed — one card, one decision**
- Vertical full-screen cards: type, priority, sender, agent route, and *why you* (routing reason) on every card
- Swipe right = approve (→ GitHub Issue, updated on later state changes, closed issues sync back), left = decline; buttons for revise (with note), delegate, priority change, Ask AI (`/ai/refine` updates the card in place)
- **Freeform replies** (`/ai/reply`): conditional approvals with the condition recorded on the card and the Issue, rejections with reasons, questions that go back as cards while the decision stays pending, notes. Works in Japanese too — 「承認。ただし金曜以降で」
- **Revise & resend loop**: a revision request returns as an actionable card; the redraft routes straight back to whoever asked
- **AI recommendations**: your agent learns from every decision you make and attaches a one-tap suggestion when your history shows a clear pattern. Advisory only
- **One tap to the source**: every card carries provenance chips — the channel conversation it came from (opens scrolled to the exact message) and any documents referenced in the ask (Notion, Google Docs, Figma, GitHub PR/Issue links, auto-extracted and labeled). The summary is the decision surface; the source is one tap away

**Channels — the AI-native chat behind the feed**
- "Tell your AI" is the only inbox: `/ai/ingest` triages input — decisions become cards, updates are filed to the best channel, genuinely new topics get channels auto-created
- Humans and **agents share the channels**: mention `@ai` (or `@ai-alice`) and the agent replies with conversation context — and **files decision cards straight from chat** when a real ask surfaces
- Every routed decision leaves a log message in its home channel; unread activity arrives as **one quiet digest card** (`/digest/run`)

**The org is data, not vibes**
- The relay owns the org graph (people, teams, personal agents, manages/canApprove edges) — members added at runtime are instantly routable by name, role, and team; GitHub sign-in auto-matches a member
- **SLA escalation**: pending cards past their SLA (urgent 2h · high 8h · medium 24h) climb the manages edge — the manager gets an actionable copy
- **Per-user language**: every card is translated at delivery into the recipient's language; digests, agent replies, and recommendations are generated in it. A Japanese CEO decides in Japanese on the card an English engineer sent in English

**Inputs and outputs**
- **Voice everywhere**: on-device transcription (Speech framework) on the composer, replies, Ask AI, resend, and chat — transcript is editable before sending
- **GitHub webhooks** (`/github/webhook`, HMAC): review requests, issue assignments, and CI failures arrive as cards automatically
- **Quiet push**: APNs only for pending high/urgent decisions, never while you're connected; tapping opens the exact card

## System architecture

```
            speech ──┐                                ┌── GitHub OAuth (token swap)
 ┌────────────────┐  ▼   WebSocket (cards/channels/org/presence)  ┌──────────────────────┐
 │  iOS (SwiftUI) │◄────────────────────────────────────────────►│  Relay (Node.js)     │
 │  feed·channels │      HTTPS /ai/* /org/* /push /digest        │  deliverCard():      │
 │  org·settings  │─────────────────────────────────────────────►│   translate → store  │
 └───────┬────────┘                                              │   → broadcast → log  │
         │ Issues API (user's OAuth token)                       │   → recommend → push │
         ▼                                                       │  JSON persistence    │
 ┌────────────────┐        webhooks (HMAC)                       │  org graph · memory  │
 │     GitHub     │────────────────────────────────────────────► │  SLA sweep · digest  │
 └────────────────┘                                              └──────────┬───────────┘
                                                                            │ tool calling
                                                                            ▼
                                                                   OpenRouter (free tier)
```

- All state (cards, channels, org, memory, push tokens) lives on the relay, persisted to JSON with debounced writes; clients get snapshots on join and deltas over WebSocket.
- Every card creation path converges on one `deliverCard()` pipeline: **translate → persist → broadcast → channel log → recommend → push-if-warranted**.
- All AI calls are relay-side tool calls with strict schemas and validated outputs; the OpenRouter key and GitHub client secret never ship in the app.

## Implemented scope (real, working)

- Full core flow: instruction → AI routing → cross-client card delivery → decision → result back to sender → GitHub Issue (create/update/two-way close sync)
- GitHub OAuth + repository picker; session persistence in Keychain
- Real-time multi-user over an authenticated WebSocket relay (token auth, reconnection, presence, snapshots)
- Channels with participating agents, universal triage, auto-created channels, digests
- Freeform reply interpretation, revise/resend loop, delegation, priority editing, Ask-AI refinement
- Live org graph with member add, dynamic routing, GitHub identity mapping
- Delivery-time translation, per-user languages (JA offline fallbacks included)
- SLA escalation, decision memory + recommendations, GitHub webhook inflow
- APNs push (implementation + tests), voice input, deployable relay (Docker, persistence, auth)
- 78 server tests including end-to-end WebSocket integration suites

## Simplified / mocked scope

- **AI quality** rides a free-tier model; every AI feature has a deterministic keyword fallback (English + basic Japanese) that keeps the product functional offline — but fallback routing/triage is heuristic, not smart
- **GitHub sync targets Issues only** (assignment allows any one of Issues/PRs/Discussions/Projects); webhooks are one repo → one org
- **Single organization** per relay (`core-team`); org edit UI covers add-member + language (no delete/re-org UI)
- **JSON-file persistence** (fine for a team; SQLite is the obvious next step at scale)
- **Push delivery untested against live APNs** (needs an Apple Developer p8 key — the JWT/HTTP2 implementation is unit-tested, including signature verification)
- **Demo identities**: users are org members, not authenticated accounts — anyone on the relay can act as anyone (auth = relay token). Fine for the demo org model, not for production
- The HTML demo simulates the relay in-browser; simulator dictation depends on the host

## Ingenious points / efforts made

1. **The notification policy is the product thesis, executable.** Only pending high/urgent decisions push, never to connected users, chat never rings, FYI arrives as one digest card. "Slack's notification problem" isn't solved by settings — it's solved by architecture.
2. **One delivery pipeline.** Translation, channel trails, recommendations, and push all hang off a single `deliverCard()`; every new inflow (webhooks, escalations, digests) inherited the full feature set for free.
3. **Human-in-the-loop AI, everywhere.** The AI drafts, routes, interprets, recommends — but every consequential step (send, decide, accept recommendation) is a human tap. Freeform replies are interpreted into structured decisions instead of being forwarded raw, preserving "humans only talk to their AI" even mid-conversation.
4. **Graceful degradation as a discipline.** No AI key, no APNs key, no webhook secret, no network — every feature has a defined fallback, which also made the whole system testable (78 tests run with zero external services).
5. **Language as a first-class org property**, not a UI locale: translation happens at delivery per recipient, so one card exists in each reader's language — including recommendations and escalations.
6. **AI-assisted development**: built in ~3 days of sessions with Claude (planning → implementation → tests → docs per feature), with WebSocket integration tests hardened against real race conditions found along the way.

## Areas for future improvement

- Live APNs + TestFlight distribution (needs Apple Developer credentials; relay deploy is `docker build` away)
- Real accounts: GitHub identity → org member binding with per-user auth on the relay
- Autopilot: recommendations already predict decisions — graduate high-confidence, low-risk cards to AI pre-approval with human review in the digest
- Decision ledger: search/timeline over the decision history (data already persisted), lead-time metrics, bottleneck visibility
- PRs/Discussions/Projects as sync targets; multi-repo and multi-org
- SQLite persistence, agent proactivity (unprompted context from past decisions), calendar/email inflow

## More

- Relay internals, endpoints, and every env var: [server/README.md](server/README.md)
- Feature-by-feature progress log: [PROGRESS.md](PROGRESS.md)
- Design system: [design.md](design.md)
