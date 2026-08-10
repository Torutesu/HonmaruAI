import Foundation
import RevenueCat

/// Single owner of every RevenueCat call in the app.
///
/// Views never touch `Purchases` directly — they read `isPro` / `summary` and call
/// `purchase(_:)`, `restorePurchases()`, `identify(userID:)`. Entitlement state stays live
/// through `Purchases.shared.customerInfoStream`, so a purchase on the RevenueCat paywall,
/// a restore from the Customer Center, a renewal that lands while the app is open, and a
/// refund granted in the dashboard all reach the UI through the same publisher.
@MainActor
final class SubscriptionService: ObservableObject {
    /// The one instance the app configures at launch and identifies on sign-in, so every
    /// view resolves the same entitlement state through `@EnvironmentObject`.
    static let shared = SubscriptionService()

    @Published private(set) var customerInfo: CustomerInfo?
    @Published private(set) var offerings: Offerings?
    @Published private(set) var isLoadingOfferings = false
    @Published private(set) var isPurchasing = false
    @Published private(set) var isRestoring = false
    @Published var errorMessage: String?

    /// App-wide paywall flag, so any gated action can raise the paywall from anywhere.
    @Published var showPaywall = false

    private var customerInfoTask: Task<Void, Never>?

    // MARK: - Entitlement

    var isConfigured: Bool { Purchases.isConfigured }

    /// The `honmaruai Pro` entitlement, active or not (expired ones stay readable).
    var proEntitlement: EntitlementInfo? {
        customerInfo?.entitlements[RevenueCatConfig.proEntitlementID]
    }

    /// The one check the rest of the app makes. `isActive` already accounts for grace
    /// periods and billing retries, so never compare expiration dates by hand.
    var isPro: Bool {
        proEntitlement?.isActive == true
    }

    /// Generic form, for gating anything else you add to the dashboard later.
    func isEntitled(to entitlementID: String) -> Bool {
        customerInfo?.entitlements[entitlementID]?.isActive == true
    }

    /// Everything the status UI needs, flattened out of `EntitlementInfo`.
    var summary: SubscriptionSummary? {
        guard let proEntitlement, proEntitlement.isActive else { return nil }
        return SubscriptionSummary(entitlement: proEntitlement, managementURL: customerInfo?.managementURL)
    }

    var managementURL: URL? { customerInfo?.managementURL }

    /// RevenueCat's view of who is signed in. Useful in support tickets and debug screens.
    var appUserID: String? { customerInfo?.originalAppUserId }

    // MARK: - Offerings

    /// Prefer the offering the dashboard marks as current — that is the switch that lets
    /// you change pricing or run an experiment without an app release.
    var currentOffering: Offering? {
        guard let offerings else { return nil }
        return offerings.current ?? offerings.offering(identifier: RevenueCatConfig.defaultOfferingID)
    }

    var availablePackages: [Package] {
        currentOffering?.availablePackages ?? []
    }

    /// Package helpers resolve by package type first (what the dashboard sets), then fall
    /// back to the raw product identifier so a hand-built offering still works.
    var annualPackage: Package? {
        currentOffering?.annual ?? package(forProductID: RevenueCatConfig.ProductID.yearly)
    }

    var monthlyPackage: Package? {
        currentOffering?.monthly ?? package(forProductID: RevenueCatConfig.ProductID.monthly)
    }

    func package(forProductID productID: String) -> Package? {
        availablePackages.first { $0.storeProduct.productIdentifier == productID }
    }

    // MARK: - Lifecycle

    /// Configure the SDK exactly once, as early in the launch as possible so the
    /// entitlement is known before the first screen renders.
    ///
    /// - Parameter appUserID: your own stable user identifier, or `nil` to let RevenueCat
    ///   mint an anonymous ID that you later merge with `identify(userID:)`.
    func configure(appUserID: String? = nil) {
        guard !Purchases.isConfigured else {
            if let appUserID {
                Task { await identify(userID: appUserID) }
            }
            return
        }

        // Never call `Purchases.configure` when it would crash the process. A committed Test
        // Store key crashes on launch in any Release build (the SDK's own release safeguard),
        // so a build with no production key runs with billing unavailable rather than not
        // starting at all. Every call site already guards on `Purchases.isConfigured`, so the
        // rest of the app degrades cleanly: `isPro` is false and purchase/restore report
        // "not configured".
        guard RevenueCatConfig.isConfigurable else { return }

        Purchases.logLevel = RevenueCatConfig.logLevel
        Purchases.configure(
            with: Configuration.Builder(withAPIKey: RevenueCatConfig.apiKey)
                .with(appUserID: appUserID)
                .build()
        )

        observeCustomerInfo()
        Task { await refresh() }
    }

    /// Keeps `customerInfo` current for the life of the process. This is the modern
    /// replacement for `PurchasesDelegate.purchases(_:receivedUpdated:)`.
    private func observeCustomerInfo() {
        customerInfoTask?.cancel()
        customerInfoTask = Task { [weak self] in
            for await info in Purchases.shared.customerInfoStream {
                guard !Task.isCancelled else { return }
                self?.customerInfo = info
            }
        }
    }

    func refresh() async {
        await refreshCustomerInfo()
        await loadOfferings()
    }

    func refreshCustomerInfo() async {
        guard Purchases.isConfigured else { return }
        do {
            customerInfo = try await Purchases.shared.customerInfo()
        } catch {
            report(error)
        }
    }

    /// Offerings are cached by the SDK, so this is cheap to call on appear.
    /// Pass `force: true` after a config change in the dashboard.
    func loadOfferings(force: Bool = false) async {
        guard Purchases.isConfigured else { return }
        guard force || offerings == nil else { return }

        isLoadingOfferings = true
        defer { isLoadingOfferings = false }

        do {
            offerings = try await Purchases.shared.offerings()
        } catch {
            report(error)
        }
    }

    // MARK: - Purchases

    /// - Returns: `true` when the purchase went through *and* unlocked Pro.
    ///   A user-cancelled purchase returns `false` without surfacing an error.
    @discardableResult
    func purchase(_ package: Package) async -> Bool {
        guard Purchases.isConfigured else {
            errorMessage = SubscriptionError.notConfigured.errorDescription
            return false
        }
        guard !isPurchasing else { return false }

        isPurchasing = true
        errorMessage = nil
        defer { isPurchasing = false }

        do {
            let result = try await Purchases.shared.purchase(package: package)
            guard !result.userCancelled else { return false }
            customerInfo = result.customerInfo
            return isPro
        } catch {
            report(error)
            return false
        }
    }

    /// Restores entitlements for the signed-in Apple ID. Required by App Review whenever
    /// the app sells a subscription — the RevenueCat paywall and Customer Center both
    /// expose it, and this method backs any button you add yourself.
    @discardableResult
    func restorePurchases() async -> Bool {
        guard Purchases.isConfigured else {
            errorMessage = SubscriptionError.notConfigured.errorDescription
            return false
        }
        guard !isRestoring else { return false }

        isRestoring = true
        errorMessage = nil
        defer { isRestoring = false }

        do {
            customerInfo = try await Purchases.shared.restorePurchases()
            if !isPro {
                errorMessage = SubscriptionError.nothingToRestore.errorDescription
            }
            return isPro
        } catch {
            report(error)
            return false
        }
    }

    // MARK: - Identity

    /// Convenience the sign-in path calls with the numeric GitHub id. The Worker looks
    /// entitlements up by that same id, so this is what keeps the two sides in agreement.
    func identify(_ githubID: String) async {
        await identify(userID: githubID)
    }

    /// Ties RevenueCat's app user ID to your own account ID so an entitlement follows the
    /// person across devices and reinstalls. Safe to call on every sign-in.
    func identify(userID: String) async {
        guard Purchases.isConfigured, !userID.isEmpty else { return }
        guard Purchases.shared.appUserID != userID else { return }

        do {
            let (info, _) = try await Purchases.shared.logIn(userID)
            customerInfo = info
            await loadOfferings(force: true)
        } catch {
            report(error)
        }
    }

    /// Drops back to an anonymous app user ID. Call on sign-out so the next person on the
    /// device does not inherit the previous account's entitlement.
    func signOut() async {
        guard Purchases.isConfigured, !Purchases.shared.isAnonymous else { return }
        do {
            customerInfo = try await Purchases.shared.logOut()
        } catch {
            report(error)
        }
    }

    // MARK: - Callbacks from the RevenueCat UI

    /// The paywall and Customer Center hand back fresh `CustomerInfo`; adopting it right
    /// away avoids a frame of stale "Free" state before the stream catches up.
    func apply(_ info: CustomerInfo) {
        customerInfo = info
    }

    // MARK: - Errors

    /// Maps `RevenueCat.ErrorCode` onto copy a user can act on, and swallows the codes that
    /// are not failures (cancellation, an already-owned product).
    func report(_ error: Error) {
        guard let message = Self.message(for: error) else { return }
        errorMessage = message
    }

    func clearError() {
        errorMessage = nil
    }

    static func message(for error: Error) -> String? {
        guard let code = error as? ErrorCode else { return error.localizedDescription }

        switch code {
        case .purchaseCancelledError:
            return nil
        case .productAlreadyPurchasedError:
            return nil
        case .networkError, .offlineConnectionError:
            return String(localized: "Can't reach the App Store right now. Check your connection and try again.")
        case .storeProblemError:
            return String(localized: "The App Store is having trouble. Try again in a moment.")
        case .paymentPendingError:
            return String(localized: "Your purchase is pending approval. Pro unlocks as soon as it clears.")
        case .purchaseNotAllowedError:
            return String(localized: "This device isn't allowed to make purchases. Check Screen Time restrictions.")
        case .purchaseInvalidError:
            return String(localized: "The App Store rejected that payment method. Try another one.")
        case .productNotAvailableForPurchaseError:
            return String(localized: "That plan isn't available on this account right now.")
        case .receiptAlreadyInUseError:
            return String(localized: "Those purchases are attached to a different account. Sign in with the Apple ID that bought them.")
        case .ineligibleError:
            return String(localized: "This account isn't eligible for that offer.")
        case .configurationError, .invalidAppUserIdError, .invalidCredentialsError, .invalidAppleSubscriptionKeyError:
            return String(localized: "Subscriptions aren't configured correctly for this build. Check the RevenueCat API key, entitlement, and products.")
        case .unsupportedError:
            return String(localized: "Subscriptions aren't supported on this device.")
        default:
            return error.localizedDescription
        }
    }
}

// MARK: - Status

/// Flattened `EntitlementInfo` for the status UI.
struct SubscriptionSummary {
    let productIdentifier: String
    let planName: String
    let expirationDate: Date?
    let willRenew: Bool
    let isTrial: Bool
    let isSandbox: Bool
    let store: Store
    let hasBillingIssue: Bool
    let cancellationDetected: Bool
    let managementURL: URL?

    init(entitlement: EntitlementInfo, managementURL: URL?) {
        productIdentifier = entitlement.productIdentifier
        planName = RevenueCatConfig.planName(forProductID: entitlement.productIdentifier)
        expirationDate = entitlement.expirationDate
        willRenew = entitlement.willRenew
        isTrial = entitlement.periodType == .trial
        isSandbox = entitlement.isSandbox
        store = entitlement.store
        hasBillingIssue = entitlement.billingIssueDetectedAt != nil
        cancellationDetected = entitlement.unsubscribeDetectedAt != nil
        self.managementURL = managementURL
    }

    /// Medium date for the renewal line. Kept here rather than in the shared
    /// `DateFormatting` because it is the only place the app formats an absolute date.
    private static let renewalDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    /// Short line for the status row: what happens next, not what happened.
    var renewalDescription: String {
        guard let expirationDate else { return String(localized: "Lifetime access") }

        let date = Self.renewalDateFormatter.string(from: expirationDate)
        if hasBillingIssue {
            return String(localized: "Billing issue — access ends \(date)")
        }
        if isTrial && willRenew {
            return String(localized: "Trial converts \(date)")
        }
        return willRenew ? String(localized: "Renews \(date)") : String(localized: "Ends \(date)")
    }

    var storeDescription: String {
        switch store {
        case .appStore, .macAppStore: String(localized: "App Store")
        case .playStore: String(localized: "Google Play")
        case .stripe: String(localized: "Stripe")
        case .promotional: String(localized: "Granted by honmaruai")
        case .amazon: String(localized: "Amazon Appstore")
        default: String(localized: "Other store")
        }
    }

    /// Subscriptions bought outside the App Store can't be managed by Apple's sheet.
    var isAppleManaged: Bool {
        store == .appStore || store == .macAppStore
    }
}

// MARK: - Errors

enum SubscriptionError: LocalizedError {
    case notConfigured
    case nothingToRestore
    case noPackagesAvailable

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            String(localized: "Subscriptions aren't ready yet. Try again in a moment.")
        case .nothingToRestore:
            String(localized: "No previous purchases found for this Apple ID.")
        case .noPackagesAvailable:
            String(localized: "No plans are available right now. Check the offering in RevenueCat.")
        }
    }
}
