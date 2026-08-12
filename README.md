# TikTok for Work

AI-native decision feed for teams. Humans talk to their own AI; agents route Decision Cards across the org in real time.

**The 3-second value:** open the feed, and the decision you need to make is already there — clear it in one swipe.

Ships as **Honmaru AI** (`com.honmaru.ai`) on TestFlight.

## Stack

| Layer | Tech |
|-------|------|
| iOS | SwiftUI, xcodegen (`project.yml`), ASWebAuthenticationSession, URLSession WebSocket |
| Backend | Cloudflare Workers (`worker/`) — Durable Objects for the relay, D1 for storage, R2 for video |
| AI | OpenAI `gpt-4o-mini`, with a keyword router as the always-available fallback |
| Identity | GitHub OAuth. A repository's collaborators are the org graph |
| Connectors | Gmail, Slack, Notion via [Composio](https://composio.dev), authorized **per user** |
| Billing | RevenueCat, metered server-side (currently off — see below) |

Deployed backend: `https://tiktokforwork.torubj0904.workers.dev`

## Quick start

```bash
xcodegen generate
open TikTokForWork.xcodeproj
```

The app points at the deployed Worker out of the box (`Config/Base.xcconfig`), so there is
nothing to run locally. Sign in with GitHub and pick a repository, or take
**Continue without signing in** for a guest session.

> **Simulator caveat:** the iOS Simulator's `URLSession` stalls on the Worker's HTTP/3
> endpoint (Safari is fine). Sign-in, org loading and AI routing therefore only work on a
> **real device** — use TestFlight for anything end-to-end. The guest path works in the
> simulator because it makes no network calls.

Onboarding is four screens: the pitch, how routing works, a hands-on swipe, and GitHub
sign-in (skippable). Rationale in [onboarding.md](onboarding.md).

### Backend

```bash
cd worker
npm install
npm test        # 106 tests, real workerd via @cloudflare/vitest-pool-workers
npx wrangler dev
```

`worker/README.md` is the important one: it records the **verified** Composio contracts for
Gmail, Slack and Notion — argument and response shapes pinned against the live APIs rather
than inferred from documentation. Read it before touching a connector.

Secrets live only as Worker secrets (`npx wrangler secret put …`), never in the repo:
`OPENAI_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COMPOSIO_API_KEY`,
`REVENUECAT_SECRET_KEY`.

Use `npx -y wrangler@4` for D1 and deploys — the pinned wrangler 3 fails `d1 execute --remote`
with a misleading 7403 "account is not authorized" that is a stale-client bug, not an auth problem.

## Releasing

```bash
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```

Every upload path runs `scripts/smoke-release.sh` first: it builds the **Release**
configuration, launches it on a simulator, and fails if the process dies *or* logs a fatal
error. This exists because a Debug simulator build once passed while the shipped Release
build crashed on launch — the guard that killed it lives behind `#if !DEBUG`, so a Debug
build literally could not contain it. `** BUILD SUCCEEDED **` on Debug proves the least
interesting thing.

## Billing is implemented but switched off

The free tier meters **AI model calls**, server-side, three per day. Over the limit the app
degrades to the keyword router rather than refusing, and the response carries
`quotaExceeded: true`. Pro is unlimited; anyone supplying their own OpenAI key via `x-ai-key`
is never metered.

Nothing is metered until the Worker secret `REVENUECAT_SECRET_KEY` exists — **that secret is
the switch**. The iOS side likewise refuses to configure RevenueCat unless a production
`appl_…` key is present, so billing being unconfigured can never stop the app from starting.
Setup steps: [docs/revenuecat.md](docs/revenuecat.md).

## Architecture

```
┌─────────────┐  wss (AG-UI)   ┌──────────────────────────────┐
│  iOS Client │◄──────────────►│  Cloudflare Worker           │
│  (SwiftUI)  │                │   OrgRelay (Durable Object)  │
└──────┬──────┘     HTTPS      │   D1 · R2                    │
       │ ──────────────────────►│   /ai/route  /connectors/*   │
       │                        └───────────┬──────────────────┘
       │                                    │
       │                     ┌──────────────┼───────────────┐
       │                     ▼              ▼               ▼
       └── GitHub Issues   OpenAI       Composio       RevenueCat
           (client-side)   routing   Gmail/Slack/Notion  entitlements
```

Every card mutation is appended to an audit log (`card_events`) with a full snapshot, so a
rollback preserves the decision it undid. The client↔agent protocol is
[AG-UI](https://github.com/ag-ui-protocol/ag-ui) — see [docs/agui-protocol.md](docs/agui-protocol.md).

## Where things are documented

| Topic | File |
|-------|------|
| Verified Composio / connector contracts | `worker/README.md` |
| Subscriptions, entitlements, the meter | `docs/revenuecat.md` |
| Design system | `docs/design-system.md` |
| Onboarding rationale | `onboarding.md` |
| App Store release process | `docs/app-store-release.md` |
| Every feature's spec and plan | `docs/superpowers/specs/`, `docs/superpowers/plans/` |

Each feature was built spec → plan → implementation. The specs record *why* a design is what
it is, including designs revised after being tested against a live API — the Notion spec is
the clearest example, where "show me rows assigned to me" turned out to be impossible and the
design changed rather than the claim being quietly dropped.

## Legacy

`server/` and `web/` are the pre-Cloudflare Node relay and its browser reference client.
Nothing builds or deploys them; `worker/` replaced them. Kept for reference only.
