# RevenueCat web subscriptions and channel pricing

Status: implementation prepared; no production billing or store price changes yet.
Source base: origin/main 6aad658. Use the release worktree, not the old dirty root checkout.

## Agreed pricing

Japan web: JPY 1,500 monthly / JPY 15,000 yearly (current App Store prices).
Japan new app subscriptions: JPY 1,950 monthly / JPY 19,800 yearly.
The user explicitly chose JPY 19,800 because Apple has no JPY 19,500 price point.
Preserve existing subscribers' prices. USD current baseline: $10 monthly / $96 yearly;
new app targets: $13 / $124.80, subject to available store price points. Other
territories need a current-price snapshot and per-territory mapping before any write.
A 30% markup is not full recovery of a 30% fee (1.3 * 0.7 = 0.91).
Do not advertise zero fees: payment processing, RevenueCat and regional app-to-web
program fees may apply. No native external-purchase CTA is introduced here.

## Architecture

RevenueCat project 92c5ea97 already serves iOS entitlement `honmaruai Pro`.
Prefer RevenueCat Billing with Stripe processing and hosted Web Purchase Links.
The integration also supports a Stripe Billing provider in the same project.
Both monthly and yearly web products must grant the existing entitlement.
Use a separate web offering; do not replace the mobile default offering.

POST /billing/web-checkout derives the RevenueCat identity from the authenticated
Honmaru session, never from request data. It checks fresh entitlement state and
fails closed on an outage or active/complimentary access. Hosted checkout must
also be configured to skip purchase for existing entitlement holders, including
concurrent/open checkout tabs. Prices are rendered by the live hosted checkout.
POST /billing/manage returns only a vetted provider management URL.
Web UI uses a full-page redirect, then reloads account access on return to #/plans;
there is also an explicit refresh button. Native/desktop clients retain their
existing purchase UI. Existing RevenueCat SDK identity resolves web Pro on iOS.
No client-side success URL or local flag grants access.

## Activation (not yet performed)

1. The existing RevenueCat login can open New web provider and the RevenueCat
   Billing creation form. The earlier permission diagnosis was incorrect: an
   accessibility container carried an error message even though navigation worked.
   The loaded form explicitly reports no connected Stripe accounts. No account
   switch or role change is established as necessary.
2. Connect the correct business Stripe account in RevenueCat, add RevenueCat Billing
   web config, and create monthly/yearly products at the web prices above. Check tax
   behavior so the Japanese displayed total remains the agreed price.
3. Attach `honmaruai Pro`, create the dedicated offering and Web Purchase Link.
   Configure success redirect https://app.honmaruai.com/#/plans and customer portal.
   Returning active customers must skip checkout. Check cancellation, payment failure,
   refund and expiration behavior. Keep sandbox and production links separate.
4. In isolated staging, set REVENUECAT_WEB_PURCHASE_URL to the verified hosted base
   URL (https://pay.rev.cat/<token>, no user ID/query), the existing RevenueCat secret
   and REVENUECAT_WEB_BILLING_ENABLED=true. A true flag alone is not launch evidence.
5. Verify sandbox purchase with two distinct Honmaru accounts: purchaser gets Pro
   on web and iOS, other account stays Free; logout/login maintains isolation;
   cancellation, refund, failed payments, portal and expiry behave correctly.
6. Verify the production provider/catalog/portal, then deploy and enable production
   with the PRODUCTION link only. A sandbox token can look syntactically valid and
   must never be placed in production configuration.
7. Change App Store new-subscriber pricing while preserving subscribers, verify
   live purchase sheet. Check Google Play billing/catalog and Android implementation
   separately; do not claim Android billing exists from a shared backend or version.
8. Update all five LP languages after checkout is usable and real prices verified.
   Keep current iOS 1.3.3 review submission intact; app-to-web linking would require
   separate regional program eligibility and implementation review.

## Sources

- https://www.revenuecat.com/docs/web/web-billing/web-purchase-links
- https://www.revenuecat.com/docs/web/integrations/stripe
- https://www.revenuecat.com/docs/api-v1/customer-info-model
- https://developer.apple.com/app-store/review/guidelines/
- https://support.google.com/googleplay/android-developer/answer/9858738

## Local validation

Worker billing and hosted checkout tests, web billing tests, TypeScript/Vite build.
These tests mock provider responses and do not prove a real checkout or iOS sync.
Remaining blocker: connect the correct Stripe account, finish RevenueCat provider
configuration, and perform end-to-end tests. This is not a confirmed role blocker.
