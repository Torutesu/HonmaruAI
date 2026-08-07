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

// Classic chat: org-wide channel or 1:1 DM (protocol v1 `Channel`).
struct ChatChannel: Identifiable, Codable, Hashable {
    let id: String
    let orgId: String
    let kind: String // "channel" | "dm"
    let name: String
    let memberUserIds: [String]
    let createdAt: Date

    var isDM: Bool { kind == "dm" }

    func displayName(selfID: String) -> String {
        if isDM {
            let other = memberUserIds.first { $0 != selfID } ?? ""
            return MemberNameCache.shared.name(for: other)
        }
        return "#\(name)"
    }

    func otherMemberID(selfID: String) -> String? {
        isDM ? memberUserIds.first { $0 != selfID } : nil
    }
}

// A chat message; `parentMessageId` marks a Slack-style thread reply.
struct ChatMessage: Identifiable, Codable, Hashable {
    let id: String
    let orgId: String
    let channelId: String
    let authorUserId: String
    let text: String
    let parentMessageId: String?
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
