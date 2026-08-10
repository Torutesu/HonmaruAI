# Subscriptions and the AI Usage Gate — Design

Date: 2026-08-10
Status: Approved design, pre-implementation

## Goal

Sell `honmaruai Pro` through RevenueCat, and make the free tier meaningful by
metering the one thing that actually costs money: **AI routing and triage**.

## What already exists, and what has to change

An earlier branch (`claude/honmaruai-revenuecat-sdk-1hdfr4`) has ~1350 lines of
working RevenueCat integration, written before the Phase 1–6 rebuild:

| file | verdict |
|---|---|
| `App/RevenueCatConfig.swift` | reuse — identifiers, entitlement `honmaruai Pro`, products `monthly`/`yearly`, offering `default`, `freeDailyRoutes = 3` |
| `Services/SubscriptionService.swift` | reuse, adapted to the current `AppState` |
| `Features/Subscription/ProPaywallSheet.swift`, `SubscriptionView.swift` | reuse — the paywall is RevenueCat-hosted (Paywalls v2), so there is little custom UI to maintain |
| `docs/revenuecat.md` | reuse — the SPM setup and dashboard steps still apply |
| `Services/RoutingQuota.swift` | **do not reuse** — see below |
| edits to `AppState`/`FeedView`/`RootView`/`OrgGraphView` | do not merge — those files were rewritten |

### Why the quota moves to the server

`RoutingQuota` counts in `UserDefaults`, and its own comment says why that was
acceptable then:

> *Counts live in UserDefaults on purpose: this is a soft product limit, not a
> security boundary. Anything worth protecting belongs behind the server.*

That was true when routing ran against a relay the user controlled. It is not
true now: **the AI call happens on the Worker and we pay for it.** A counter the
user can reset by deleting the app is not a limit on our bill. The meter belongs
where the cost is incurred.

## The gate

RevenueCat's `app_user_id` is the **numeric GitHub id** — the same identity
`sessions`, `memberships` and `connector_config` already use. No new identifier,
and the Worker can ask RevenueCat about the caller directly.

`POST /ai/route` and the connector triage both pass through one decision:

| condition | behaviour |
|---|---|
| request carries `x-ai-key` | **not metered** — they are paying OpenAI directly |
| entitlement `honmaruai Pro` active | unmetered |
| free, under 3 calls today | normal AI routing |
| **free, over the limit** | **fall back to the keyword router** |

The last row is the important one. The keyword router already exists, is tested,
and produces a usable card. So hitting the limit **degrades the app rather than
breaking it** — the response carries `routedBy: "fallback"` and a
`quotaExceeded: true` flag the app surfaces as "You've used today's AI routing —
upgrade for more." Refusing the request outright would punish the user for our
pricing.

### Counting

A new D1 table, one row per user per day:

```sql
CREATE TABLE IF NOT EXISTS ai_usage (
  user_github_id TEXT NOT NULL,
  day            TEXT NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_github_id, day)
);
```

Incremented only when an AI call is actually made on our key. Daily rather than
monthly because a daily cap contains a runaway loop within a day.

### Entitlement lookup

The Worker asks RevenueCat `GET /v1/subscribers/{app_user_id}` with the **secret**
API key and caches the answer in D1 for an hour:

```sql
CREATE TABLE IF NOT EXISTS entitlements (
  user_github_id TEXT PRIMARY KEY,
  is_pro         INTEGER NOT NULL,
  checked_at     TEXT NOT NULL
);
```

Chosen over webhooks because there is no endpoint to secure and no missed-event
risk; the cost is one HTTP call per user per hour.

**If RevenueCat is unreachable, the user is treated as free** — never as blocked.
A billing provider outage must not stop the app from working, and the worst case
is a Pro user getting keyword routing for an hour.

## `/ai/route` currently has no session

The gate needs to know who is calling, and `/ai/route` is unauthenticated today.
It gains the same optional `x-session-token` the other routes use:

- **with a session** — metered and gated as above;
- **without one** — treated as free and metered against nothing, so it falls back
  to keyword routing once it would have needed our key. The app always sends the
  header when signed in, so this only affects the guest path, which should not be
  spending our AI budget anyway.

## iOS

- `SubscriptionService` adapted to the current `AppState`, configured with the
  signed-in user's numeric GitHub id as the RevenueCat app user id.
- A **Plan** row in settings — replacing the dimmed "Coming soon" one — showing
  the current plan and opening the RevenueCat paywall, plus Customer Center for
  restore and cancel.
- When a routing response carries `quotaExceeded`, the feed says so once and
  offers the paywall. It does not nag.

## External prerequisites

1. RevenueCat: the **public SDK key** for iOS and a **secret key** for the Worker
   (`REVENUECAT_SECRET_KEY`).
2. App Store Connect: the `monthly` and `yearly` subscription products, linked in
   RevenueCat to the `honmaruai Pro` entitlement.

Unlike push, this needs no new provisioning profile.

## Out of scope

Team/seat pricing, promotional offers, a web checkout, and revenue analytics.
Notifications remain deferred.

## Testing

- **Worker (vitest):** a request with `x-ai-key` is never metered; a free user's
  fourth call in a day comes back `routedBy: "fallback"` with `quotaExceeded`; a
  Pro user is never metered; the entitlement cache is reused within the hour and
  refreshed after it; **RevenueCat returning 500 leaves the user working as
  free**; usage rolls over at the day boundary.
- **iOS:** builds; the paywall presents; the Plan row reflects the real state.
- **Live:** a sandbox purchase flips the same account from metered to unmetered.

## Success criteria

A free user gets three AI-routed decisions a day and a working app afterwards; a
Pro subscriber gets unlimited; anyone using their own API key is unaffected by
either; and neither RevenueCat nor OpenAI being down can stop a decision from
being made.
