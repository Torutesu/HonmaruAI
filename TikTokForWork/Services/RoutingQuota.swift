import Foundation

/// Free-tier meter for AI routing: a free account gets `RevenueCatConfig.freeDailyRoutes`
/// routed decisions per day, `honmaruai Pro` gets unlimited.
///
/// The counter keeps running for Pro accounts too — it is never consumed, so a lapsed
/// subscription simply falls back to the free allowance without any extra bookkeeping.
/// Counts live in `UserDefaults` on purpose: this is a soft product limit, not a security
/// boundary. Anything worth protecting belongs behind the server, checked against
/// RevenueCat's `/subscribers` API or a webhook-fed database.
@MainActor
final class RoutingQuota: ObservableObject {
    @Published private(set) var usedToday = 0

    private let defaults: UserDefaults
    private let limit: Int
    private var userID: String?

    init(defaults: UserDefaults = .standard, limit: Int = RevenueCatConfig.freeDailyRoutes) {
        self.defaults = defaults
        self.limit = limit
    }

    var remaining: Int { max(0, limit - usedToday) }

    var dailyLimit: Int { limit }

    func canRoute(isPro: Bool) -> Bool {
        isPro || remaining > 0
    }

    func bind(userID: String) {
        self.userID = userID
        usedToday = defaults.integer(forKey: key(for: userID))
    }

    func consume(isPro: Bool) {
        guard !isPro, let userID else { return }
        usedToday += 1
        defaults.set(usedToday, forKey: key(for: userID))
    }

    func reset() {
        userID = nil
        usedToday = 0
    }

    /// Keyed by day so the allowance rolls over at local midnight with no cleanup job.
    private func key(for userID: String) -> String {
        let day = Int(Calendar.current.startOfDay(for: .now).timeIntervalSince1970)
        return "routingQuota.\(userID).\(day)"
    }
}
