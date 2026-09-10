import Foundation

/// Resolves a user id to a human display name. For a GitHub user the id is the
/// login, which is already a fine name; when an org graph is available we
/// prefer the person node's label (the text before " · <role>").
///
/// An email account's id is neither. It is `u:someone@company.com` on the
/// relay and `email:someone@company.com` as the account id, so falling back to
/// the id put a colleague's whole address on a card, in the routing line under
/// it, and in history — the web client has stripped exactly this since the
/// feed was built, and its end-to-end suite refuses a card that shows one.
enum DisplayName {
    static func of(_ userID: String, in organization: OrganizationGraph? = nil) -> String {
        if let node = organization?.nodes.first(where: { $0.id == userID && $0.kind == .person }) {
            return node.label.split(separator: "·").first
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? short(userID)
        }
        return short(userID)
    }

    /// The name inside an id: no prefix, and no domain.
    ///
    /// Deliberately the same rule as `displayName()` in the web client, so the
    /// two never disagree about what a person is called.
    static func short(_ userID: String) -> String {
        var name = userID
        for prefix in ["u:", "email:"] where name.hasPrefix(prefix) {
            name = String(name.dropFirst(prefix.count))
        }
        if let at = name.firstIndex(of: "@") {
            name = String(name[name.startIndex..<at])
        }
        return name.isEmpty ? userID : name
    }
}
