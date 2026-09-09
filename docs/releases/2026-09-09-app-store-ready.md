# Figma icon and App Store preparation — 2026-09-09

## Implemented

Merged `origin/claude/ai-management-os-notifications-i2egoy` into the current UI on `codex/app-store-ready` (merge commit `135f84d`). Preserved the voice/text composer, team settings, responsive/dark layouts, cancellation guards and account-ID billing identity. Added password sign-in and removed the iOS GitHub sign-in entry; existing GitHub sessions can still choose repositories. Billing affordances respect the existing configured/unavailable state.

The icon comes from Figma Final Screen **Logo 590:143**, with parent **Frame 590:142**. Original vector geometry and gradients are saved under `docs/brand`; iOS uses a square 1024 × 1024 RGB image, Web and in-app marks preserve the rounded frame. Removed the placeholder generator and old icon SVG.

Privacy policy updated against current email authentication, account deletion and connector implementations. Added public Japanese privacy/support pages and in-app links. Expanded the privacy manifest beyond the obsolete four-type list to include name, email, messages, photos/videos and device identifier data. The App Store privacy questionnaire still requires a separate publication step.

## Billing update

Build 36 (1.0), ID `72b40a0d-bc58-474e-85e3-e992407ab62a`, is VALID in TestFlight and assigned to Internal Testers. Archive/export and the Release simulator launch gate passed with the App Store public SDK key embedded. RevenueCat current offering was verified through the public SDK endpoint: `$rc_monthly` maps to `com.honmaru.ai.pro.monthly`, and `$rc_annual` maps to `com.honmaru.ai.pro.yearly`. Both are attached to `honmaruai Pro`. No Apple price changes were made.

## Verification

- iOS Debug tests: 60 passed; Release simulator smoke: launched and survived the fatal-log gate.
- Web: build and 23 tests passed.
- Worker: 370 tests passed.
- Simulator manually verified Japanese welcome, password sign-in entry, decision feed and voice/text composer.
- 3 original Japanese screenshots at 1320 × 2868 uploaded to App Store Connect, all asset states COMPLETE. Screenshots use the built-in sample workspace, not a real customer account.
- Build 35 (1.0), ID `85ea147a-6506-4661-85c1-0629429f74bb`, is VALID in TestFlight and assigned to Internal Testers. Selected for the App Store 1.0 draft. Signed archive/export succeeded. APNs entitlement is `production`, `get-task-allow` is false.
- IPA SHA-256: `5aec3da037abd2fce23857f78f3651945e82057899b52cf457f8861540e73615`.

## Published configuration

- Web deployment: https://09ac7f70.honmaru-web.pages.dev (production https://honmaru-web.pages.dev).
- Public privacy: https://honmaru-web.pages.dev/privacy.html
- Public support: https://honmaru-web.pages.dev/support.html
- Worker version: `db057f43-2d46-4409-a721-d47fe2fc7dc8`.
- App Store Japanese description, keywords, subtitle, privacy/support URLs, standard Apple EULA link, copyright and age-rating answers registered. Review notes updated while preserving the existing required sign-in and credentials.
- Existing monthly/yearly subscriptions are READY_TO_SUBMIT. No replacement products created.

## Remaining before App Store submission

- RevenueCat App Store app is configured with a validated In-App Purchase key. The public Apple SDK key and full App Store product IDs are now configured in source. Both monthly/yearly products are attached to `default` and `honmaruai Pro`; public SDK API readback confirms the package mapping. Sandbox purchase and server `/plans` identity agreement remain to be tested.
- Apple Web login to verify Paid Applications agreement/bank/tax status and publish App Privacy. Public API cannot prove either state; local `asc web auth status` is unauthenticated.
- Third-party content declaration is saved as `USES_THIRD_PARTY_CONTENT` at the owner's request. Owner selected worldwide distribution; all 175 Apple territories are enabled and new-territory availability is true (verified by API readback).
- Submit first subscriptions together with the app version after purchase readiness is confirmed. Build 35 is already selected; submission remains pending.
- Real-device push arrival and voice transcription remain physical-device checks. Signed APNs entitlement and registered device token alone are not delivery proof.
- No App Store review submission performed.

Privacy declaration reference: https://developer.apple.com/app-store/app-privacy-details/ . Declarations must follow actual data handling, not copy the earlier four-type checklist.

Earlier public-API readiness check had 2 blocking items. Territory availability and content rights have since been configured. The separate Web-only privacy/contract and physical-device/billing checks above still apply.

Dia native UI access now works; Apple and RevenueCat authenticated sessions were used to configure the In-App Purchase key. RevenueCat app: `appa8322cb3b9`; key ID: `D739NA2D46` (private key is not stored in the repository). Existing App Store pricing was read back unchanged: USD 10 monthly and USD 96 yearly. Products remain READY_TO_SUBMIT. Automatic product import/status checking has not been configured; the separate App Store Connect API key was not uploaded.

## Billing verification — 2026-09-09 12:30 JST

- Existing RevenueCat v1 secret registered as `REVENUECAT_SECRET_KEY` on production Worker with owner approval; secret-name readback passed. Secret value is not in source.
- Existing entitlement tests: 4 passed (mocked RevenueCat responses; not a real purchase).
- Apple public API validation: 0 errors / 0 blocking, but it does not verify the Web-only requirements below.
- Apple Business UI: Paid Apps Agreement is New / requires agreement; EU trader declaration is incomplete. No contract accepted.
- App Privacy UI: Get Started is shown and Publish disabled; questionnaire is not completed/published.
- No physical iPhone is visible through devicectl or xctrace. Purchase, restore, and real-account server Pro reflection remain unverified.
- Code review finding: free and paid entitlement results are both cached for one hour, so a pre-purchase free result can delay server Pro recognition after purchase. This behavior is not fixed by registering the secret.
- App Store draft still selects build 35; select the qualified billing build before submission.

## Follow-up remediation — 2026-09-09

Negative entitlement cache entries are now bypassed, so the next server request checks RevenueCat after purchase/restore or an API failure. Active entitlements keep the existing one-hour cache. Free-account requests now make more RevenueCat calls in exchange for prompt purchase recognition. All 372 Worker tests passed, including regression tests for fresh free caches and API recovery. Deployed version `a061dd93-1260-4d85-8ada-01a39d159233`; production health passed. No new iOS build is required.

App Privacy remains in progress: 9 data types saved, Name still needs adding, followed by purpose/linkage/tracking answers and publication. Dia was switched to another window during setup; waiting for owner to return to App Privacy. EU trader declaration awaits owner-approved public contact details.

Cable-free physical validation: owner operates TestFlight build 36; compare RevenueCat and authenticated server billing status for the same account. No real purchase/restore is verified yet.

## Latest verified status — 2026-09-09 13:40 JST

This section supersedes earlier incomplete configuration states above.

- Apple Business: Paid Apps Agreement, bank account, W-8BEN, and Certificate of Foreign Status of Beneficial Owner are all Active. EU DSA remains In Review. Personal banking/tax identifiers are intentionally excluded from this record.
- App Privacy published successfully in Apple UI. Ten data types: Name, Email Address, Emails or Text Messages, Photos or Videos, Audio Data, Other User Content, User ID, Device ID, Purchase History, Product Interaction. Purposes: App Functionality; linked to identity; no tracking.
- App download price was previously missing and blocked Add for Review. Configured free download across territories. Existing subscription prices remain unchanged.
- App Store version 1.0 now uses build 36 (`72b40a0d-bc58-474e-85e3-e992407ab62a`), verified by API attachment and UI readback.
- Draft submission contains four ready items: iOS 1.0 (36), Pro subscription group, Pro Monthly, Pro Yearly. Submit for Review is enabled. Final review submission has NOT been sent.
- Owner reported a RevenueCat configuration error before contract activation. Public SDK offerings returned the correct monthly/yearly identifiers and archived build 36 embeds the correct Apple SDK key. Retest after contract activation remains necessary; purchase/restore and same-account server `/billing/status` Pro recognition are not yet verified.

## Build 37 follow-up

Owner still could not use subscriptions in build 36 and requested a fresh TestFlight release. Removed the fallback paywall's automatic fetch: loading removes that view, so a failed fetch can recreate it and trigger another request repeatedly. The parent paywall owns initial loading; the fallback's explicit retry remains. Concurrent offering requests are ignored, and retries clear stale error messages. Configuration failures now include the RevenueCat numeric error code so a device report can distinguish product configuration, identity, and credential errors.

Native tests passed: 60 tests, zero failures (`/tmp/honmaru-build37-tests.log`). Live RevenueCat offering IDs match Apple. Apple Japan pricing readback: JPY 1,500 monthly, JPY 15,000 yearly; no subscription price changes. These checks do not prove a successful StoreKit purchase on the owner's iPhone.

Build 37 / version 1.0 uploaded and processed VALID; build ID `c6a4290f-2393-46d0-8737-12ba3a2cc489`, assigned to Internal Testers (`12726632-2dd9-4d64-bbac-40d888fec47a`). Signed archive/export succeeded and the mandatory Release simulator launch survived 12 seconds without a fatal error. Archive readback confirmed build number and public SDK key. Logs: `/tmp/honmaru-build37-build.log`, `/tmp/honmaru-build37-testflight.log`. App Store submission remains unsent and its draft still references build 36; replace with build 37 after physical purchase/restore qualification.
