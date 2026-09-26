import Foundation

/// A workspace's login rules ending this sign-in (docs/admin-controls.md §3).
///
/// The Worker answers `401 {code: "session-policy"}` to a request, or refuses
/// the socket with the same code, when the workspace's rules have outgrown
/// this session. Whoever sees it says so here; RootView signs out and tells
/// the person why.
enum SessionPolicy {
    /// Whether a 401 body is the workspace's rules, and if so, announce it.
    @discardableResult
    static func noticeIfEnded(status: Int, data: Data) -> Bool {
        guard status == 401,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["code"] as? String == "session-policy" else { return false }
        announce()
        return true
    }

    static func announce() {
        DispatchQueue.main.async { NotificationCenter.default.post(name: .sessionPolicyEnded, object: nil) }
    }
}

extension Notification.Name {
    static let sessionPolicyEnded = Notification.Name("honmaru.session.policy-ended")
}
