# RevenueCat subscriptions

`honmaruai Pro` is sold through RevenueCat. This document is the whole setup: package
install, dashboard configuration, how the code is wired, and how to test it.

- SDK: [`purchases-ios-spm`](https://github.com/RevenueCat/purchases-ios-spm) (`RevenueCat` + `RevenueCatUI`)
- Entitlement: `honmaruai Pro`
- Products: `yearly`, `monthly`
- Paywall: RevenueCat-hosted (Paywalls v2), rendered by `PaywallView`
- Self-service: RevenueCat Customer Center

---

## 1. Install the Swift Package

Already committed — `project.yml` and `TikTokForWork.xcodeproj` both declare the
dependency, so `xcodegen generate && open TikTokForWork.xcodeproj` picks it up and Xcode
resolves it on first open.

```yaml
# project.yml
packages:
  RevenueCat:
    url: https://github.com/RevenueCat/purchases-ios-spm.git
    from: 5.30.0

targets:
  TikTokForWork:
    dependencies:
      - package: RevenueCat
        product: RevenueCat
      - package: RevenueCat
        product: RevenueCatUI
```

To add it by hand in Xcode instead: **File → Add Package Dependencies…** →
`https://github.com/RevenueCat/purchases-ios-spm.git` → **Up to Next Major Version** from
`5.30.0` → check **RevenueCat** *and* **RevenueCatUI** → target `TikTokForWork`.

Use `purchases-ios-spm`, not `purchases-ios`: it's the same SDK published as a
binary-friendly package that resolves much faster and avoids the XCFramework build step.
`RevenueCatUI` is what gives you `PaywallView` and `CustomerCenterView` — without it you'd
be hand-building both.

## 2. Configure the SDK

`TikTokForWork/App/RevenueCatConfig.swift` holds every identifier, and
`AppState.init()` configures the SDK before the first frame renders:

```swift
subscriptionService.configure(appUserID: SessionStore.currentUserID)
```

which runs:

```swift
Purchases.logLevel = RevenueCatConfig.logLevel        // .debug in DEBUG, .warn in release
Purchases.configure(
    with: Configuration.Builder(withAPIKey: RevenueCatConfig.apiKey)
        .with(appUserID: appUserID)                   // nil ⇒ anonymous ID
        .build()
)
```

Notes:

- **Configure once, early.** `Purchases.isConfigured` guards re-entry, so a second call
  (hot reload, preview, test) is a no-op instead of a crash.
- **The key in the repo is a Test Store key** (`test_…`). The Test Store serves `yearly`
  and `monthly` without any App Store Connect setup, which is what makes the simulator
  useful. Swap in the `appl_…` production key from **Project settings → API keys** before
  shipping. Public SDK keys are safe to ship; the *secret* key must never enter the app.
- **Never call `Purchases.shared` before configuring** — it traps. Everything in
  `SubscriptionService` guards with `Purchases.isConfigured`.

## 3. Dashboard configuration

Do these in order; each step depends on the previous one.

### Products

**Products → New**, one per store product, identifiers matching
`RevenueCatConfig.ProductID`:

| Product ID | Duration | Notes |
|------------|----------|-------|
| `yearly`   | 1 year, auto-renewing | Mark as the highlighted plan on the paywall |
| `monthly`  | 1 month, auto-renewing | |

For production these must exist in App Store Connect first (same identifiers), in an
auto-renewable subscription **group** — one group means users can switch between monthly
and yearly as an upgrade/downgrade instead of stacking two subscriptions.

### Entitlement

**Entitlements → New** → identifier `honmaruai Pro` → attach **both** products.

The identifier is what the app checks. It must match
`RevenueCatConfig.proEntitlementID` byte for byte, space included. Everything the app
gates reads this one entitlement, so adding a lifetime or a promo product later is a
dashboard change, not an app release.

### Offering

**Offerings → New** → identifier `default` → mark it **Current** → add two packages:

| Package | Product |
|---------|---------|
| Annual (`$rc_annual`) | `yearly` |
| Monthly (`$rc_monthly`) | `monthly` |

The app reads `offerings.current` first and only falls back to the `default` identifier, so
switching prices or running an experiment is a dashboard toggle.

### Paywall

**Paywalls → select the `default` offering → New paywall**, pick a template, set copy and
colors, publish. `PaywallView` renders whatever is published; no app release needed to
change it. If no paywall is configured the SDK renders a default template, and if offerings
can't be fetched at all the app falls back to `FallbackPaywallView`.

### Customer Center

**Customer Center → enable**, then configure the paths you want: cancel, change plan,
request a refund, cancellation survey, and support contact. It's dashboard-driven, so
`CustomerCenterView()` needs no arguments.

## 4. How the code is organized

| File | Responsibility |
|------|----------------|
| `App/RevenueCatConfig.swift` | API key, entitlement ID, product IDs, log level, free quota |
| `Services/SubscriptionService.swift` | Every `Purchases` call: configure, offerings, purchase, restore, identity, errors |
| `Services/RoutingQuota.swift` | Free-tier daily meter that the entitlement lifts |
| `Features/Subscription/ProPaywallSheet.swift` | `PaywallView` + native fallback |
| `Features/Subscription/SubscriptionView.swift` | Status, Customer Center, restore, `.proPaywall(isPresented:)` |

`SubscriptionService` is injected as an `@EnvironmentObject` in `TikTokForWorkApp`, so any
view can read `subscriptions.isPro` and get re-rendered the moment entitlements change.

### Customer info stays live

```swift
customerInfoTask = Task { [weak self] in
    for await info in Purchases.shared.customerInfoStream {
        self?.customerInfo = info
    }
}
```

`customerInfoStream` is the modern replacement for `PurchasesDelegate`. It fires on
purchase, restore, renewal, expiration, and dashboard-granted promos — including changes
that happen while the app is backgrounded — so the UI never needs a manual refresh after a
purchase. `refreshCustomerInfo()` exists for pull-to-refresh style moments; the SDK caches
aggressively, so calling it often is fine.

### Entitlement checking

```swift
var isPro: Bool {
    customerInfo?.entitlements[RevenueCatConfig.proEntitlementID]?.isActive == true
}
```

Check `isActive` — never compare `expirationDate` yourself. `isActive` already accounts for
billing grace periods, billing retry, and store-side refunds, and it respects the
entitlement's server-side state rather than the device clock.

Three gating styles are in use:

```swift
// 1. Hard gate — RevenueCatUI presents and dismisses the paywall for you (OrgGraphView)
.presentPaywallIfNeeded(requiredEntitlementIdentifier: RevenueCatConfig.proEntitlementID)

// 2. Soft gate — free allowance, paywall only once it's spent (FeedView)
if quota.canRoute(isPro: subscriptions.isPro) { showAIInput = true }
else { subscriptions.showPaywall = true }

// 3. Chrome — reflect state without blocking (ProBadge in the top bar)
if subscriptions.isPro { ProBadge() }
```

### Purchases

```swift
let result = try await Purchases.shared.purchase(package: package)
guard !result.userCancelled else { return false }
customerInfo = result.customerInfo
```

Purchase from a `Package`, not a product ID — the package carries the offering and package
type, which is what makes RevenueCat's charts and experiments meaningful. Prices come from
`package.storeProduct.localizedPriceString`; never hardcode them, they vary by storefront.

Cancellation is not an error: `userCancelled` returns `false` quietly, and
`ErrorCode.purchaseCancelledError` maps to no message. `SubscriptionService.message(for:)`
turns the rest of `RevenueCat.ErrorCode` into copy a user can act on (network, store
outage, pending approval, purchase-not-allowed, receipt already in use, misconfiguration).

### Restore

`restorePurchases()` is exposed on the paywall, in the Customer Center, and as a plain
button in `SubscriptionView`. App Review requires a visible restore path in any app that
sells subscriptions.

### Identity

```swift
await subscriptionService.identify(userID: user.id)   // sign-in / user switch
await subscriptionService.signOut()                    // back to an anonymous ID
```

`logIn` aliases the anonymous ID that existed before sign-in onto the real account, so a
purchase made before signing in survives. Sign-out matters on shared devices: without
`logOut()` the next person inherits the previous account's entitlement.

## 5. Testing

| Environment | How |
|-------------|-----|
| Simulator, no App Store setup | Test Store key (`test_…`) — what's committed. Purchases complete instantly and entitlements behave like production. |
| Local StoreKit testing | Add a StoreKit configuration file with `yearly`/`monthly`, select it in the scheme, and run with the production key. Renewals accelerate, so you can watch an expiration. |
| Sandbox | Real device + Sandbox Apple ID (Settings → App Store → Sandbox Account) with the `appl_…` key. Required before shipping — it's the only way to exercise Apple's real purchase sheet, ask-to-buy, and billing-retry states. |

With `Purchases.logLevel = .debug`, the console prints the resolved offerings, the
entitlement evaluation, and the reason for every failed purchase. Read those before
guessing. The two failures worth knowing up front:

- **Empty offerings** — products aren't attached to the offering, or the store products
  don't exist / aren't "Ready to Submit" in App Store Connect.
- **Purchase succeeds but `isPro` stays false** — the products aren't attached to the
  `honmaruai Pro` entitlement, or the identifier in `RevenueCatConfig` doesn't match.

## 6. Production checklist

- [ ] Swap the Test Store key for the `appl_…` production key (or read it from an
      `.xcconfig` so debug and release builds differ).
- [ ] In App Store Connect: both products in one subscription group, localized display
      names, prices in every storefront, review screenshot.
- [ ] Add the **In-App Purchase** capability and a paid-apps agreement in place.
- [ ] Set up [webhooks](https://www.revenuecat.com/docs/integrations/webhooks) so the relay
      server learns about renewals and cancellations without the app running.
- [ ] Gate anything that costs money server-side too. The client check is a UX decision;
      the server should verify entitlements through RevenueCat's REST API or its own
      webhook-fed store. `RoutingQuota` lives in `UserDefaults` on purpose — it's a product
      limit, not a security boundary.
- [ ] Verify restore, cancel, and refund flows in the Customer Center on a sandbox account.

## References

- [Installation](https://www.revenuecat.com/docs/getting-started/installation/ios)
- [Configuring the SDK](https://www.revenuecat.com/docs/getting-started/configuring-sdk)
- [Displaying paywalls](https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls)
- [Customer Center for iOS](https://www.revenuecat.com/docs/tools/customer-center/customer-center-integration-ios)
