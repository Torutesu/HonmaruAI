import Foundation

/// Resolves a user id to a human display name. For real users the id is the
/// GitHub login, which is already a fine name; when an org graph is available
/// we prefer the person node's label (the text before " · <role>").
enum DisplayName {
    static func of(_ userID: String, in organization: OrganizationGraph? = nil) -> String {
        if let node = organization?.nodes.first(where: { $0.id == userID && $0.kind == .person }) {
            return node.label.split(separator: "·").first
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? userID
        }
        return userID
    }
}
