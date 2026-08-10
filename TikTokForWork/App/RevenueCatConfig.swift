import Foundation
import RevenueCat

/// Every RevenueCat identifier the app depends on, in one place.
///
/// The strings here must match the RevenueCat dashboard exactly — the SDK looks
/// entitlements and products up by identifier, so a typo shows up as "never subscribed".
enum RevenueCatConfig {
    /// Public SDK key (RevenueCat → Project settings → API keys).
    ///
    /// A `test_…` key targets the RevenueCat Test Store, which serves products without any
    /// App Store Connect setup — useful on the simulator and in CI. Swap in the `appl_…`
    /// production key before shipping. Public SDK keys are safe to ship in the binary; the
    /// secret key never belongs in the app.
    static let apiKey = "test_aOieMtugDnVbuliAwBJkfQKazZd"

    /// Entitlement that unlocks the paid tier (RevenueCat → Entitlements).
    static let proEntitlementID = "honmaruai Pro"

    /// Fallback offering used when no offering is marked "current" in the dashboard.
    static let defaultOfferingID = "default"

    /// Store product identifiers attached to the offering's packages.
    enum ProductID {
        static let yearly = "yearly"
        static let monthly = "monthly"
    }

    /// AI routes a free account gets per day before the paywall appears.
    static let freeDailyRoutes = 3

    static var logLevel: LogLevel {
        #if DEBUG
        return .debug
        #else
        return .warn
        #endif
    }

    /// Human label for a product identifier, used when the dashboard has no display title
    /// (Test Store products, or an offering that hasn't been filled in yet).
    static func planName(forProductID productID: String) -> String {
        switch productID {
        case ProductID.yearly: String(localized: "Yearly")
        case ProductID.monthly: String(localized: "Monthly")
        default: productID
        }
    }
}
