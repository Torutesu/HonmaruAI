import Foundation

// Thread message on a card — the high-frequency rally layer (protocol v1
// `CardMessage`). Replies are synchronous on the server: no AI in this path.
struct CardMessage: Identifiable, Codable, Hashable {
    let id: String
    let cardId: String
    let orgId: String
    let authorUserId: String
    let kind: String
    let text: String
    let createdAt: Date

    var authorName: String {
        MemberNameCache.shared.name(for: authorUserId)
    }
}

// Per-user notification (protocol v1 `Notification`).
struct NotificationItem: Identifiable, Codable, Hashable {
    let id: String
    let orgId: String
    let userId: String
    let kind: String
    let cardId: String?
    let title: String
    let body: String
    var readAt: Date?
    let createdAt: Date

    var isUnread: Bool { readAt == nil }
}
