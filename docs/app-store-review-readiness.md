> Historical handoff: current integration and verified remaining work are recorded in [2026-09-09 release status](releases/2026-09-09-app-store-ready.md). Build 32 and the four-data-type checklist below are superseded.

# Can this app pass review?

`app-store-release.md` covers how to *ship* a build. This is the other half:
what App Store review will do with it once it arrives, and the two things that
would have failed the first submission. Both are fixed; this is the record of
what they were and what is still only half-proved.

Both were found by reading the app the way a reviewer meets it — with no
GitHub account, no access to our mailbox, and no context.

---

## 1. A reviewer could not sign in — Guideline 2.1

**This would have been rejected.** Not "might": an app the reviewer cannot get
into is returned every time, usually with a screenshot of the sign-in screen.

The app had two doors, and a reviewer can walk through neither:

| Door | Why it fails for a reviewer |
| --- | --- |
| GitHub | They will not create a GitHub account to test an app, and Apple's own guidance says they should not have to. |
| Email code | The code is real mail, sent by Resend. Until a domain is verified there, Resend's shared sender **delivers only to the address that owns the Resend account** — so a code addressed to the reviewer is accepted by the API and never arrives. |

The second one is the trap: `/auth/otp/request` answers `{"ok":true}` for an
address it cannot reach, deliberately, because saying otherwise tells a stranger
which addresses have accounts here. From the reviewer's side it looks exactly
like a broken app.

### What was done about it

A **password sign-in** now exists on iOS. The Worker has had `/auth/login` all
along and the web client uses it; only the phone had no route to it. It sits
behind "Use a password instead" on the sign-in sheet, and a deployment that
cannot send mail at all now lands there instead of telling people to use GitHub
— which was a dead end for exactly the people email sign-in was added for.

### What you still have to do

**Make a demo account and put it in the review notes.** Two commands:

```bash
# 1. Create it. Use an address you control; it never receives mail.
curl -sS -X POST https://tiktokforwork.torubj0904.workers.dev/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"appreview@yourdomain.com","password":"<a long random one>","name":"App Review"}'

# 2. Prove it works, the way the reviewer will.
curl -sS -X POST https://tiktokforwork.torubj0904.workers.dev/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"appreview@yourdomain.com","password":"<the same one>"}'
```

The second must return a `token`.

A step-by-step Japanese walkthrough of the App Store Connect side — which
screen, which checkbox, what to write in the notes — is in
[app-review-signin-ja.md](app-review-signin-ja.md).

Then in App Store Connect →
**App Review Information** → *Sign-in required*, give that address and password,
and in the notes:

> Tap **Sign in with email** → **Use a password instead**, and use the account
> above. GitHub sign-in is optional and not needed to review the app.

Do not skip the notes. Without them a reviewer lands on a screen offering
GitHub and a code, and the password route is one tap away but not obvious.

### The domain is verified now

honmaruai.com is verified at Resend and `NOTIFY_EMAIL_FROM` is
`Honmaru AI <noreply@honmaruai.com>`, so a code reaches **any** address, not
only the one that owns the Resend account. Confirmed by sending to an unrelated
domain and by reading the From line on a delivered message.

That closes the same hole for real users: until it was done, nobody you invited
could sign in either. The demo account stays regardless — a reviewer should not
have to wait for mail.

> **When testing this, do not use `example.com`.** Resend refuses reserved
> domains with a 422, which is indistinguishable from an unverified sender and
> cost a wrong diagnosis here. Use a real address you can read.

---

## 2. Sign in with Apple — Guideline 4.8 — resolved by removing the cause

**Settled: GitHub is no longer a way into the app on the phone.**

4.8 applies to apps that use "a third-party or social login service" to set up
the primary account, and then requires an alternative that lets a person keep
their email address private. Our emailed code cannot do that — there is no
relay — so offering GitHub sign-in meant owing Apple a Sign in with Apple we do
not have.

Rather than build one, the cause is gone. It was also the wrong default: GitHub
is right for the engineer on the team and wrong for the six people who are not,
and the phone is where those six are. The engineer sets the repository-backed
workspace up on the web, where GitHub sign-in is untouched, and invites them; an
invite code brings them into it from the phone.

What changed, precisely:

- **Onboarding** ends on email, with "continue without signing in" underneath.
  The GitHub step, its repository picker and its OAuth call are gone.
- **The connect sheet** no longer signs anyone in. It is offered only to someone
  who already has a GitHub token — a repository picker for an existing account,
  not a door.
- **You** shows the GitHub row only to those people, and **the feed's** local-mode
  chip no longer offers a button that cannot finish.
- **Anyone already signed in with GitHub stays signed in.** Session restore is
  untouched; this removed the door, not the lock.

GitHub remains what it is actually load-bearing for: decisions syncing to Issues
and Pull Requests, for a workspace that has a repository.

So 4.8 no longer applies. If GitHub sign-in ever returns to iOS, it comes back
with Sign in with Apple beside it.

## 3. Push — on in the app now, and not yet proved

`/health` reports `"push": true`: the four APNs secrets are set, against a key
scoped **Sandbox & Production**, so `APNS_ENVIRONMENT=production` is the right
one and works for TestFlight as well as the App Store.

**Build 32 could not receive one anyway.** `PushService.isEnabledInThisBuild`
was `false` and the entitlement was unwired, so the app never asked for
permission and never registered a token — the server was ready and the client
was not listening. That is fixed: the entitlement is wired with
`aps-environment` resolved per configuration (`development` in Debug,
`production` in Release), so a local build and a distribution build each get
the one they need, and the constant is `true`.

That still is not the same as "a notification arrives". `isConfigured` checks
that the values exist, not that Apple accepts them — a key restricted to the
wrong environment, a wrong team id, or a topic that is not the bundle id all
leave `push` true and fail silently, with the reason only in the Worker's log.
The first build on a real device is what proves it, and that build is the next
one, not 32.

Web Push has worked throughout and is unaffected.

---

## 4. In-app purchase — built, and switched off

`RevenueCatConfig.apiKey` is the committed **Test Store** key (`test_…`). The
SDK calls `fatalError` if a Test Store key is configured in a Release build —
its own safeguard against a test key reaching the App Store — so the app
deliberately does not configure RevenueCat at all unless the key is a real
`appl_`/`mac_` one. Every Release build therefore runs with billing
unavailable, `isPro` false, and purchase and restore answering "not
configured".

The service handled that correctly from the start. **The views did not**, and
that was the third thing review would have failed on: Subscription offered
"Upgrade to Pro" and the feed's quota line offered "Upgrade", both landing on
the paywall's *"Plans aren't available right now. Check your connection"* — an
app blaming the reviewer's network for a switch we set. Those affordances now
ask `SubscriptionService.canSell` first and say plainly that upgrading is not
available in this version.

**A build with no IAP passes review.** An app that is free and complete is
fine; what fails is an app that offers a purchase it cannot complete.

### Turning it on, when you want money

All four, in this order:

1. **App Store Connect → Agreements, Tax, and Banking** — the *Paid
   Applications* agreement must be **Active**. Nothing below works until it is,
   and this is the step with a lead time (bank details, tax forms).
2. **App Store Connect → your app → Subscriptions** — create a subscription
   group and the two products, with the identifiers RevenueCat expects:
   `monthly` and `yearly`. Each needs a price, a localised display name and a
   review screenshot.
3. **RevenueCat dashboard** — attach those products to packages in the
   `default` offering, and to the `honmaruai Pro` entitlement. The identifiers
   in `RevenueCatConfig` must match exactly; a typo shows up as "never
   subscribed", not as an error.
4. **Swap the key** — put the `appl_…` public SDK key in
   `RevenueCatConfig.apiKey`. That single line is what turns purchasing on;
   `canSell` follows it and every affordance comes back.

Submit the IAP products **with** the build. A first subscription has to be
reviewed alongside a version, and submitting the app first means doing the
whole review again for the purchase.

---

## Already handled — don't re-litigate these

Checked against the current tree, so a review does not spend time on them:

- **`PrivacyInfo.xcprivacy`** — present and complete: no tracking, four declared
  data types, and required-reason codes for UserDefaults (CA92.1), file
  timestamps (C617.1) and disk space (E174.1). Verify it is *inside* the built
  `.ipa` (`unzip -l build/*.ipa | grep xcprivacy`) — a manifest in the wrong
  build phase fails review exactly as if it were absent.
- **Account deletion** (5.1.1(v)) — **You → Delete account**, backed by
  `DELETE /account`.
- **Export compliance** — `ITSAppUsesNonExemptEncryption` is set in `Info.plist`.
- **Device family** — iPhone only, portrait only, consistent; a mismatch here is
  the ITMS-90474 upload rejection.
- **App icon** — a single 1024×1024 in the asset catalogue is the modern format;
  Xcode generates the rest. Nothing further is needed.
- **Signing** — Release is manual against an App Store profile, so an archive
  does not need a registered device.
- **Japanese** — every user-facing string in the app is localised (421 keys,
  none missing), so the Japanese screenshots will match the Japanese binary.

---

## The order to do it in

1. ~~Create the demo account and check `/auth/login` returns a token.~~ Done —
   `appreview@honmaruai.com`, verified against `/auth/login`.
2. ~~Upload a build.~~ Done — 1.0 (32) is on TestFlight. It predates the app
   icon, push and the billing fix, so **the build you submit is the next one**.
3. Build again and upload: `scripts/release.sh build 1.0` then
   `scripts/release.sh testflight`.
4. Take the screenshots from *that* build. The sign-in screen, the icon and the
   Subscription screen all changed.
5. Fill in the store listing — this is the part with no code in it and the part
   that is still empty. See below.
6. `scripts/release.sh submit 1.0`.

## What App Store Connect still needs from you

None of this is in the repo, and a submission is refused without it:

| Field | Notes |
| --- | --- |
| **Screenshots** | 6.9" (1320×2868 or 1290×2796) is mandatory. 6.5" is accepted for older devices. Take them in Japanese if the primary locale is Japanese. |
| **Description** | What the app is. Do not mention other platforms or "beta". |
| **Keywords** | 100 characters, comma-separated, no spaces after commas. |
| **Support URL** | Must resolve and must show a way to contact you. `support@honmaruai.com` receives mail. |
| **Privacy Policy URL** | Required for every app. Must be reachable from a browser with no sign-in. |
| **App Privacy** | The questionnaire, separate from `PrivacyInfo.xcprivacy`. Answer it to match the manifest: four data types, no tracking. |
| **Age rating** | The questionnaire. |
| **Sign-In Required** | `appreview@honmaruai.com` and the password, plus the notes — [app-review-signin-ja.md](app-review-signin-ja.md). |

`scripts/release.sh metadata 1.0` scaffolds `./metadata` and pushes the text
fields from files, which is easier to review than a browser form. Screenshots
and the two questionnaires have to be done in the browser.
