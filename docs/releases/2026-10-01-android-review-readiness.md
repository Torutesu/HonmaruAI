# Android review readiness — 2026-10-01

## Verified

- Google Play app: 4974565419257113373, package com.honmaru.ai.
- App access/login details saved in Play Console with the dedicated review account and English instructions. Save-success text verified; not submitted for review.
- Review credentials are stored outside Git in ~/.appstoreconnect/review/honmaru-google-play.json with mode 0600. Do not copy them into this document or logs.
- Dedicated account password login, profile and workspace access succeed against production.
- WORKSPACE_V2 is enabled only for the review workspace via a Worker secret. Posting, history, thread replies, mark-read, unread and unauthenticated denial were verified against production. General customer workspaces remain disabled.
- Mobile password login, privacy links and account-deletion confirmation were added on codex/android-internal-release. Typecheck and Expo lint pass; core tests passed (36) after password-login work.

## Release gates still open

- Run the final Android binary and verify login, messages, thread replies and account deletion with a separate disposable QA account. Do not delete the shared review account.
- The new account-deletion UI uses the existing DELETE /account endpoint; actual deletion and retention behavior have not yet been verified for the v2 message store.
- Audit/update the published privacy notice for Android. It currently describes Apple-specific services and must accurately cover the Android release's collection and storage.
- Complete Data safety, content rating, audience and other declarations using the actual Android behavior. Android currently exposes workspace channels and messaging; do not reuse iOS decision-card screenshots or claim unimplemented IAP/audio features.
- Capture actual Android screenshots and prepare store artwork/listing.
- Confirm final AAB upload and release track in Play Console. Build success alone is not Play upload or review submission.
- General release must resolve the per-workspace v2 rollout: enabling only the review workspace is insufficient for ordinary users.

## App access instructions saved

On the sign-in screen, tap "Sign in with a password", enter the supplied credentials, then tap "Sign in". No email code, invitation, payment or location verification is required. Open Review Sandbox to read sample messages, send a message and reply in a thread. This account belongs to an isolated workspace containing synthetic review data.

## Latest verification

- Play Console initial setup: 8/11 complete. Ads, government, finance, health, IARC rating and target audience saved. Data safety is a draft, pending the public deletion URL and full data audit. No review submission.
- EAS Android build 6 (`93c85371-f6bf-4537-a633-7a029b278da6`) finished successfully. AAB downloaded to Downloads/HonmaruAndroid/honmaru-1.0.0-6.aab. Not yet uploaded to Play.
- Latest main merged at 3f649ca to preserve the Mac notification updates. Account/workspace deletion and notification regression tests: 26 passed. Full CI still pending at last check.
- Added Workspace DO account cleanup and public Android privacy/deletion instructions in commit 9eba25b. Not deployed.
- Local Android AVD Honmaru_Play_Review created with API 35. Installation did not complete because bundletool could not retrieve the emulator SDK version. No Android UI validation has passed.
