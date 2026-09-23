# Complimentary access release

This release is based on main `f6fe666` and preserves its team, privacy, OAuth, connector, and relay changes. The older app-store-ready checkout is not the deployment source.

## Account access

- Web activation is at `https://honmaru-web.pages.dev/#/plans`, after normal sign-in.
- The shared access code is stored only in the Worker secret `COMPLIMENTARY_ACCESS_CODE`. It is not stored in source, URLs, database rows, or request logs.
- Redemption is authenticated, account-bound, case-sensitive, bounded to 1 KiB, and rate-limited by account and IP. A caller cannot select another account.
- D1 stores permanent complimentary access. RevenueCat receives the same authenticated account ID and the existing `honmaruai Pro` entitlement with a fixed 2226-01-01 promotional expiry. This bridges the already-published iOS app without a new app release; D1 access has no expiry.
- Provider failure retains a pending grant. The Web distinguishes available Web access from pending iPhone activation and allows status refresh to retry.
- Synchronization verifies the returned promotional store, entitlement, and expiry; an existing paid subscription alone is not confirmation.
- Account deletion revokes this promotion before deleting local account data. Leases and a deletion marker prevent grant/revoke races; the marker survives until the user row is removed. Other promotions are not revoked blindly.
- Existing Apple subscriptions are not cancelled automatically. The activation screen explains how to stop existing renewals.
- Purchases go to the actual App Store app and use its prices and eligible offers; fabricated Web prices, trials, and unavailable Business products are removed.

## Onboarding

New-account progress and answers are scoped to account and API. Refresh resumes unfinished setup. Failed profile saves keep the answers and allow retry. Existing accounts are not forced through onboarding again. Saved sessions are checked against the server; temporary failures preserve credentials, expired sessions clear them. Invite acceptance waits for restoration so it cannot be overwritten by an older workspace.

The App Store support page previously deployed outside main is now tracked so Web deployments retain it.

## Validation

- Worker: 88 files, 509 tests passed on the current main dependency lock.
- Web: 10 files, 46 unit tests passed on the current main dependency lock; production build passed.
- Browser: code privacy, account switching, duplicate submission, stale requests, pending synchronization, retries, Japanese mobile layout, onboarding drafts, failed-save recovery, and session restoration exercised.
- Live qualification scripts create and delete only disposable ordinary accounts. The code is read from stdin; credentials are retained in a mode-0600 recovery file only if cleanup fails.

Deployment and live verification evidence will be added after publication. These checks do not claim a real-money App Store purchase or a physical-device purchase/restore test.

References: https://www.revenuecat.com/docs/api-v1/entitlements and https://www.revenuecat.com/docs/customers/customer-info .
