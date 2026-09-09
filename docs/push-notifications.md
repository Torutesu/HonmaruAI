# Push notifications (APNs)

> iOS Push is enabled in the client with matching signing entitlements.
> On 2026-09-08, Apple API verification confirmed Push Notifications on
> `com.honmaru.ai` and `aps-environment: production` in the active
> `HonmaruAI AppStore` profile. Real-device delivery still requires verification.
> Web Push and email are documented in [notifications.md](notifications.md).

A decision feed nobody is told about is a to-do list you have to remember to
open. The pitch — *open the app and the decision is already there* — assumes the
user knows to open it.

Sending is done by the Worker, straight to APNs over HTTP/2. There is no
Firebase, no push provider, and no dependency: the provider token is an ES256
JWT and Workers ship Web Crypto, so `worker/src/apns.js` signs it in thirty
lines.

---

## What gets sent, and what does not

The lock screen is a public surface. A card's summary can carry a salary, a
client's name, or the terms of a contract, so the alert body is the **title and
the routing line only** — enough to know it is worth opening, never enough to be
a leak read over someone's shoulder. The card id rides in the payload so a tap
goes straight to that card.

| Trigger | Who is told |
|---------|-------------|
| A card is routed to you | You, unless you are also its author |
| A card you sent is decided | You, unless you decided it |
| A cron sync creates cards | You, once for the batch — not once per card |

`apns-collapse-id` is the card id, so a card that is created and then decided
collapses into one notification rather than stacking two that contradict each
other.

The badge is the recipient's pending count, counted in SQL on the relay and
re-asserted by the client on every feed refresh so it cannot drift from what the
feed shows.

## When permission is asked for

**After the first decision is cleared**, not at launch.

iOS grants exactly one prompt, ever. Spending it on a cold first screen, before
the user has any reason to say yes, is how an app earns a permanent "Don't
Allow" — and there is no second chance, only a trip to Settings that nobody
takes. `FeedViewModel.resolve` asks once the swipe has landed, when *"we will
tell you when the next one arrives"* is a sentence that means something.

Once refused, the Notifications row in **You** stops pretending to be a toggle
and opens Settings instead.

---

## Setup

> The entitlement is generated from `project.yml`; edit its properties there.
> Debug and Release each select their matching APNs signing environment.

### 1. The App ID and the profile

The entitlement has to be in the provisioning profile before it can be in the
app. In the Apple Developer portal, enable **Push Notifications** on the App ID
`com.honmaru.ai`, then reissue the profile:

```bash
asc profiles delete --id "$OLD_PROFILE_ID"
asc profiles create --name "HonmaruAI AppStore" --profile-type IOS_APP_STORE \
  --bundle "$BUNDLE_ID" --certificate "$CERT_ID"
asc profiles download --id "$PROFILE_ID" \
  --output ~/Library/MobileDevice/Provisioning\ Profiles/"$PROFILE_UUID".mobileprovision
```

Set the entitlement in `project.yml` under `entitlements.properties` so XcodeGen
preserves it when regenerating. `APNS_ENVIRONMENT` is `development` for Debug
and `production` for the manually signed Release configuration. Exclude the
entitlements file from sources.

### 2. The APNs key

App Store Connect → **Users and Access** → **Integrations** → **Keys** →
create a key with **Apple Push Notifications service (APNs)** enabled.

Apple lets you download the `.p8` exactly once. Keep it somewhere you will still
have it in a year.

Note the **Key ID** (10 characters) and your **Team ID**.

### 3. Worker secrets

```bash
cd worker
npx wrangler secret put APNS_KEY_ID       # e.g. ABC1234567
npx wrangler secret put APNS_TEAM_ID      # your 10-character team id
npx wrangler secret put APNS_TOPIC        # com.honmaru.ai — the bundle id, not the app name
npx wrangler secret put APNS_PRIVATE_KEY  # paste the whole .p8, BEGIN/END lines included
npx wrangler secret put APNS_ENVIRONMENT  # "production" for TestFlight and the App Store
```

`APNS_PRIVATE_KEY` survives a shell that turns newlines into a literal `\n` —
the PEM parser accepts both spellings, because that is what actually happens
when you paste a key into a terminal.

**All four of the first are required.** Missing any one, `notifyCard` returns
`{ sent: 0, skipped: "apns not configured" }` and nothing else changes: no
errors, no failed decisions, just no notifications. `GET /health` reports
`push: true` once they are all set.

### 4. Environments

`APNS_ENVIRONMENT` decides which Apple host the Worker talks to, and the *app*
tells the server which kind of token it registered:

| Build | Token registered as | Needs |
|-------|---------------------|-------|
| From Xcode (Debug) | `sandbox` | `APNS_ENVIRONMENT=sandbox` |
| TestFlight / App Store | `production` | `APNS_ENVIRONMENT=production` |

Sending a sandbox token to the production host fails with `BadDeviceToken`,
which looks exactly like a bug in the code. If notifications work on a
development build and stop on TestFlight, this is why.

The generated entitlement uses `$(APNS_ENVIRONMENT)` to match the signing
configuration: development for Debug and production for Release.

### 5. Migrate D1

```bash
npx -y wrangler@4 d1 execute tiktokforwork --remote --file schema.sql
```

Adds `device_tokens`. Registration 500s without it.

### 6. Wire the entitlement and flip the constant

Both, in the same commit, after steps 1–3. In `project.yml`, under the
`TikTokForWork` target:

```yaml
    entitlements:
      path: TikTokForWork/HonmaruAI.entitlements
      properties:
        aps-environment: $(APNS_ENVIRONMENT)
    sources:
      - path: TikTokForWork
        excludes:
          - PrivacyInfo.xcprivacy
          - HonmaruAI.entitlements   # compiled as a resource otherwise
```

Then `PushService.isEnabledInThisBuild = true`. Until that constant is set, the
app never asks for permission and never registers, whatever the server has.

Do not land these before step 1. With the entitlement wired and the App ID
without the capability, signing fails and nobody can build the app at all — and
with the constant flipped but the entitlement absent, iOS spends its one
permission prompt on a build that cannot deliver.

---

## Scheduled sync

`crons = ["*/15 * * * *"]` in `wrangler.toml` runs `runScheduledSync`, which
walks users who have a live session, an organization, and at least one
configured connector, syncs their sources, and notifies them about anything new.

Nothing there bypasses the free tier: the sync loop checks the same
`checkAIAllowance` a manual sync does, per message, so a cron run cannot become
a backdoor around the daily limit.

Capped at 50 users per run. Past that the cadence, not the cap, is the thing to
change.

---

## Debugging

| Symptom | Cause |
|---------|-------|
| The app never asks for permission | `PushService.isEnabledInThisBuild` is still false |
| `Provisioning profile … doesn't include the aps-environment entitlement` | Step 1 was skipped, or the reissued profile was not downloaded |
| `/health` says `push: false` | One of the four secrets is missing |
| Works in Xcode, silent on TestFlight | `APNS_ENVIRONMENT` still `sandbox` |
| `BadDeviceToken` in the logs | Environment mismatch, either direction |
| `TooManyProviderTokenUpdates` | Apple throttles a provider token refreshed more than once per 20 minutes. The token is cached for 45 — if you see this, something is calling `resetProviderToken` |
| Registered but nothing arrives | `device_tokens` has no row: check the app got past the permission prompt, and that `x-session-token` was set when it registered |
| Notifications stop after a reinstall | Expected. APNs reissues the token; the app re-registers on next launch, and the old one is deleted the first time Apple answers 410 |
