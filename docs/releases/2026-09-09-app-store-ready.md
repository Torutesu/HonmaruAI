# Figma icon and App Store preparation — 2026-09-09

## Implemented

Merged `origin/claude/ai-management-os-notifications-i2egoy` into the current UI on `codex/app-store-ready` (merge commit `135f84d`). Preserved the voice/text composer, team settings, responsive/dark layouts, cancellation guards and account-ID billing identity. Added password sign-in and removed the iOS GitHub sign-in entry; existing GitHub sessions can still choose repositories. Billing affordances respect the existing configured/unavailable state.

The icon comes from Figma Final Screen **Logo 590:143**, with parent **Frame 590:142**. Original vector geometry and gradients are saved under `docs/brand`; iOS uses a square 1024 × 1024 RGB image, Web and in-app marks preserve the rounded frame. Removed the placeholder generator and old icon SVG.

Privacy policy updated against current email authentication, account deletion and connector implementations. Added public Japanese privacy/support pages and in-app links. Expanded the privacy manifest beyond the obsolete four-type list to include name, email, messages, photos/videos and device identifier data. The App Store privacy questionnaire still requires a separate publication step.

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

- RevenueCat dashboard login, verify production app key, default offering and `honmaruai Pro` entitlement, then sandbox purchase and server `/plans` identity agreement. Current build keeps purchases unavailable without a production key.
- Apple Web login to verify Paid Applications agreement/bank/tax status and publish App Privacy. Public API cannot prove either state; local `asc web auth status` is unauthenticated.
- Third-party content rights remain to be confirmed. Owner selected worldwide distribution; all 175 Apple territories are enabled and new-territory availability is true (verified by API readback).
- Submit first subscriptions together with the app version after purchase readiness is confirmed. Build 35 is already selected; submission remains pending.
- Real-device push arrival and voice transcription remain physical-device checks. Signed APNs entitlement and registered device token alone are not delivery proof.
- No App Store review submission performed.

Privacy declaration reference: https://developer.apple.com/app-store/app-privacy-details/ . Declarations must follow actual data handling, not copy the earlier four-type checklist.

Earlier public-API readiness check had 2 blocking items. Territory availability has since been configured worldwide; content rights remains unresolved. The separate Web-only privacy/contract and physical-device/billing checks above still apply.

Dia access attempt: native window unavailable; browser automation inventory exposes Chrome and the in-app browser only. Apple/RevenueCat Web authentication remains pending.
